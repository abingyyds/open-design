import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { HOSTED_PREVIEW_NAVIGATION_PARAM, HOSTED_PREVIEW_VERIFY_RETRY_PATH } from '@open-design/contracts';
import { createHostedPreviewRoutes, HostedPreviewBusy, HostedPreviewReadLimit, readHostedPreviewFile } from '../../src/http/hosted-preview.js';
import { MAX_INLINE_ASSET_BYTES, MAX_INLINE_TOTAL_BYTES } from '../../src/inline-assets.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('hosted preview filesystem read budget', () => {
  it('authorizes recovery for a real pre-issue 429 without returning an existing scope', async () => {
    const path = '/api/projects/fixture/preview-files/index.html';
    const resolve = async () => ({ filePath: 'unused', mime: 'text/html', size: 20 });
    const app = express();
    const preview = createHostedPreviewRoutes({
      currentSession(req) {
        const ownerId = req.headers['x-fixture-owner'];
        return typeof ownerId === 'string' ? { ownerId, sessionId: ownerId } : undefined;
      },
      isActive: () => true,
    });
    app.use(express.json());
    preview.registerDocuments(app);
    app.post('/fixture/scopes', async (req, res) => {
      // The scopes retain metadata only. Filling the registry issues no file reads.
      for (let index = 0; index < 32; index++) {
        const issued = await preview.issue(req, 'index.html', resolve);
        if (issued.status !== 200) return res.sendStatus(issued.status);
      }
      return res.sendStatus(204);
    });
    app.get(path, (req, res) => preview.redirect(req, res, 'index.html', resolve));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
      const base = `http://127.0.0.1:${address.port}`;
      for (let index = 0; index < 16; index++) {
        const seeded = await fetch(base + '/fixture/scopes', {
          method: 'POST', headers: { 'x-fixture-owner': `fixture-${index}` },
        });
        expect(seeded.status).toBe(204);
      }
      const headers = { 'x-fixture-owner': 'waiting-owner', 'Content-Type': 'application/json' };
      const time = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(time + 9 * 60_000);
      try {
        const navigation = (letter: string, createdAt = Date.now()) =>
          `${path}?${HOSTED_PREVIEW_NAVIGATION_PARAM}=${createdAt}.${letter.repeat(32)}`;
        const entry = navigation('a');
        const nearlyExpired = navigation('c', time);
        const getBusyReceipt = async (target = entry) => {
          const response = await fetch(base + target, { headers });
          expect(response.status).toBe(429);
          const receipt = /receipt: "([A-Za-z0-9_-]{32})"/u.exec(await response.text())?.[1];
          expect(receipt).toBeDefined();
          return receipt;
        };
        const verify = (receipt: string | undefined, target = entry) => fetch(base + HOSTED_PREVIEW_VERIFY_RETRY_PATH, {
          method: 'POST', headers, body: JSON.stringify({ receipt, entry: target }),
        });
        const receipt = await getBusyReceipt();
        expect((await verify(receipt, navigation('b'))).status).toBe(404);
        const verified = await verify(receipt);
        expect(verified.status).toBe(200);
        await expect(verified.json()).resolves.toEqual({ scope: null });
        expect((await verify(receipt)).status).toBe(404);

        const pending = await getBusyReceipt();
        const expired = await getBusyReceipt(nearlyExpired);
        clock.mockReturnValue(time + 11 * 60_000);
        expect((await verify(expired, nearlyExpired)).status).toBe(404);
        expect((await fetch(base + nearlyExpired, { headers, redirect: 'manual' })).status).toBe(410);
        const opened = await fetch(base + entry, { headers, redirect: 'manual' });
        expect(opened.status).toBe(302);
        const repeated = await fetch(base + entry, { headers, redirect: 'manual' });
        expect(repeated.headers.get('Location')).toBe(opened.headers.get('Location'));
        expect((await verify(pending)).status).toBe(404);
      } finally {
        clock.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects an oversized metadata result before opening the file', async () => {
    const file = { filePath: path.join(process.env.OD_DATA_DIR!, 'absent.html'), mime: 'text/html', size: 5 };
    await expect(readHostedPreviewFile(file, 4)).rejects.toBeInstanceOf(HostedPreviewReadLimit);
  });

  it('enforces the reservation if a file grew after resolving its metadata', async () => {
    const filePath = path.join(process.env.OD_DATA_DIR!, 'budget.html');
    await writeFile(filePath, '12345');
    const file = { filePath, mime: 'text/html', size: 4 };
    await expect(readHostedPreviewFile(file, 5)).rejects.toBeInstanceOf(HostedPreviewReadLimit);
    await expect(readHostedPreviewFile({ ...file, size: 5 }, 5)).resolves.toEqual(Buffer.from('12345'));
  });

  it('reserves the cumulative asset budget before reading the next asset', async () => {
    const filePath = path.join(process.env.OD_DATA_DIR!, 'theme.css');
    await writeFile(filePath, 'body { color: green; }');
    const app = express();
    const preview = createHostedPreviewRoutes({
      currentSession: () => ({ ownerId: 'fixture-owner', sessionId: 'fixture-session' }),
      isActive: () => true,
    });
    preview.registerAssets(app);
    app.get('/fixture', (req, res) => preview.redirect(req, res, 'index.html', async (name) => {
      if (name === 'index.html') return { filePath, mime: 'text/html', size: 24 };
      if (name !== 'theme.css') return null;
      // A conservative reservation can exceed the bytes on disk.
      return { filePath, mime: 'text/css', size: MAX_INLINE_ASSET_BYTES };
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
      const base = new URL(`http://127.0.0.1:${address.port}`);
      const redirect = await fetch(new URL('/fixture', base), { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      const document = new URL(redirect.headers.get('Location')!, base);
      await redirect.text();
      const fetchStyles = () => fetch(new URL('theme.css', document), { headers: { 'Sec-Fetch-Dest': 'style' } });
      for (let index = 0; index < Math.floor(MAX_INLINE_TOTAL_BYTES / MAX_INLINE_ASSET_BYTES); index++) {
        const response = await fetchStyles();
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('body { color: green; }');
      }
      expect((await fetchStyles()).status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('shares in-flight slots across documents, sources and assets and releases them after completion', async () => {
    const filePath = path.join(process.env.OD_DATA_DIR!, 'concurrent-preview.html');
    const html = '<!doctype html><title>Preview fixture</title>';
    await writeFile(filePath, html);
    const file = { filePath, mime: 'text/html', size: Buffer.byteLength(html) };
    const app = express();
    const preview = createHostedPreviewRoutes({
      currentSession(req) {
        const ownerId = req.get('X-Fixture-Owner');
        return ownerId ? { ownerId, sessionId: ownerId } : undefined;
      },
      isActive: () => true,
    });
    const held = gate();
    const firstOwnerStarted = gate();
    const allOwnersStarted = gate();
    let started = 0;
    preview.registerAssets(app);
    preview.registerDocuments(app);
    app.get('/fixture', (req, res) => preview.redirect(
      req, res, 'index.html', async (name) => name === 'index.html'
        ? file : { ...file, mime: 'text/css' },
      async (_req, bytes) => {
        started++;
        if (started === 8) firstOwnerStarted.resolve();
        if (started === 32) allOwnersStarted.resolve();
        await held.promise;
        return bytes;
      },
    ));
    app.get('/fixture-source', async (req, res) => {
      try {
        res.send(await preview.readSource(req, file, 1024));
      } catch (error) {
        if (!(error instanceof HostedPreviewBusy)) throw error;
        res.sendStatus(429);
      }
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const reads: Promise<Response>[] = [];
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
      const base = new URL(`http://127.0.0.1:${address.port}`);
      const headers = (index: number) => ({ 'X-Fixture-Owner': `owner-${index}` });
      async function issue(index: number) {
        const redirect = await fetch(new URL('/fixture', base), { redirect: 'manual', headers: headers(index) });
        expect(redirect.status).toBe(302);
        const url = new URL(redirect.headers.get('Location')!, base);
        await redirect.text();
        return url;
      }
      async function startReads(index: number) {
        const urls = await Promise.all(Array.from({ length: 8 }, () => issue(index)));
        reads.push(...urls.map((url) => fetch(url, { headers: headers(index) })));
      }
      await startReads(0);
      await firstOwnerStarted.promise;
      const extra = await issue(0);
      expect((await fetch(extra, { headers: headers(0) })).status).toBe(429);
      expect((await fetch(new URL('theme.css', extra), { headers: { 'Sec-Fetch-Dest': 'style' } })).status).toBe(429);
      const source = new URL('/fixture-source', base);
      expect((await fetch(source, { headers: headers(0) })).status).toBe(429);
      const otherOwner = await fetch(source, { headers: headers(1) });
      expect(otherOwner.status).toBe(200);
      await otherOwner.text();
      await Promise.all([1, 2, 3].map(startReads));
      await allOwnersStarted.promise;
      expect((await fetch(source, { headers: headers(4) })).status).toBe(429);
      held.resolve();
      for (const result of await Promise.all(reads)) {
        expect(result.status).toBe(200);
        await result.text();
      }
      const released = await fetch(source, { headers: headers(0) });
      expect(released.status).toBe(200);
      await expect(released.text()).resolves.toBe(html);
    } finally {
      held.resolve();
      await Promise.allSettled(reads);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
