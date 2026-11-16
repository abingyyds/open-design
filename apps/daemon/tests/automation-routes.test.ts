import { afterEach, expect, it, vi } from 'vitest';
import { startDaemonRuntime } from '../src/daemon-startup.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('keeps the source packet and proposal workflow available on the local daemon', async () => {
  vi.stubEnv('OD_PLATFORM_ENABLED', '0');
  vi.stubEnv('RAILWAY_ENVIRONMENT', undefined);
  vi.stubEnv('RAILWAY_PROJECT_ID', undefined);
  const runtime = await startDaemonRuntime({ host: '127.0.0.1', port: 0 });
  try {
    const request = (path: string, init?: RequestInit) => fetch(new URL(path, runtime.url), init);
    const templates = await request('/api/automation-templates');
    expect(templates.status).toBe(200);
    await expect(templates.json()).resolves.toMatchObject({
      templates: expect.arrayContaining([expect.objectContaining({ id: 'connector-digest-design-context' })]),
    });
    const created = await request('/api/automation-ingestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'connector-digest-design-context',
        sourceKind: 'connector',
        sourceRef: 'slack://fixture/123',
        connectorId: 'slack',
        accountLabel: 'Local fixture',
        title: 'Design decision fixture',
        bodyMarkdown: 'Review mock design decisions.',
        tokenCompression: 'off',
      }),
    });
    expect(created.status).toBe(200);
    const { packet } = await created.json() as { packet: { id: string } };
    expect(packet.id).toBeTruthy();
    const detail = await request(`/api/automation-source-packets/${packet.id}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ packet: { id: packet.id } });
    const proposals = await request('/api/automation-proposals?status=pending-review');
    expect(proposals.status).toBe(200);
    await expect(proposals.json()).resolves.toMatchObject({
      proposals: expect.arrayContaining([expect.objectContaining({ sourcePacketIds: [packet.id] })]),
    });
  } finally {
    await runtime.stop();
  }
});
