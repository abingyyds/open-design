import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonRuntime } from '../src/daemon-startup.js';
import type { StartServerResult } from '../src/server.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hosted security maintenance', () => {
  it.each([
    { name: 'explicit hosted mode', platform: '1', railway: undefined, override: undefined },
    { name: 'Railway with a legacy platform override', platform: '0', railway: 'test-environment', override: undefined },
    { name: 'Railway without tenant auth even when maintenance is disabled', platform: '0', railway: 'test-environment', override: '0' },
  ])('keeps $name in maintenance without opening the platform database', async ({ platform, railway, override }) => {
    vi.stubEnv('OD_PLATFORM_ENABLED', platform);
    vi.stubEnv('RAILWAY_ENVIRONMENT', railway);
    vi.stubEnv('RAILWAY_PROJECT_ID', undefined);
    vi.stubEnv('OD_HOSTED_MAINTENANCE', override);
    vi.stubEnv('OD_DISABLE_API_AUTH', '1');
    vi.stubEnv('OD_CODEX_SANDBOX', 'danger-full-access');
    const runtime = await startDaemonRuntime({ host: '127.0.0.1', port: 0 });
    try {
      const health = await fetch(new URL('/api/health', runtime.url));
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ ok: true, maintenance: true });
      expect(existsSync(path.join(process.env.OD_DATA_DIR!, 'platform.sqlite3'))).toBe(false);

      for (const [method, route] of [
        ['GET', '/api/ready'],
        ['POST', '/api/platform/login'],
        ['POST', '/api/runs'],
        ['POST', '/api/projects/test-project/terminals'],
        ['GET', '/artifacts/test.html'],
      ] as const) {
        const response = await fetch(new URL(route, runtime.url), { method });
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'HOSTED_MAINTENANCE' },
        });
      }
    } finally {
      await runtime.stop();
    }
  });

  it('uses the maintenance listener when the server is started directly', async () => {
    vi.stubEnv('OD_PLATFORM_ENABLED', '1');
    vi.stubEnv('OD_HOSTED_MAINTENANCE', '1');
    const { startServer } = await import('../src/server.js');
    const started = await startServer({
      host: '127.0.0.1', port: 0, returnServer: true,
    }) as StartServerResult | string;
    if (typeof started === 'string') throw new Error('Expected a server handle');
    try {
      const response = await fetch(new URL('/', started.url));
      expect(response.status).toBe(503);
      await expect(response.text()).resolves.toContain('security maintenance');
      expect(existsSync(path.join(process.env.OD_DATA_DIR!, 'platform.sqlite3'))).toBe(false);
    } finally {
      await started.shutdown();
      await new Promise<void>((resolve, reject) => {
        started.server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
