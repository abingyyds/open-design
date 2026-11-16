import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';
import {
  HOSTED_PREVIEW_NAVIGATION_PARAM,
  HOSTED_PREVIEW_NAVIGATION_PATTERN,
  HOSTED_PREVIEW_RENEW_MESSAGE,
  HOSTED_PREVIEW_RETRY_MESSAGE,
  HOSTED_PREVIEW_SCOPE_PATTERN,
  HOSTED_PREVIEW_VERIFY_RETRY_PATH,
  type HostedPreviewRenewRequest,
  type HostedPreviewVerifyRetryRequest,
  type HostedPreviewVerifyRetryResponse,
} from '@open-design/contracts';
import { MAX_INLINE_ASSET_BYTES, MAX_INLINE_CANDIDATES, MAX_INLINE_OWNER_BYTES, MAX_INLINE_TOTAL_BYTES } from '../inline-assets.js';
import { parseByteRange } from '../projects.js';
import { setHostedDownloadHeaders, setHostedPreviewHeaders } from './hosted-file-response.js';

const pathPattern = /^\/api\/hosted-preview\/([A-Za-z0-9_-]{32})\/(.+)$/u;
const renewalPath = /^\/api\/hosted-preview\/([A-Za-z0-9_-]{32})\/renew$/u;
const retryPath = /^\/api\/hosted-preview\/([A-Za-z0-9_-]{32})\/$/u;
const scopeLifetimeMs = 10 * 60 * 1000;
const navigationIssueWindowMs = 10 * 60_000;
const navigationClockSkewMs = 60_000;
const maxScopes = 512;
const maxNavigationClaims = 16 * maxScopes;
const maxScopesPerOwner = 32;
const maxOwnerReads = 8;
const maxProcessReads = 32;
const maxOwnerReadBytes = MAX_INLINE_TOTAL_BYTES;
const maxProcessReadBytes = 2 * maxOwnerReadBytes;

export interface HostedPreviewFile {
  filePath: string;
  mime: string;
  size: number;
}

type ResolveFile = (path: string) => Promise<HostedPreviewFile | null>;
type RenderDocument = (req: Request, bytes: Buffer, path: string) => string | Buffer | Promise<string | Buffer>;

export class HostedPreviewReadLimit extends Error {}
export class HostedPreviewBusy extends Error {}

function hostedPreviewRenewalScript(scope: string): string {
  if (!HOSTED_PREVIEW_SCOPE_PATTERN.test(scope)) return '';
  return `<script>(function(){
    if (parent === window) return;
    function renew() {
      if (!document.hidden) parent.postMessage({type:${JSON.stringify(HOSTED_PREVIEW_RENEW_MESSAGE)},scope:${JSON.stringify(scope)}}, '*');
    }
    setInterval(renew, 180000);
    document.addEventListener('visibilitychange', renew);
  })();</script>`;
}

function sendBusyPreviewDocument(res: Response, receipt?: string) {
  setHostedPreviewHeaders(res);
  res.set({ 'Retry-After': '1', 'Referrer-Policy': 'no-referrer' });
  return res.status(429).type('html').send(`<!doctype html><meta charset="utf-8">
<title>Preview busy</title><p>Preview is busy. Try again shortly.</p>${receipt ? `<button type="button">Retry</button>
<script>
  const requestRetry = (manual) => {
    if (parent !== window) parent.postMessage({
      type: ${JSON.stringify(HOSTED_PREVIEW_RETRY_MESSAGE)}, receipt: ${JSON.stringify(receipt)}, manual
    }, '*');
  };
  document.querySelector('button').addEventListener('click', () => requestRetry(true));
  requestRetry(false);
</script>` : ''}`);
}

function previewDocumentUrl(token: string, entry: string): string {
  const pathname = entry.split('/').map(encodeURIComponent).join('/');
  return `/api/hosted-preview/${token}/${pathname}`;
}

function navigationFor(entry: string | undefined) {
  if (!entry) return undefined;
  const query = entry.indexOf('?');
  if (query < 0) return undefined;
  const [navigation, duplicate] = new URLSearchParams(entry.slice(query + 1))
    .getAll(HOSTED_PREVIEW_NAVIGATION_PARAM);
  if (navigation === undefined) return undefined;
  const match = duplicate === undefined && HOSTED_PREVIEW_NAVIGATION_PATTERN.exec(navigation);
  if (!match) return null;
  const createdAt = Number(match[1]);
  return { id: navigation, createdAt, deadline: createdAt + navigationIssueWindowMs };
}

const navigationKey = (sessionId: string, id: string) => `${sessionId}:${id}`;

export async function readHostedPreviewFile(file: HostedPreviewFile, limit: number): Promise<Buffer> {
  if (file.size > limit) throw new HostedPreviewReadLimit();
  const handle = await open(file.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > file.size) throw new HostedPreviewReadLimit();
    // Read at most the reserved size plus one byte, even if the file grows.
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > info.size) throw new HostedPreviewReadLimit();
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function mediaType(mime: string): string {
  return mime.split(';', 1)[0]!.toLowerCase();
}

function isPreviewAsset(dest: string, mime: string): boolean {
  const type = mediaType(mime);
  switch (dest) {
    case 'style': return type === 'text/css';
    case 'script': return type === 'text/javascript' || type === 'application/javascript';
    case 'font': return type.startsWith('font/');
    case 'image': return type.startsWith('image/');
    case 'audio': return type.startsWith('audio/');
    case 'video': return type.startsWith('video/');
    default: return false;
  }
}

function assetDestination(req: Request): string {
  const dest = req.get('Sec-Fetch-Dest') ?? '';
  return ['style', 'script', 'font', 'image', 'audio', 'video'].includes(dest) ? dest : '';
}

interface PreviewScope {
  ownerId: string;
  sessionId: string;
  entry: string;
  retryEntry: string | undefined;
  resolve: ResolveFile;
  render: RenderDocument | undefined;
  expiresAt: number;
  assetRequests: number;
  assetBytes: number;
}

interface HostedPreviewSessions {
  currentSession(req: Request): { ownerId: string; sessionId: string } | undefined;
  isActive(sessionId: string, ownerId: string): boolean;
}

interface FramedPreviewBinding {
  sessionId: string;
  ownerId: string;
  entry: string;
  expiresAt: number;
}

interface BusyReceipt extends FramedPreviewBinding {
  scope: string | null;
}

interface RetiredFrame extends FramedPreviewBinding {
  recoverable: boolean;
}

export function createHostedPreviewRoutes(sessions: HostedPreviewSessions) {
  const scopes = new Map<string, PreviewScope>();
  const busyReceipts = new Map<string, BusyReceipt>();
  const retiredFrames = new Map<string, RetiredFrame>();
  const navigationClaims = new Map<string, number>();
  const ownerReads = new Map<string, { count: number; bytes: number }>();
  let processReads = 0;
  let processBytes = 0;

  function remember<T extends { expiresAt: number }>(records: Map<string, T>, key: string, value: T) {
    const now = Date.now();
    for (const [id, record] of records) {
      if (record.expiresAt <= now) records.delete(id);
    }
    if (records.size >= maxScopes) records.delete(records.keys().next().value!);
    records.set(key, value);
  }

  function matchesBinding(req: Request, binding: FramedPreviewBinding, entry: unknown): boolean {
    const caller = sessions.currentSession(req);
    return caller?.sessionId === binding.sessionId && caller.ownerId === binding.ownerId
      && binding.expiresAt > Date.now() && entry === binding.entry
      && sessions.isActive(binding.sessionId, binding.ownerId);
  }

  function retire(token: string, scope: PreviewScope, now: number) {
    if (scope.retryEntry && navigationFor(scope.retryEntry)) remember(retiredFrames, token, {
      sessionId: scope.sessionId, ownerId: scope.ownerId, entry: scope.retryEntry,
      expiresAt: now + scopeLifetimeMs, recoverable: scope.expiresAt <= now,
    });
    scopes.delete(token);
  }

  function busy(req: Request, res: Response, entry: string | undefined, scope: string | null) {
    const caller = sessions.currentSession(req);
    const navigation = navigationFor(entry);
    if (!entry || !navigation || !caller || !sessions.isActive(caller.sessionId, caller.ownerId)) {
      return sendBusyPreviewDocument(res);
    }
    const now = Date.now();
    const expiresAt = scope === null ? navigation.deadline : now + scopeLifetimeMs;
    if (expiresAt <= now) return sendBusyPreviewDocument(res);
    const receipt = randomBytes(24).toString('base64url');
    remember(busyReceipts, receipt, {
      ...caller, entry, scope, expiresAt,
    });
    return sendBusyPreviewDocument(res, receipt);
  }

  async function withReadBudget<T>(ownerId: string, bytes: number, read: () => Promise<T>): Promise<T> {
    const owner = ownerReads.get(ownerId) ?? { count: 0, bytes: 0 };
    if (owner.count >= maxOwnerReads || processReads >= maxProcessReads
      || owner.bytes + bytes > maxOwnerReadBytes || processBytes + bytes > maxProcessReadBytes) {
      throw new HostedPreviewBusy();
    }
    ownerReads.set(ownerId, owner);
    owner.count++;
    owner.bytes += bytes;
    processReads++;
    processBytes += bytes;
    try {
      return await read();
    } finally {
      owner.count--;
      owner.bytes -= bytes;
      if (owner.count === 0) ownerReads.delete(ownerId);
      processReads--;
      processBytes -= bytes;
    }
  }

  async function readSource(req: Request, file: HostedPreviewFile, limit: number): Promise<Buffer | null> {
    const session = sessions.currentSession(req);
    if (!session || !sessions.isActive(session.sessionId, session.ownerId)) return null;
    if (file.size > limit) throw new HostedPreviewReadLimit();
    return withReadBudget(session.ownerId, file.size + 1, () => readHostedPreviewFile(file, limit));
  }

  function scopeFor(req: Request): PreviewScope | undefined {
    const token = req.params[0];
    const scope = typeof token === 'string' ? scopes.get(token) : undefined;
    if (!scope || scope.expiresAt <= Date.now() || !sessions.isActive(scope.sessionId, scope.ownerId)) return undefined;
    return scope;
  }

  function registerAssets(app: Express) {
    // Opaque previews cannot send the app session on resource requests.
    // The scoped URL only grants typed, read-only subresources from one source.
    app.get(pathPattern, async (req, res, next) => {
      const dest = assetDestination(req);
      if (!dest || req.method !== 'GET') return next();
      const scope = scopeFor(req);
      const caller = sessions.currentSession(req);
      if (!scope || (caller && caller.sessionId !== scope.sessionId)
        || (req.headers.origin && req.headers.origin !== 'null')) return res.sendStatus(404);
      if (scope.assetRequests >= MAX_INLINE_CANDIDATES) return res.sendStatus(413);
      scope.assetRequests++;
      try {
        const file = await scope.resolve(String(req.params[1] ?? ''));
        if (!file || !isPreviewAsset(dest, file.mime)) return res.sendStatus(404);
        const streaming = dest === 'audio' || dest === 'video';
        const range = streaming ? parseByteRange(req.get('Range'), file.size) : null;
        if (range === 'unsatisfiable') {
          res.setHeader('Content-Range', `bytes */${file.size}`);
          return res.sendStatus(416);
        }
        const start = range?.start ?? 0;
        const end = range ? Math.min(range.end, start + MAX_INLINE_ASSET_BYTES - 1) : file.size - 1;
        const size = end - start + 1;
        if ((!streaming && size > MAX_INLINE_ASSET_BYTES) || scope.assetBytes + size > MAX_INLINE_TOTAL_BYTES) {
          return res.sendStatus(413);
        }
        if (!sessions.isActive(scope.sessionId, scope.ownerId) || scope.expiresAt <= Date.now()) return res.sendStatus(404);
        return await withReadBudget(scope.ownerId, size + (streaming ? 0 : 1), async () => {
          scope.assetBytes += size;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Referrer-Policy', 'no-referrer');
          setHostedDownloadHeaders(res, file.mime);
          if (streaming) return await streamMedia(res, file, start, end, Boolean(range));
          const bytes = await readHostedPreviewFile(file, MAX_INLINE_ASSET_BYTES);
          return res.type(file.mime).send(bytes);
        });
      } catch (error) {
        if (res.headersSent || res.destroyed) return;
        return res.sendStatus(error instanceof HostedPreviewReadLimit ? 413 : error instanceof HostedPreviewBusy ? 429 : 404);
      }
    });
  }

  function registerDocuments(app: Express) {
    app.post(HOSTED_PREVIEW_VERIFY_RETRY_PATH, (req, res) => {
      const { receipt, entry } = (req.body ?? {}) as Partial<HostedPreviewVerifyRetryRequest>;
      if (typeof receipt !== 'string' || !HOSTED_PREVIEW_SCOPE_PATTERN.test(receipt)) return res.sendStatus(404);
      const binding = busyReceipts.get(receipt);
      if (!binding || !matchesBinding(req, binding, entry)) return res.sendStatus(404);
      if (binding.scope !== null) {
        const scope = scopes.get(binding.scope);
        if (!scope?.retryEntry || scope.expiresAt <= Date.now() || scope.sessionId !== binding.sessionId
          || scope.ownerId !== binding.ownerId || scope.retryEntry !== binding.entry) return res.sendStatus(404);
      } else {
        const navigation = navigationFor(binding.entry);
        if (!navigation || navigationClaims.has(navigationKey(binding.sessionId, navigation.id))) {
          return res.sendStatus(404);
        }
      }
      busyReceipts.delete(receipt);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ scope: binding.scope } satisfies HostedPreviewVerifyRetryResponse);
    });

    app.get(retryPath, (req, res) => {
      const scope = scopeFor(req);
      if (!scope?.retryEntry || sessions.currentSession(req)?.sessionId !== scope.sessionId) return res.sendStatus(404);
      const queryIndex = scope.retryEntry.indexOf('?');
      if (req.query.entry !== scope.retryEntry) return res.sendStatus(404);
      const query = queryIndex < 0 ? '' : scope.retryEntry.slice(queryIndex);
      res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
      return res.redirect(302, `${previewDocumentUrl(String(req.params[0]), scope.entry)}${query}`);
    });

    app.post(renewalPath, (req, res) => {
      const token = String(req.params[0] ?? '');
      const { entry } = (req.body ?? {}) as HostedPreviewRenewRequest;
      const scope = scopes.get(token);
      if (!scope) {
        const retired = retiredFrames.get(token);
        if (!retired?.recoverable || !matchesBinding(req, retired, entry)) return res.sendStatus(404);
        retired.recoverable = false;
        return res.sendStatus(410);
      }
      const caller = sessions.currentSession(req);
      if (!caller || caller.sessionId !== scope.sessionId
        || (navigationFor(scope.retryEntry)
          ? entry !== scope.retryEntry
          : entry !== undefined && entry !== scope.retryEntry)
        || !sessions.isActive(scope.sessionId, scope.ownerId)) return res.sendStatus(404);
      scope.expiresAt = Date.now() + scopeLifetimeMs;
      return res.sendStatus(204);
    });

    app.get(pathPattern, async (req, res) => {
      const scope = scopeFor(req);
      const name = String(req.params[1] ?? '');
      if (!scope || sessions.currentSession(req)?.sessionId !== scope.sessionId || scope.entry !== name) return res.sendStatus(404);
      try {
        const file = await scope.resolve(name);
        if (!file || mediaType(file.mime) !== 'text/html') return res.sendStatus(404);
        if (file.size > MAX_INLINE_OWNER_BYTES) return res.sendStatus(413);
        if (!sessions.isActive(scope.sessionId, scope.ownerId) || scope.expiresAt <= Date.now()) return res.sendStatus(404);
        return await withReadBudget(scope.ownerId, file.size + 1, async () => {
          const bytes = await readHostedPreviewFile(file, MAX_INLINE_OWNER_BYTES);
          const html = scope.render ? await scope.render(req, bytes, name) : bytes;
          const renewal = hostedPreviewRenewalScript(String(req.params[0] ?? ''));
          setHostedPreviewHeaders(res);
          res.setHeader('Referrer-Policy', 'no-referrer');
          return res.type(file.mime).send(html.toString().replace(/^\s*<!doctype[^>]*>|^/i, (head) => head + renewal));
        });
      } catch (error) {
        if (error instanceof HostedPreviewBusy) return busy(req, res, scope.retryEntry, String(req.params[0] ?? ''));
        return res.sendStatus(error instanceof HostedPreviewReadLimit ? 413 : 404);
      }
    });
  }

  async function issue(req: Request, entry: string, resolve: ResolveFile, render?: RenderDocument, retryEntry?: string) {
    const session = sessions.currentSession(req);
    if (!session || !sessions.isActive(session.sessionId, session.ownerId)) return { status: 401 as const };
    const { ownerId, sessionId } = session;
    const navigation = navigationFor(retryEntry);
    if (navigation === null) return { status: 400 as const };
    const file = await resolve(entry);
    if (!file || mediaType(file.mime) !== 'text/html') return { status: 404 as const };
    if (file.size > MAX_INLINE_OWNER_BYTES) return { status: 413 as const };
    const now = Date.now();
    const ownerTokens: string[] = [];
    for (const [token, scope] of scopes) {
      if (scope.expiresAt <= now) {
        retire(token, scope, now);
      } else if (scope.ownerId === ownerId) {
        // Repeating the same framed navigation cannot allocate another allowance.
        if (navigation && scope.sessionId === sessionId && scope.retryEntry === retryEntry) {
          return { status: 200 as const, url: previewDocumentUrl(token, scope.entry) };
        }
        ownerTokens.push(token);
      }
    }
    const claimKey = navigation && navigationKey(sessionId, navigation.id);
    if (navigation && claimKey) {
      if (navigation.deadline <= now || navigation.createdAt > now + navigationClockSkewMs
        || navigationClaims.has(claimKey)) return { status: 410 as const };
      if (navigationClaims.size >= maxNavigationClaims) {
        // Preserve claims throughout the issuance window, even under capacity pressure.
        for (const [key, deadline] of navigationClaims) {
          if (deadline <= now) navigationClaims.delete(key);
        }
        if (navigationClaims.size >= maxNavigationClaims) return { status: 429 as const };
      }
    }
    if (ownerTokens.length >= maxScopesPerOwner) {
      const oldest = ownerTokens[0]!;
      retire(oldest, scopes.get(oldest)!, now);
    }
    if (scopes.size >= maxScopes) return { status: 429 as const };
    const token = randomBytes(24).toString('base64url');
    scopes.set(token, {
      ownerId, sessionId, entry, retryEntry, resolve, render, expiresAt: now + scopeLifetimeMs,
      assetRequests: 0, assetBytes: 0,
    });
    if (navigation && claimKey) navigationClaims.set(claimKey, navigation.deadline);
    return { status: 200 as const, url: previewDocumentUrl(token, entry) };
  }

  async function redirect(req: Request, res: Response, entry: string, resolve: ResolveFile, render?: RenderDocument) {
    const issued = await issue(req, entry, resolve, render, req.originalUrl);
    if (issued.status === 429) return busy(req, res, req.originalUrl, null);
    if (issued.status !== 200) return res.sendStatus(issued.status);
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex < 0 ? '' : req.originalUrl.slice(queryIndex);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, `${issued.url}${query}`);
  }

  return { registerAssets, registerDocuments, issue, redirect, readSource };
}

async function streamMedia(res: Response, file: HostedPreviewFile, start: number, end: number, partial: boolean) {
  const handle = await open(file.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== file.size) throw new HostedPreviewReadLimit();
    const size = end - start + 1;
    res.type(file.mime).set({
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range',
    });
    if (partial) res.status(206).set('Content-Range', `bytes ${start}-${end}/${file.size}`);
    if (size === 0) {
      res.end();
      return;
    }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally {
    await handle.close();
  }
}

export type HostedPreviewRoutes = ReturnType<typeof createHostedPreviewRoutes>;
