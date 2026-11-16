import { once } from 'node:events';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import {
  HOSTED_PREVIEW_NAVIGATION_PARAM,
  HOSTED_PREVIEW_NAVIGATION_PATTERN,
  HOSTED_PREVIEW_VERIFY_RETRY_PATH,
} from '@open-design/contracts';

export const PREVIEW_READ_BUDGET = 50 * 1024 * 1024;

interface PreviewRequestRecord {
  route: 'entry' | 'verify' | 'scoped-redirect' | 'document' | 'asset' | 'other';
  state: 'pending' | 'completed' | 'interrupted';
  status: number | null;
  sameOrigin: boolean;
  sameScope?: boolean;
  boundNavigation?: boolean;
}

export async function mountHostedPreviewFixture(webURL: string, dataDir: string) {
  const daemonRoot = new URL('../../../apps/daemon/', import.meta.url);
  const [{ createHostedPreviewRoutes, HostedPreviewBusy }, { SubrouterPlatform, platformSessionMiddleware }] =
    await Promise.all([
      import(new URL('dist/http/hosted-preview.js', daemonRoot).href),
      import(new URL('dist/platform/subrouter.js', daemonRoot).href),
    ]);
  const express = createRequire(new URL('package.json', daemonRoot))('express');
  const scratch = await mkdtemp(join(dataDir, 'preview-retry-'));
  const platform = new SubrouterPlatform(scratch, { OD_PLATFORM_ENABLED: '1' });
  const owner = 'preview-owner';
  const now = Date.now();
  platform.db.prepare('INSERT INTO platform_users (id, username, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(owner, owner, now, now);
  const token: string = platform.createSession(owner);

  const app = express();
  const requests: PreviewRequestRecord[] = [];
  const project = 'retry-fixture';
  const file = 'nested/index.html';
  const entryPath = `/api/projects/${project}/preview-files/${file}`;
  const html = '<!doctype html><p>Recovered preview</p>';
  const htmlFile = join(scratch, 'index.html');
  const mediaFile = join(scratch, 'video.mp4');
  let origin = '';
  let scope = '';
  let filled = false;

  const preview = createHostedPreviewRoutes({
    currentSession(req: IncomingMessage) {
      if (req.headers.cookie && !platform.currentUser(req)) platform.attachSession(req);
      return platform.previewSession(req);
    },
    isActive: (sessionId: string, ownerId: string) => platform.isPreviewSessionActive(sessionId, ownerId),
  });
  const readRange = (start: number, end: number) =>
    fetch(`${origin}/api/hosted-preview/${scope}/nested/video.mp4`, {
      headers: { 'Sec-Fetch-Dest': 'video', Range: `bytes=${start}-${end}` },
    });

  app.use((req: IncomingMessage & { originalUrl: string }, res: ServerResponse, next: () => void) => {
    const url = new URL(req.originalUrl, webURL);
    if (url.pathname === entryPath || url.pathname.startsWith('/api/hosted-preview/')) return next();
    // Serve the real tools-dev web app on the same origin as the preview routes.
    // Proxy bytes directly so dev chunks retain their encoding and redirects.
    const upstreamURL = new URL(webURL);
    upstreamURL.pathname = url.pathname;
    upstreamURL.search = url.search;
    const upstream = request(upstreamURL, {
      method: req.method,
      headers: req.headers,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  app.use('/api', (req: IncomingMessage & { originalUrl: string }, res: ServerResponse, next: () => void) => {
    const url = new URL(req.originalUrl, origin);
    const scoped = /^\/api\/hosted-preview\/([A-Za-z0-9_-]{32})\/(.*)$/u.exec(url.pathname);
    let route: PreviewRequestRecord['route'] = 'other';
    if (url.pathname === entryPath) route = 'entry';
    else if (url.pathname === HOSTED_PREVIEW_VERIFY_RETRY_PATH) route = 'verify';
    else if (scoped?.[2] === '') route = 'scoped-redirect';
    else if (scoped?.[2] === file) route = 'document';
    else if (scoped?.[2] === 'nested/video.mp4') route = 'asset';
    const record: PreviewRequestRecord = { route, state: 'pending', status: null, sameOrigin: req.headers.origin === origin };
    if (scoped && scope) record.sameScope = scoped[1] === scope;
    if (route === 'entry') {
      const navigation = url.searchParams.get(HOSTED_PREVIEW_NAVIGATION_PARAM);
      record.boundNavigation = HOSTED_PREVIEW_NAVIGATION_PATTERN.test(navigation ?? '');
    }
    // Keep route labels and outcomes only. Preview URLs carry authorization.
    requests.push(record);
    res.once('finish', () => {
      record.state = 'completed';
      record.status = res.statusCode;
      if (scoped) record.sameScope = scoped[1] === scope;
    });
    res.once('close', () => {
      if (record.state === 'pending') record.state = 'interrupted';
    });
    next();
  });
  app.use(express.json());
  preview.registerAssets(app);
  app.use('/api', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.method === 'POST' && req.headers.origin !== origin) {
      res.writeHead(403).end();
      return;
    }
    next();
  });
  app.use('/api', platformSessionMiddleware(platform));
  app.get(entryPath, (req: IncomingMessage, res: ServerResponse) =>
    preview.redirect(req, res, file, async (name: string) => {
      if (name === file) return { filePath: htmlFile, mime: 'text/html', size: Buffer.byteLength(html) };
      if (name === 'nested/video.mp4') return { filePath: mediaFile, mime: 'video/mp4', size: PREVIEW_READ_BUDGET + 1 };
      return null;
    }, async (frameReq: { params: Record<string, string> }, bytes: Buffer) => {
      if (filled) return bytes;
      scope = frameReq.params[0]!;
      const chunk = 5 * 1024 * 1024;
      for (let start = 0; start < PREVIEW_READ_BUDGET; start += chunk) {
        const response = await readRange(start, start + chunk - 1);
        if (response.status !== 206 || (await response.arrayBuffer()).byteLength !== chunk) {
          throw new Error('Could not fill the preview read budget');
        }
      }
      filled = true;
      throw new HostedPreviewBusy();
    }));
  preview.registerDocuments(app);
  await writeFile(htmlFile, html);
  await writeFile(mediaFile, '');
  await truncate(mediaFile, PREVIEW_READ_BUDGET + 1);
  const server = app.listen(0, '127.0.0.1');
  const upgraded = new Set<Socket>();
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const target = new URL(webURL);
    const url = new URL(req.url ?? '/', webURL);
    if (url.pathname !== '/_next/webpack-hmr') {
      socket.destroy();
      return;
    }
    target.pathname = url.pathname;
    target.search = url.search;
    const upstream = request(target, { headers: req.headers });
    upgraded.add(socket);
    socket.once('close', () => {
      upgraded.delete(socket);
      upstream.destroy();
    });
    upstream.on('upgrade', (response, connection, firstChunk) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders
        .reduce<string[]>((headers, value, index, raw) => {
          if (index % 2 === 0) headers.push(`${value}: ${raw[index + 1]}`);
          return headers;
        }, []).join('\r\n')}\r\n\r\n`);
      if (firstChunk.length) socket.write(firstChunk);
      if (head.length) connection.write(head);
      connection.pipe(socket).pipe(connection);
      connection.once('error', () => socket.destroy());
      socket.once('error', () => connection.destroy());
      socket.once('close', () => connection.destroy());
    });
    upstream.on('response', (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  async function close() {
    for (const socket of upgraded) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
    platform.db.close();
    await rm(scratch, { recursive: true, force: true });
  }
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    origin = `http://127.0.0.1:${address.port}`;
    return {
      close, file, origin, project, readRange, requests,
      session: { name: 'od_platform_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' as const },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
