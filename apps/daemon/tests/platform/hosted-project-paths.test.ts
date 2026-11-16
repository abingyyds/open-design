import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readAppConfig, writeAppConfig } from '../../src/app-config.js';
import { readMemoryConfig, writeMemoryConfig } from '../../src/memory.js';
import { readVercelConfig, writeVercelConfig } from '../../src/deploy.js';
import * as deployService from '../../src/deploy.js';
import * as hostedPreviewRoutes from '../../src/http/hosted-preview.js';
import * as librarySync from '../../src/library-sync.js';
import { createLiveArtifact } from '../../src/live-artifacts/store.js';
import { readMcpConfig, writeMcpConfig } from '../../src/mcp-config.js';
import { getXAIToken, setXAIToken } from '../../src/integrations/xai-tokens.js';
import * as invocation from '../../src/runtimes/invocation.js';
import { detectAgents, detectAgentsStream } from '../../src/runtimes/detection.js';
import { readMaskedConfig, writeConfig } from '../../src/media/config.js';
import * as mediaConfig from '../../src/media/config.js';
import { generateMedia } from '../../src/media/index.js';
import { MAX_INLINE_ASSET_BYTES, MAX_INLINE_TOTAL_BYTES } from '../../src/inline-assets.js';
import { insertMediaTask } from '../../src/media/tasks.js';
import { closeDatabase, getProject, getTemplate, insertProject, insertTemplate, listProjects, openDatabase, upsertDeployment } from '../../src/db.js';
import { insertLibraryAsset } from '../../src/library-store.js';
import { SubrouterPlatform } from '../../src/platform/subrouter.js';
import { resolveProjectDir } from '../../src/projects.js';
import type { StartServerResult } from '../../src/server.js';

// Exercise the production routes on loopback behind real platform sessions.
// Only the startup maintenance gate is lifted, within this test file.
vi.mock(import('../../src/platform/deployment.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  hostedMaintenanceRequired: () => false,
}));

describe('hosted project and daemon boundaries', () => {
  const dataDir = process.env.OD_DATA_DIR!;
  const privateDir = path.join(dataDir, 'private-fixture');
  const deploymentDir = path.join(dataDir, 'deployment-fixture');
  const projectsDir = path.join(dataDir, 'projects');
  const ownerId = 'hosted-test-owner';
  const otherId = 'hosted-test-other';
  const legacyId = 'legacy-folder';
  const managedId = 'managed-project';
  const secondManagedId = 'second-managed-project';
  const removedSourceId = 'historical-template-project';
  const historicalTemplateId = 'historical-template';
  const reassignedTemplateId = 'historical-template-reassigned';
  let ownerConversationId: string;
  let otherConversationId: string;
  const fileName = 'fixture.txt';
  let db: ReturnType<typeof openDatabase>;
  let server: StartServerResult;
  let ownerSession: string;
  let otherSession: string;
  let agentInvocationsAtStartup: number;
  let hostedPreview: hostedPreviewRoutes.HostedPreviewRoutes;

  beforeAll(async () => {
    vi.stubEnv('OD_PLATFORM_ENABLED', '1');
    vi.stubEnv('OD_MEDIA_CONFIG_DIR', undefined);
    vi.stubEnv('OD_USER_STATE_DIR', deploymentDir);
    const platform = new SubrouterPlatform(dataDir);
    const now = Date.now();
    try {
      const insertUser = platform.db.prepare(
        'INSERT INTO platform_users (id, username, created_at, updated_at) VALUES (?, ?, ?, ?)',
      );
      for (const id of [ownerId, otherId]) insertUser.run(id, id, now, now);
      ownerSession = platform.createSession(ownerId);
      otherSession = platform.createSession(otherId);
    } finally {
      platform.db.close();
    }

    db = openDatabase(dataDir, { dataDir });
    await mkdir(path.join(projectsDir, 'reassigned-source'), { recursive: true });
    insertTemplate(db, {
      id: historicalTemplateId, name: 'Historical template', sourceProjectId: removedSourceId,
      files: [{ name: 'index.html', content: '<h1>Historical fixture</h1>' }], createdAt: now,
    });
    insertProject(db, {
      id: 'reassigned-source', name: 'Replacement fixture', metadata: { platformUserId: otherId },
      createdAt: now, updatedAt: now,
    });
    insertTemplate(db, {
      id: reassignedTemplateId, name: 'Historical template', sourceProjectId: 'reassigned-source',
      files: [{ name: 'index.html', content: '<h1>Historical fixture</h1>' }], createdAt: now - 1000,
    });
    closeDatabase();
    db = openDatabase(dataDir, { dataDir });
    insertProject(db, {
      id: legacyId,
      name: 'Legacy folder',
      metadata: { importedFrom: 'folder', baseDir: privateDir, platformUserId: ownerId },
      createdAt: now,
      updatedAt: now,
    });
    await mkdir(privateDir, { recursive: true });
    await writeFile(path.join(privateDir, fileName), 'private test fixture');

    await writeAppConfig(dataDir, { agentCliEnv: { codex: { CODEX_BIN: process.execPath } } });
    const { startServer } = await import('../../src/server.js');
    const exec = vi.spyOn(invocation, 'execAgentFile').mockImplementation(() => {
      throw new Error('Unexpected host agent invocation in hosted test');
    });
    const createPreviewRoutes = hostedPreviewRoutes.createHostedPreviewRoutes;
    const observePreview = vi.spyOn(hostedPreviewRoutes, 'createHostedPreviewRoutes').mockImplementation((sessions) => {
      hostedPreview = createPreviewRoutes(sessions);
      return hostedPreview;
    });
    let started: StartServerResult | string;
    try {
      started = await startServer({
        host: '127.0.0.1', port: 0, returnServer: true,
      }) as StartServerResult | string;
      agentInvocationsAtStartup = exec.mock.calls.length;
    } finally {
      exec.mockRestore();
      observePreview.mockRestore();
    }
    if (typeof started === 'string') throw new Error('Expected a server handle');
    server = started;

    const created = await request('/api/projects', { method: 'POST', body: { id: managedId, name: 'Managed' } });
    expect(created.status).toBe(200);
    ownerConversationId = (await created.json() as { conversationId: string }).conversationId;
    const second = await request('/api/projects', {
      method: 'POST', session: otherSession, body: { id: secondManagedId, name: 'Second project' },
    });
    expect(second.status).toBe(200);
    otherConversationId = (await second.json() as { conversationId: string }).conversationId;
    await mkdir(path.join(projectsDir, managedId), { recursive: true });
    await writeFile(path.join(projectsDir, managedId, fileName), 'managed test fixture');
    await writeFile(path.join(projectsDir, managedId, 'hosted.html'), '<!doctype html><title>Hosted fixture</title>');
    await writeFile(path.join(projectsDir, managedId, 'hosted.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  afterAll(async () => {
    try {
      if (server) {
        await server.shutdown();
        await new Promise<void>((resolve, reject) => {
          server.server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  function request(route: string, { method = 'GET', body, session = ownerSession, headers, redirect }: {
    method?: string;
    body?: object;
    session?: string;
    headers?: Record<string, string>;
    redirect?: 'manual' | 'follow' | 'error';
  } = {}) {
    return fetch(new URL(route, server.url), {
      method,
      headers: { ...(session ? { Cookie: `od_platform_session=${session}` } : {}), 'Content-Type': 'application/json', ...headers },
      ...(redirect ? { redirect } : {}),
      body: body ? JSON.stringify(body) : null,
    });
  }

  function previewAsset(documentUrl: string, name: string, dest: string, session = '') {
    return request(new URL(name, documentUrl).href, {
      session, headers: { Origin: 'null', 'Sec-Fetch-Dest': dest },
    });
  }

  it('rejects both tenants reading or changing shared app and media settings', async () => {
    await writeAppConfig(dataDir, { agentCliEnv: { codex: { CODEX_BIN: '/fixture/codex' } } });
    await writeConfig(dataDir, { providers: { openai: { apiKey: 'synthetic-stored-key', baseUrl: 'https://initial.example.test' } } });
    const appBefore = await readAppConfig(dataDir);
    const mediaBefore = await readMaskedConfig(dataDir);
    for (const session of [ownerSession, otherSession]) {
      for (const [method, route, body] of [
        ['GET', '/api/app-config', undefined],
        ['PUT', '/api/app-config', { agentCliEnv: { codex: { CODEX_BIN: '/fixture/another' } } }],
        ['GET', '/api/media/config', undefined],
        ['PUT', '/api/media/config', { providers: { openai: { baseUrl: 'https://another.example.test' } } }],
        ['GET', '/api/recent-dirs', undefined],
        ['POST', '/api/integrations/vela/logout', undefined],
      ] as const) {
        const response = await request(route, { method, session, ...(body ? { body } : {}) });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
    expect(await readAppConfig(dataDir)).toEqual(appBefore);
    expect(await readMaskedConfig(dataDir)).toEqual(mediaBefore);
  });

  it('blocks local design-system folder import before scanning the source', async () => {
    const response = await request('/api/design-systems/import/local', {
      method: 'POST', body: { baseDir: privateDir },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('blocks hosted access to shared memory, deployment and installation APIs', async () => {
    await writeMemoryConfig(dataDir, { profileEnabled: true });
    await writeVercelConfig({ token: 'fixture-token', teamId: 'fixture-team' });
    const memoryBefore = await readMemoryConfig(dataDir);
    const deployBefore = await readVercelConfig();
    const routes = [
      ['GET', '/api/memory'],
      ['PATCH', '/api/memory/config'],
      ['POST', '/api/memory/extract'],
      ['GET', '/api/deploy/config'],
      ['PUT', '/api/deploy/config'],
      ['GET', '/api/deploy/cloudflare-pages/zones'],
      ['POST', '/api/plugins/install'],
      ['POST', '/api/plugins/upload-folder'],
      ['POST', '/api/skills/install'],
      ['POST', '/api/skills/import'],
      ['POST', '/api/design-systems/install'],
    ] as const;
    const results = await Promise.all([ownerSession, otherSession].flatMap((session) =>
      routes.map(async ([method, route]) => {
        const response = await request(route, {
          method, session,
          ...(method === 'POST' || method === 'PATCH' || method === 'PUT'
            ? { body: { source: 'local', path: privateDir, profileEnabled: false, teamId: 'other-fixture' } } : {}),
        });
        return [method, route, response.status];
      }),
    ));
    expect(results).toEqual([ownerSession, otherSession].flatMap(() =>
      routes.map(([method, route]) => [method, route, 403]),
    ));
    const install = `/api/projects/${managedId}/plugins/install-folder`;
    expect((await request(install, { method: 'POST' })).status).toBe(403);
    const deploy = `/api/projects/${managedId}/deploy`;
    expect((await request(deploy, { method: 'POST' })).status).toBe(403);
    expect((await request(`${deploy}/preflight`, { method: 'POST' })).status).toBe(403);
    expect((await request(deploy, { method: 'POST', session: otherSession })).status).toBe(404);
    expect(await readMemoryConfig(dataDir)).toEqual(memoryBefore);
    expect(await readVercelConfig()).toEqual(deployBefore);
  });

  it('rejects a hosted host-agent connection check before resolving a runtime', async () => {
    const response = await request('/api/test/connection', {
      method: 'POST', body: { mode: 'agent', agentId: 'unregistered-fixture-agent' },
    });
    expect(response.status).toBe(403);
  });

  it('uses a separate tenant-scoped preview for HTML library assets', async () => {
    const html = '<!doctype html><title>Hosted Library preview fixture</title>';
    const upload = await request('/api/library/ingest', { method: 'POST', body: { kind: 'html', mime: 'text/html', text: html } });
    expect(upload.status).toBe(200);
    const { asset } = await upload.json() as { asset: { id: string } };
    const base = `/api/library/assets/${asset.id}`;
    const preview = await request(`${base}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Disposition')).toBeNull();
    const policy = preview.headers.get('Content-Security-Policy');
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).not.toContain('allow-same-origin');
    await expect(preview.text()).resolves.toBe(html);
    expect((await request(`${base}/preview`, { session: otherSession })).status).toBe(404);
    expect((await request(`${base}/raw`)).headers.get('Content-Disposition')).toBe('attachment');
  });

  it('keeps shared MCP settings and xAI authorization out of both tenants', async () => {
    const mcp = await writeMcpConfig(dataDir, {
      servers: [{ id: 'fixture-server', transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'fixture-value' } }],
    });
    const xai = { accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: Date.now() };
    await setXAIToken(dataDir, xai);
    for (const session of [ownerSession, otherSession]) {
      for (const response of [
        await request('/api/mcp/servers', { session }),
        await request('/api/mcp/servers', { method: 'PUT', session, body: { servers: [] } }),
        await request('/api/xai/auth/status', { session }),
        await request('/api/xai/oauth/disconnect', { method: 'POST', session }),
      ]) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
    await expect(readMcpConfig(dataDir)).resolves.toEqual(mcp);
    await expect(getXAIToken(dataDir)).resolves.toEqual(xai);
  });

  it('checks project ownership before handling a Figma upload', async () => {
    const route = `/api/projects/${managedId}/figma/import`;
    expect((await request(route, { method: 'POST', session: otherSession })).status).toBe(404);
    expect((await request(`/api/projects/${legacyId}/figma/import`, { method: 'POST' })).status).toBe(403);
    const owner = await request(route, { method: 'POST' });
    expect(owner.status).toBe(400);
    await expect(owner.json()).resolves.toMatchObject({ error: { message: 'file is required' } });
  });

  it('scopes template copy and deletion before writing a project', async () => {
    const body = '<h1>Private template fixture</h1>';
    expect((await request(`/api/projects/${managedId}/files`, {
      method: 'POST', body: { name: 'template-fixture.html', content: body },
    })).status).toBe(200);
    const saved = await request('/api/templates', {
      method: 'POST', body: { name: 'Private template', sourceProjectId: managedId },
    });
    expect(saved.status).toBe(200);
    const { template: { id: templateId } } = await saved.json() as { template: { id: string } };
    const clone = (id: string, session: string) => request('/api/projects', {
      method: 'POST', session, body: { id, name: 'Fixture clone', metadata: { kind: 'template', templateId } },
    });
    const refusedId = 'denied-template-clone';
    expect((await clone(refusedId, otherSession)).status).toBe(404);
    expect(getProject(db, refusedId)).toBeNull();
    await expect(stat(path.join(projectsDir, refusedId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await request(`/api/templates/${templateId}`, { method: 'DELETE', session: otherSession })).status).toBe(404);
    expect(getTemplate(db, templateId)).not.toBeNull();

    const ownCloneId = 'authorized-template-clone';
    expect((await clone(ownCloneId, ownerSession)).status).toBe(200);
    await expect(readFile(path.join(projectsDir, ownCloneId, 'template-fixture.html'), 'utf8')).resolves.toBe(body);
    expect((await request(`/api/templates/${templateId}`, { method: 'DELETE' })).status).toBe(200);
    expect(getTemplate(db, templateId)).toBeNull();
  });

  it('quarantines templates with unverifiable historical provenance', async () => {
    for (const session of [ownerSession, otherSession]) {
      const list = await request('/api/templates', { session });
      const { templates } = await list.json() as { templates: Array<{ id: string }> };
      expect(templates.map(({ id }) => id)).not.toContain(reassignedTemplateId);
    }
    expect(getTemplate(db, reassignedTemplateId)).not.toBeNull();
    const fresh = await request('/api/templates', {
      method: 'POST', session: otherSession, body: { sourceProjectId: 'reassigned-source', name: 'Historical template' },
    });
    expect(fresh.status).toBe(200);
    const { template } = await fresh.json() as { template: { id: string } };
    expect(template.id).not.toBe(reassignedTemplateId);
    expect((await request(`/api/templates/${template.id}`)).status).toBe(404);
    expect((await request(`/api/templates/${template.id}`, { session: otherSession })).status).toBe(200);
  });

  it('keeps historical templates with a missing source isolated after migration', async () => {
    for (const session of [ownerSession, otherSession]) {
      expect((await request(`/api/templates/${historicalTemplateId}`, { session })).status).toBe(404);
      expect((await request('/api/projects', {
        method: 'POST', session, body: { id: removedSourceId, name: 'Project fixture' },
      })).status).toBe(409);
    }
    expect(getProject(db, removedSourceId)).toBeNull();
    expect(getTemplate(db, historicalTemplateId)).not.toBeNull();
  });

  it('keeps preview assets tied to the authorized design system and package source', async () => {
    const dir = path.join(dataDir, 'design-systems', 'hud');
    const assetPath = 'preview/hosted-fixture.html';
    const content = '<link rel="stylesheet" href="../tokens.css"><h1>Private preview fixture</h1><script type="module" src="../assets/main.js"></script>';
    const css = '@import "./assets/theme.css"; h1 { color: rgb(21, 42, 63); }';
    await mkdir(path.join(dir, 'preview'), { recursive: true });
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'DESIGN.md'), '# Private HUD fixture');
    await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ platformUserId: ownerId }));
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
      schemaVersion: 'od-design-system-project/v1', id: 'hud', name: 'Private HUD', category: 'Fixture',
      files: { design: 'DESIGN.md', tokens: 'tokens.css' },
      preview: { pages: [{ path: assetPath, role: 'overview' }] },
      assetsDir: 'assets',
    }));
    await writeFile(path.join(dir, assetPath), content);
    await writeFile(path.join(dir, 'tokens.css'), css);
    await writeFile(path.join(dir, 'assets/theme.css'), 'h1 { font-weight: bold; }');
    await writeFile(path.join(dir, 'assets/main.js'), 'import "./labels.js";');
    await writeFile(path.join(dir, 'assets/labels.js'), 'export const label = "Kit fixture";');

    const query = `/static?path=${encodeURIComponent(assetPath)}`;
    expect((await request(`/api/design-systems/hud${query}`, { session: otherSession })).status).toBe(404);
    expect((await request(`/api/design-systems/user:hud${query}`, { session: otherSession })).status).toBe(404);
    const authorized = await request(`/api/design-systems/user:hud${query}`);
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('Content-Disposition')).toBe('attachment');
    await expect(authorized.text()).resolves.toBe(content);
    const route = `/api/design-systems/user:hud/preview-files/${assetPath}`;
    const preview = await request(route);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Disposition')).toBeNull();
    expect(preview.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(preview.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    const rendered = await preview.text();
    expect(rendered).toContain('Private preview fixture');
    expect(rendered).toContain('../assets/main.js');
    const styles = await previewAsset(preview.url, '../tokens.css', 'style');
    expect(styles.status).toBe(200);
    await expect(styles.text()).resolves.toBe(css);
    expect((await previewAsset(styles.url, 'assets/theme.css', 'style')).status).toBe(200);
    const script = await previewAsset(preview.url, '../assets/main.js', 'script');
    expect(script.status).toBe(200);
    expect(script.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await expect((await previewAsset(script.url, './labels.js', 'script')).text()).resolves.toContain('Kit fixture');
    expect((await previewAsset(preview.url, '../assets/main.js', 'script', otherSession)).status).toBe(404);
    expect((await request(route, { session: otherSession })).status).toBe(404);
    expect((await request(route, { session: '' })).status).toBe(401);
  });

  it('creates same-title design systems in separate namespaces for concurrent users', async () => {
    const fixtures = [[ownerSession, 'Owner sample'], [otherSession, 'Other sample']] as const;
    const systems = await Promise.all(fixtures.map(async ([session, summary]) => {
      const response = await request('/api/design-systems', {
        method: 'POST', session, body: { title: 'Concurrent kit fixture', body: `# Concurrent kit fixture\n\n${summary}` },
      });
      expect(response.status).toBe(201);
      return await response.json() as { id: string };
    }));
    expect(systems[0]!.id).not.toBe(systems[1]!.id);
    for (const [index, system] of systems.entries()) {
      const own = await request(`/api/design-systems/${encodeURIComponent(system.id)}`, { session: fixtures[index]![0] });
      await expect(own.json()).resolves.toMatchObject({ body: expect.stringContaining(fixtures[index]![1]) });
      expect((await request(`/api/design-systems/${encodeURIComponent(system.id)}`, { session: fixtures[1 - index]![0] })).status).toBe(404);
    }
  });

  it.each(['shadcn', 'github'] as const)('keeps concurrent same-title hosted %s and shadcn imports private to their owners', async (source) => {
    const fixtures = [[ownerSession, 'warm', '#ff3366'], [otherSession, 'cool', '#3366ff']] as const;
    const remote = 'https://github.com/open-design-fixtures/warm.git';
    const gitEnv = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_VALUE_0: remote,
    };
    const repo = path.join(dataDir, 'mixed-import-fixture');
    if (source === 'github') {
      await mkdir(repo, { recursive: true });
      await writeFile(path.join(repo, 'theme.css'), ':root { --primary: #ff3366; }');
      const env = { ...process.env, ...gitEnv, GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo).href}.insteadOf` };
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env });
      git('init', '-q', '--template=');
      git('add', 'theme.css');
      git('-c', 'user.name=Open Design Fixture', '-c', 'user.email=fixture@example.test',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Design fixture');
    }
    const registry = createServer((req, res) => {
      const fixture = fixtures.find(([, name]) => req.url === `/${name}.json`);
      if (!fixture) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        name: fixture[1], title: 'Shared fixture title', type: 'registry:theme',
        cssVars: { light: { primary: fixture[2] } },
      }));
    });
    registry.listen(0, '127.0.0.1');
    await once(registry, 'listening');
    const overrides = source === 'github'
      ? { ...gitEnv, GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo).href}.insteadOf` } : {};
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, overrides);
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback registry');
      const outcomes = await Promise.allSettled(fixtures.map(async ([session, name]) => {
        const useGitHub = source === 'github' && name === 'warm';
        const response = await request(`/api/design-systems/import/${useGitHub ? 'github' : 'shadcn'}`, {
          method: 'POST', session, body: {
            name: `Same title import fixture ${source}`,
            ...(useGitHub ? { githubUrl: remote } : { reference: `http://127.0.0.1:${address.port}/${name}.json` }),
          },
        });
        expect(response.status).toBe(201);
        return await response.json() as { designSystem: { id: string } };
      }));
      const imported = outcomes.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      expect(imported[0]!.designSystem.id).not.toBe(imported[1]!.designSystem.id);
      for (const [index, result] of imported.entries()) {
        const [session, , color] = fixtures[index]!;
        const route = `/api/design-systems/${encodeURIComponent(result.designSystem.id)}/static?path=DESIGN.md`;
        const own = await request(route, { session });
        expect(own.status).toBe(200);
        const source = await own.text();
        expect(source).toContain(color);
        expect(source).not.toContain(fixtures[1 - index]![2]);
        expect((await request(route, { session: fixtures[1 - index]![0] })).status).toBe(404);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('binds brand preview and finalization to the owned backing project', async () => {
    const brandId = 'owner-bound-brand';
    const dir = path.join(dataDir, 'brands', brandId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      id: brandId, projectId: managedId, sourceUrl: 'https://example.test', status: 'ready',
    }));
    await writeFile(path.join(dir, 'brand.json'), JSON.stringify({ name: 'Owner fixture' }));
    for (const action of ['preview', 'finalize']) {
      const result = await request(`/api/brands/${brandId}/${action}`, {
        method: 'POST', body: { projectId: secondManagedId },
      });
      expect(result.status).toBe(404);
    }
    await expect(stat(path.join(projectsDir, secondManagedId, 'brand.html'))).rejects.toMatchObject({ code: 'ENOENT' });
    const owned = await request(`/api/brands/${brandId}/preview`, { method: 'POST', body: { projectId: managedId } });
    expect(owned.status).toBe(200);
  });

  it('rejects hosted Codex image generation before loading host CLI configuration', async () => {
    const hostEnv = vi.spyOn(mediaConfig, 'resolveCodexImagegenEnv').mockRejectedValue(new Error('unexpected host configuration read'));
    const input = { surface: 'image' as const, model: 'codex-gpt-image-2', prompt: 'A plain fixture' };
    try {
      const response = await request(`/api/projects/${managedId}/media/generate`, { method: 'POST', body: input });
      expect(response.status).toBe(403);
      await expect(generateMedia({
        ...input, projectId: managedId, projectRoot: dataDir, projectsRoot: projectsDir,
      })).rejects.toThrow(/unavailable in hosted mode/);
      expect(hostEnv).not.toHaveBeenCalled();
    } finally {
      hostEnv.mockRestore();
    }
  });

  it('rejects hosted HyperFrames on the HTTP and media service entry points', async () => {
    const input = { surface: 'video' as const, model: 'hyperframes-html', prompt: 'Plain fixture' };
    const response = await request(`/api/projects/${managedId}/media/generate`, { method: 'POST', body: input });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN', message: 'Host HyperFrames rendering is unavailable in hosted mode' },
    });
    await expect(generateMedia({
      ...input, projectId: managedId, projectRoot: dataDir, projectsRoot: projectsDir,
    })).rejects.toThrow('Host HyperFrames rendering is unavailable in hosted mode');
  });

  it('isolates active project context between accounts', async () => {
    const set = (projectId: string, fileName: string, session: string) =>
      request('/api/active', { method: 'POST', session, body: { projectId, fileName } });
    expect((await set(managedId, 'owner.html', ownerSession)).status).toBe(200);
    await expect((await request('/api/active', { session: otherSession })).json()).resolves.toEqual({ active: false });
    expect((await set(managedId, 'rejected.html', otherSession)).status).toBe(404);
    expect((await set(secondManagedId, 'other.html', otherSession)).status).toBe(200);
    await expect((await request('/api/active', { session: otherSession })).json()).resolves.toMatchObject({ projectId: secondManagedId, fileName: 'other.html' });
    expect((await request('/api/active', { method: 'POST', session: otherSession, body: { active: false } })).status).toBe(200);
    await expect((await request('/api/active')).json()).resolves.toMatchObject({ projectId: managedId, fileName: 'owner.html' });
  });

  it('scopes persisted media task snapshots to the project owner', async () => {
    const taskId = 'fixture-media-task-snapshot';
    insertMediaTask(db, { id: taskId, projectId: managedId, status: 'done', progress: ['Fixture complete'] });
    const route = `/api/media/tasks/${taskId}/wait`;
    expect((await request(route, { method: 'POST', session: otherSession })).status).toBe(404);
    const owner = await request(route, { method: 'POST' });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({ status: 'done' });
  });

  it('binds message updates to the owned conversation', async () => {
    const mid = 'owned-message-update-fixture';
    const owner = `/api/projects/${managedId}/conversations/${ownerConversationId}/messages/${mid}`;
    const other = `/api/projects/${secondManagedId}/conversations/${otherConversationId}/messages/${mid}`;
    const update = (route: string, session: string, content: string) =>
      request(route, { method: 'PUT', session, body: { role: 'user', content } });
    expect((await update(owner, ownerSession, 'Owner fixture')).status).toBe(200);
    expect((await update(other, otherSession, 'Other fixture')).status).toBe(404);
    const messages = await request(`/api/projects/${managedId}/conversations/${ownerConversationId}/messages`);
    await expect(messages.json()).resolves.toMatchObject({ messages: [{ id: mid, content: 'Owner fixture' }] });
    const edited = await update(owner, ownerSession, 'Updated fixture');
    expect(edited.status).toBe(200);
    await expect(edited.json()).resolves.toMatchObject({ message: { id: mid, content: 'Updated fixture' } });
  });

  it('checks owned historical deployment links without reading shared provider credentials', async () => {
    const deployment = upsertDeployment(db, {
      id: 'hosted-legacy-deployment', projectId: managedId, fileName: 'fixture.html',
      providerId: 'cloudflare-pages', url: 'https://fixture.pages.dev',
      cloudflarePages: {
        projectName: 'fixture',
        pagesDev: { url: 'https://fixture.pages.dev', status: 'ready' },
        customDomain: { hostname: 'example.test', url: 'https://example.test', status: 'ready', pagesDomainStatus: 'pending' },
      },
    });
    if (!deployment) throw new Error('Could not register deployment fixture');
    const listing = await request(`/api/projects/${managedId}/deployments`);
    await expect(listing.json()).resolves.toMatchObject({
      deployments: [{ url: 'https://fixture.pages.dev', cloudflarePages: { customDomain: { status: 'pending' } } }],
    });
    const readConfig = vi.spyOn(deployService, 'readDeployConfig').mockRejectedValue(new Error('unexpected shared credential read'));
    const publicCheck = vi.spyOn(deployService, 'checkDeploymentUrl').mockResolvedValue({ reachable: true });
    const providerCall = vi.spyOn(deployService, 'readCloudflarePagesDomain').mockRejectedValue(new Error('unexpected provider API call'));
    try {
      const route = `/api/projects/${managedId}/deployments/${deployment.id}/check-link`;
      expect((await request(route, { method: 'POST', session: otherSession })).status).toBe(404);
      expect(publicCheck).not.toHaveBeenCalled();
      const response = await request(route, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'link-delayed',
        statusMessage: 'Custom domain responds, but Cloudflare Pages has not confirmed its binding.',
        cloudflarePages: {
          customDomain: { status: 'pending', pagesDomainStatus: 'pending' },
        },
      });
      expect(publicCheck).toHaveBeenCalledTimes(2);
      publicCheck.mockResolvedValueOnce({ reachable: true }).mockResolvedValueOnce({ reachable: false });
      const unreachable = await request(route, { method: 'POST' });
      expect(unreachable.status).toBe(200);
      await expect(unreachable.json()).resolves.toMatchObject({
        status: 'link-delayed',
        statusMessage: 'Public custom-domain check did not succeed.',
        cloudflarePages: { customDomain: { status: 'pending', pagesDomainStatus: 'pending' } },
      });
      expect(readConfig).not.toHaveBeenCalled();
      expect(providerCall).not.toHaveBeenCalled();
    } finally {
      readConfig.mockRestore();
      publicCheck.mockRestore();
      providerCall.mockRestore();
    }
  });

  it('marks an active Cloudflare domain ready when its public link responds', async () => {
    const pagesDev = { url: 'https://fixture-active.pages.dev', status: 'ready' };
    const id = 'hosted-domain-active';
    upsertDeployment(db, {
      id, projectId: managedId, fileName: 'domain-active.html', providerId: 'cloudflare-pages', url: pagesDev.url,
      cloudflarePages: { projectName: 'fixture-active', pagesDev, customDomain: {
        hostname: 'active.example.test', url: 'https://active.example.test', status: 'pending', pagesDomainStatus: 'active',
        bindingVerifiedAt: Date.now(),
      } },
    });
    const check = vi.spyOn(deployService, 'checkDeploymentUrl').mockResolvedValue({ reachable: true });
    try {
      const response = await request(`/api/projects/${managedId}/deployments/${id}/check-link`, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ready', statusMessage: 'Both public links are reachable.',
        cloudflarePages: { customDomain: { status: 'ready', pagesDomainStatus: 'active' } },
      });
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000 + 1000);
      try {
        const stale = await request(`/api/projects/${managedId}/deployments/${id}/check-link`, { method: 'POST' });
        expect(stale.status).toBe(200);
        await expect(stale.json()).resolves.toMatchObject({
          url: pagesDev.url,
          cloudflarePages: { pagesDev: { status: 'ready' }, customDomain: { status: 'pending', pagesDomainStatus: 'active' } },
        });
      } finally {
        clock.mockRestore();
      }
    } finally {
      check.mockRestore();
    }
  });

  it('retains a custom-domain conflict when the pages.dev link is ready', async () => {
    const id = 'hosted-domain-conflict';
    const pagesDevUrl = 'https://fixture-conflict.pages.dev';
    const conflictMessage = 'This domain belongs to another Pages project.';
    upsertDeployment(db, {
      id, projectId: managedId, fileName: 'domain-conflict.html',
      providerId: 'cloudflare-pages', url: pagesDevUrl, cloudflarePages: {
        projectName: 'fixture-conflict',
        pagesDev: { url: pagesDevUrl, status: 'ready' },
        customDomain: {
          hostname: 'example.test', url: 'https://example.test',
          status: 'conflict', errorMessage: conflictMessage,
        },
      },
    });
    const publicCheck = vi.spyOn(deployService, 'checkDeploymentUrl').mockResolvedValue({ reachable: true });
    const readConfig = vi.spyOn(deployService, 'readDeployConfig').mockRejectedValue(new Error('unexpected shared credential read'));
    try {
      const response = await request(`/api/projects/${managedId}/deployments/${id}/check-link`, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: 'ready',
        statusMessage: `pages.dev is ready. ${conflictMessage}`,
        cloudflarePages: { pagesDev: { status: 'ready' }, customDomain: { status: 'conflict' } },
      });
      expect(publicCheck.mock.calls).toEqual([[pagesDevUrl]]);
      expect(readConfig).not.toHaveBeenCalled();
    } finally {
      publicCheck.mockRestore();
      readConfig.mockRestore();
    }
  });

  it('restricts live artifact listings, records and changes to the owning project', async () => {
    const { artifact } = await createLiveArtifact({
      projectsRoot: projectsDir,
      projectId: managedId,
      input: {
        title: 'Live artifact fixture',
        preview: { type: 'html', entry: 'index.html' },
        document: {
          format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html',
          dataPath: 'data.json', dataJson: { title: 'Live fixture' },
        },
      },
      templateHtml: '<h1>{{data.title}}</h1>',
    });
    const collection = '/api/live-artifacts';
    const detail = `${collection}/${artifact.id}`;
    const query = `?projectId=${managedId}`;
    for (const route of [collection, detail, `${detail}/refreshes`]) {
      const other = await request(`${route}${query}`, { session: otherSession });
      expect(other.status).toBe(404);
      expect((await request(`${route}${query}`)).status).toBe(200);
    }
    expect((await request(`${detail}${query}`, { method: 'DELETE', session: otherSession })).status).toBe(404);
    const current = await request(`${detail}${query}`);
    await expect(current.json()).resolves.toMatchObject({ artifact: { id: artifact.id, title: 'Live artifact fixture' } });
  });

  it('keeps hosted import association checks and symlink-free packages at the serving boundary', async () => {
    const designs = path.join(dataDir, 'design-systems');
    const own = path.join(designs, 'fixtures-association');
    const linked = path.join(designs, 'fixtures-local-link');
    const original = '# Design package fixture';
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, 'DESIGN.md'), original);
    await writeFile(path.join(own, 'metadata.json'), JSON.stringify({ platformUserId: otherId, projectId: managedId }));
    await writeFile(path.join(projectsDir, managedId, 'DESIGN.md'), '# Project design fixture');
    const ownDetail = await request('/api/design-systems/user:fixtures-association', { session: otherSession });
    expect(ownDetail.status).toBe(200);
    await expect(ownDetail.json()).resolves.toMatchObject({ body: original });

    await mkdir(linked, { recursive: true });
    await writeFile(path.join(linked, 'DESIGN.md'), '# Local linked asset fixture');
    await writeFile(path.join(linked, 'metadata.json'), JSON.stringify({ platformUserId: ownerId }));
    await symlink('DESIGN.md', path.join(linked, 'reference.md'));
    expect((await request('/api/design-systems/user:fixtures-local-link')).status).toBe(404);
    expect((await request('/api/design-systems/user:fixtures-local-link/static?path=DESIGN.md')).status).toBe(404);
  });

  it('serves hosted SVG brand logos as inert assets for the owning user', async () => {
    const dir = path.join(dataDir, 'brands', 'fixture-brand');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>';
    await mkdir(path.join(dir, 'logos'), { recursive: true });
    await writeFile(path.join(dir, 'logos', 'logo.svg'), svg);
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      id: 'fixture-brand', projectId: managedId, sourceUrl: 'https://example.test', status: 'ready',
    }));
    await writeFile(path.join(dir, 'brand.json'), JSON.stringify({
      name: 'Fixture brand', logo: { primary: 'logos/logo.svg' },
    }));
    const route = '/api/brands/fixture-brand/logo';
    expect((await request(route, { session: otherSession })).status).toBe(404);
    const response = await request(route);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(response.headers.get('Content-Disposition')).toBe('attachment');
    expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    await expect(response.text()).resolves.toBe(svg);
  });

  it('skips host agent startup and discovery despite saved executable preferences', async () => {
    expect(agentInvocationsAtStartup).toBe(0);
    expect((await readAppConfig(dataDir)).agentCliEnv?.codex?.CODEX_BIN).toBeDefined();
    const exec = vi.spyOn(invocation, 'execAgentFile').mockImplementation(() => {
      throw new Error('Unexpected host agent invocation in hosted test');
    });
    try {
      const config = (await readAppConfig(dataDir)).agentCliEnv;
      await expect(detectAgents(config)).resolves.toEqual([]);
      await expect(detectAgentsStream(config).next()).resolves.toEqual({ done: true, value: undefined });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });

  it('isolates plugin, skill and design-system HTML previews at the response boundary', async () => {
    const previews = [
      '/api/plugins/example-pricing-page/preview',
      '/api/skills/frame-flowchart-sticky/example',
      '/api/design-systems/hud/preview',
      '/api/design-systems/hud/showcase',
    ];
    for (const route of previews) {
      const response = await request(route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const policy = response.headers.get('Content-Security-Policy');
      expect(policy, route).toContain('sandbox');
      expect(policy, route).not.toContain('allow-same-origin');
    }
    for (const route of [
      '/api/plugins/example-pricing-page/asset/example.html',
      '/api/design-systems/hud/static?path=components.html',
    ]) {
      const raw = await request(route);
      expect(raw.status, route).toBe(200);
      expect(raw.headers.get('Content-Disposition')).toBe('attachment');
      expect(raw.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    }
    const created = await request('/api/design-systems', {
      method: 'POST', body: { title: 'Private hosted design system' },
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const privatePreview = `/api/design-systems/${encodeURIComponent(id)}/preview`;
    expect((await request(privatePreview)).status).toBe(200);
    expect((await request(privatePreview, { session: otherSession })).status).toBe(404);
  });

  it('indexes and serves managed project assets within their own tenant', async () => {
    const otherProject = 'other-managed-project';
    const html = '<!doctype html><title>Matching project asset</title>';
    const created = await request('/api/projects', {
      method: 'POST', body: { id: otherProject, name: 'Other managed project' }, session: otherSession,
    });
    expect(created.status).toBe(200);
    const projects = [[managedId, ownerSession], [otherProject, otherSession]] as const;
    await Promise.all(projects.map(async ([id, session]) => {
      const upload = await request(`/api/projects/${id}/files`, {
        method: 'POST', body: { name: 'library-test.html', content: html }, session,
      });
      expect(upload.status).toBe(200);
    }));
    const reconcile = vi.spyOn(librarySync, 'reconcileLibrary');
    const readAssets = async (id: string, session: string) => {
      const listing = await request('/api/library/assets?q=library-test', { session });
      expect(listing.status).toBe(200);
      const { assets } = await listing.json() as { assets: Array<{ id: string; originProjectId: string }> };
      expect(assets.map((asset) => asset.originProjectId)).toEqual([id]);
      return assets[0]!;
    };
    let assets;
    try {
      const [ownerAsset, otherAsset, concurrentOwnerAsset] = await Promise.all([
        readAssets(managedId, ownerSession),
        readAssets(otherProject, otherSession),
        readAssets(managedId, ownerSession),
      ]);
      assets = [ownerAsset, otherAsset];
      expect(concurrentOwnerAsset.id).toBe(ownerAsset.id);
      await readAssets(managedId, ownerSession);
      expect(reconcile.mock.calls.map((call) => call[2]?.userId).sort()).toEqual([otherId, ownerId].sort());
    } finally {
      reconcile.mockRestore();
    }
    expect(assets[0]!.id).not.toBe(assets[1]!.id);
    for (const [index, [, session]] of projects.entries()) {
      const own = await request(`/api/library/assets/${assets[index]!.id}/raw`, { session });
      expect(own.status).toBe(200);
      expect(own.headers.get('Content-Disposition')).toBe('attachment');
      await expect(own.text()).resolves.toBe(html);
      for (const suffix of ['', '/raw', '/element', '/figma']) {
        expect((await request(`/api/library/assets/${assets[1 - index]!.id}${suffix}`, { session })).status).toBe(404);
      }
    }
  });

  it('blocks saving and serving shared hosted HTML artifacts', async () => {
    const html = '<!doctype html><title>Legacy artifact fixture</title>';
    const legacy = path.join(dataDir, 'artifacts', 'hosted-legacy');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'index.html'), html);

    const created = await request('/api/artifacts/save', {
      method: 'POST', body: { identifier: 'fixture', html },
    });
    expect(created.status).toBe(403);
    await expect(created.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    for (const session of [ownerSession, '']) {
      const old = await request('/artifacts/hosted-legacy/index.html', { session });
      expect(old.status).toBe(404);
      await expect(old.text()).resolves.not.toContain('Legacy artifact fixture');
    }
    await expect(readFile(path.join(legacy, 'index.html'), 'utf8')).resolves.toBe(html);
  });

  it('keeps direct HTML and SVG downloads inert and renders project HTML in isolated previews', async () => {
    const projectUrl = `/api/projects/${managedId}`;
    const html = '<!doctype html><title>Managed preview fixture</title><link rel="stylesheet" href="preview-fixture.css"><img src="hosted.svg" alt="Preview fixture"><script type="module" src="module/main.js"></script>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    const css = 'body { background: rgb(20, 40, 60); }';
    expect((await request(`${projectUrl}/files`, {
      method: 'POST', body: { name: 'preview-fixture.css', content: css },
    })).status).toBe(200);
    for (const [name, content] of [
      ['module/main.js', 'import "./message.js";'],
      ['module/message.js', 'export const label = "Project fixture";'],
    ]) {
      expect((await request(`${projectUrl}/files`, { method: 'POST', body: { name, content } })).status).toBe(200);
    }
    for (const [name, content] of [['hosted.html', html], ['hosted.svg', svg]] as const) {
      const uploaded = await request(`${projectUrl}/files`, { method: 'POST', body: { name, content } });
      expect(uploaded.status).toBe(200);
      for (const endpoint of ['raw', 'files']) {
        const direct = await request(`${projectUrl}/${endpoint}/${name}`);
        expect(direct.status).toBe(200);
        expect(direct.headers.get('Content-Disposition')).toBe('attachment');
        expect(direct.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
        expect(direct.headers.get('X-Content-Type-Options')).toBe('nosniff');
        await expect(direct.text()).resolves.toContain(content);
      }
    }

    const mint = await request(`${projectUrl}/preview-url?file=hosted.html`);
    expect(mint.status).toBe(200);
    const { url } = await mint.json() as { url: string };
    const preview = await request(url);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Disposition')).toBeNull();
    const csp = preview.headers.get('Content-Security-Policy');
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    await expect(preview.text()).resolves.toContain('Managed preview fixture');
    expect((await request(url, { session: otherSession })).status).toBe(404);
    expect((await request(url, { session: '' })).status).toBe(401);

    const browserUrl = `${projectUrl}/preview-files/hosted.html?odPreviewBridge=scroll`;
    const browserPreview = await request(browserUrl);
    expect(browserPreview.status).toBe(200);
    expect(browserPreview.headers.get('Content-Disposition')).toBeNull();
    expect(browserPreview.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(browserPreview.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
    const markup = await browserPreview.text();
    expect(markup).toContain('Managed preview fixture');
    expect(markup).toContain('od:preview-scroll');
    const style = await previewAsset(browserPreview.url, 'preview-fixture.css', 'style');
    expect(style.status).toBe(200);
    await expect(style.text()).resolves.toBe(css);
    const image = await previewAsset(browserPreview.url, 'hosted.svg', 'image');
    expect(image.status).toBe(200);
    await expect(image.text()).resolves.toContain(svg);
    const mainScript = await previewAsset(browserPreview.url, 'module/main.js', 'script');
    expect(mainScript.status).toBe(200);
    expect((await previewAsset(mainScript.url, 'message.js', 'script')).status).toBe(200);
    expect((await previewAsset(browserPreview.url, 'hosted.html', 'script')).status).toBe(404);
    expect((await previewAsset(browserPreview.url, 'hosted.svg', 'image', otherSession)).status).toBe(404);
    expect((await request(browserPreview.url, { session: '' })).status).toBe(401);
    expect((await request(browserUrl, { session: otherSession })).status).toBe(404);
    expect((await request(browserUrl, { session: '' })).status).toBe(401);
  });

  it('rejects HTML and individual assets above the hosted preview read limits', async () => {
    const dir = path.join(projectsDir, managedId);
    await writeFile(path.join(dir, 'oversize-preview.html'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await writeFile(path.join(dir, 'oversize-preview.css'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const tooLarge = await request(`/api/projects/${managedId}/preview-files/oversize-preview.html`, { redirect: 'manual' });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('Location')).toBeNull();
    expect((await request(`/api/projects/${managedId}/preview-url?file=oversize-preview.html`)).status).toBe(413);
    expect((await request(`/api/projects/${managedId}/preview-source?file=oversize-preview.html`)).status).toBe(413);
    const ordinary = await request(`/api/projects/${managedId}/preview-source?file=hosted.html`);
    expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get('Content-Type')).toContain('text/plain');
    const preview = await request(`/api/projects/${managedId}/preview-files/hosted.html`);
    expect((await previewAsset(preview.url, 'oversize-preview.css', 'style')).status).toBe(413);
  });

  it('renews only the issuing session and revokes resource access when that session logs out', async () => {
    const platform = new SubrouterPlatform(dataDir);
    const session = platform.createSession(ownerId);
    platform.db.close();
    const projectUrl = `/api/projects/${managedId}`;
    const issued = await request(`${projectUrl}/preview-url?file=hosted.html`, { session });
    expect(issued.status).toBe(200);
    const { url } = await issued.json() as { url: string };
    const renew = new URL('renew', new URL(url, server.url)).pathname;
    expect((await request(renew, { method: 'POST', session: ownerSession })).status).toBe(404);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now + 8 * 60 * 1000);
      expect((await request(renew, { method: 'POST', session })).status).toBe(204);
      clock.mockReturnValue(now + 11 * 60 * 1000);
      expect((await previewAsset(new URL(url, server.url).href, 'hosted.svg', 'image')).status).toBe(200);
      expect((await request('/api/platform/logout', { method: 'POST', session })).status).toBe(200);
      expect((await previewAsset(new URL(url, server.url).href, 'hosted.svg', 'image')).status).toBe(404);
    } finally {
      clock.mockRestore();
    }
  });

  it('serves a range of a media asset larger than the single-buffer limit', async () => {
    const projectUrl = `/api/projects/${managedId}`;
    const size = 5 * 1024 * 1024 + 1024;
    await writeFile(path.join(projectsDir, managedId, 'preview-video.mp4'), Buffer.alloc(size, 21));
    const preview = await request(`${projectUrl}/preview-files/hosted.html`);
    const assetUrl = new URL('preview-video.mp4', preview.url).href;
    const response = await request(assetUrl, {
      session: '', headers: { 'Sec-Fetch-Dest': 'video', Range: 'bytes=-16' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes ${size - 16}-${size - 1}/${size}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(16, 21));
  });

  it('recognizes a retired framed scope only once for its original entry and session', async () => {
    const path = `/api/projects/${managedId}/preview-files/hosted.html`;
    const entry = `${path}?odPreviewNavigation=${Date.now()}.${'a'.repeat(32)}`;
    const opened = await request(entry, { redirect: 'manual' });
    expect(opened.status).toBe(302);
    const documentUrl = new URL(opened.headers.get('location')!, server.url);
    const renew = new URL('renew', documentUrl).href;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      const newerEntry = `${path}?odPreviewNavigation=${Date.now()}.${'b'.repeat(32)}`;
      const newer = await request(newerEntry, { redirect: 'manual' });
      expect(newer.status).toBe(302);
      expect((await request(renew, { method: 'POST', body: { entry }, session: otherSession })).status).toBe(404);
      expect((await request(renew, { method: 'POST', body: { entry: '/unrelated' } })).status).toBe(404);
      expect((await request(renew, { method: 'POST', body: { entry: newerEntry } })).status).toBe(404);
      expect((await request(renew, { method: 'POST', body: { entry } })).status).toBe(410);
      expect((await request(renew, { method: 'POST', body: { entry } })).status).toBe(404);
      expect((await request(entry, { redirect: 'manual' })).status).toBe(410);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a renewed scope after its navigation issuance window closes', async () => {
    const time = Date.now();
    const path = `/api/projects/${managedId}/preview-files/hosted.html`;
    const entry = `${path}?odPreviewNavigation=${time}.${'a'.repeat(32)}`;
    const opened = await request(entry, { redirect: 'manual' });
    expect(opened.status).toBe(302);
    const location = opened.headers.get('location')!;
    const renew = new URL('renew', new URL(location, server.url)).href;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(time + 9 * 60_000);
    try {
      expect((await request(renew, { method: 'POST', body: { entry } })).status).toBe(204);
      clock.mockReturnValue(time + 11 * 60_000);
      expect((await request(renew, { method: 'POST', body: { entry } })).status).toBe(204);
      const repeated = await request(entry, { redirect: 'manual' });
      expect(repeated.status).toBe(302);
      expect(repeated.headers.get('location')).toBe(location);
      expect((await request(location)).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps an exhausted media range budget after retrying and renewing the scope', async () => {
    const media = path.join(projectsDir, managedId, 'budget-video.mp4');
    await writeFile(media, '');
    await truncate(media, MAX_INLINE_TOTAL_BYTES + 1);
    const entry = `/api/projects/${managedId}/preview-files/hosted.html`;
    const preview = await request(entry, { redirect: 'manual' });
    expect(preview.status).toBe(302);
    const documentUrl = new URL(preview.headers.get('location')!, server.url);
    const mediaUrl = new URL('budget-video.mp4', documentUrl).href;
    const range = (start: number, end: number) => request(mediaUrl, {
      session: '', headers: { 'Sec-Fetch-Dest': 'video', Range: `bytes=${start}-${end}` },
    });
    for (let start = 0; start < MAX_INLINE_TOTAL_BYTES; start += MAX_INLINE_ASSET_BYTES) {
      const response = await range(start, start + MAX_INLINE_ASSET_BYTES - 1);
      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(MAX_INLINE_ASSET_BYTES);
    }
    expect((await range(MAX_INLINE_TOTAL_BYTES, MAX_INLINE_TOTAL_BYTES)).status).toBe(413);
    const retryUrl = new URL('.', documentUrl);
    retryUrl.searchParams.set('entry', entry);
    const retried = await request(retryUrl.href);
    expect(retried.status).toBe(200);
    expect(retried.url).toBe(documentUrl.href);
    expect((await range(MAX_INLINE_TOTAL_BYTES, MAX_INLINE_TOTAL_BYTES)).status).toBe(413);
    expect((await request(new URL('renew', documentUrl).href, { method: 'POST' })).status).toBe(204);
    expect((await range(MAX_INLINE_TOTAL_BYTES, MAX_INLINE_TOTAL_BYTES)).status).toBe(413);
  });

  it('returns a retryable hosted document when a Vite build read is busy, then serves the build on the same scope', async () => {
    const dir = path.join(projectsDir, managedId, 'vite-preview');
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Development entry</title><script type="module" src="/src/main.ts"></script>');
    await writeFile(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>Built entry</title><script type="module" src="/assets/main.js"></script>');
    const read = vi.spyOn(hostedPreview, 'readSource').mockRejectedValueOnce(new hostedPreviewRoutes.HostedPreviewBusy());
    try {
      const path = `/api/projects/${managedId}/preview-files/vite-preview/index.html`;
      const navigationTime = Date.now();
      const entry = `${path}?odPreviewBridge=scroll&odPreviewNavigation=${navigationTime}.${'a'.repeat(32)}`;
      const response = await request(entry);
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('1');
      expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
      const busy = await response.text();
      expect(busy).toContain('od:hosted-preview-retry');
      expect(busy).not.toContain('location.replace');
      expect(busy).not.toContain('Development entry');
      const busyUrl = new URL(response.url);
      const scope = busyUrl.pathname.split('/')[3]!;
      const receipt = /receipt: "([A-Za-z0-9_-]{32})"/u.exec(busy)?.[1];
      expect(receipt).toBeDefined();
      const verify = (path: string, session = ownerSession, origin = new URL(server.url).origin) => request('/api/hosted-preview/verify-retry', {
        method: 'POST', session, headers: { Origin: origin }, body: { receipt, entry: path },
      });
      expect((await verify('/api/projects/another/preview-files/vite-preview/index.html')).status).toBe(404);
      expect((await verify(`${path}?odPreviewBridge=scroll&odPreviewNavigation=${navigationTime}.${'b'.repeat(32)}`)).status).toBe(404);
      expect((await verify(entry, otherSession)).status).toBe(404);
      expect((await verify(entry, ownerSession, 'null')).status).toBe(403);
      const verified = await verify(entry);
      expect(verified.status).toBe(200);
      await expect(verified.json()).resolves.toEqual({ scope });
      expect((await verify(entry)).status).toBe(404);
      const retryUrl = new URL(`/api/hosted-preview/${scope}/`, busyUrl);
      retryUrl.searchParams.set('entry', '/api/projects/another/preview-files/vite-preview/index.html');
      expect((await request(retryUrl.href)).status).toBe(404);
      retryUrl.searchParams.set('entry', entry);
      expect((await request(retryUrl.href, { session: otherSession })).status).toBe(404);
      const retry = await request(retryUrl.href);
      expect(retry.status).toBe(200);
      expect(retry.url).toBe(response.url);
      const html = await retry.text();
      expect(html).toContain('Built entry');
      expect(html).toContain('dist/assets/main.js');
      expect(html).not.toContain('Development entry');
    } finally {
      read.mockRestore();
    }
  });

  it('also isolates captured markup served by the library', async () => {
    const html = '<!doctype html><title>Library HTML fixture</title>';
    const elementHtml = '<section>Library element fixture</section>';
    const ingested = await request('/api/library/ingest', {
      method: 'POST', body: { kind: 'html', text: html, mime: 'text/html', elementHtml },
    });
    expect(ingested.ok).toBe(true);
    const { asset } = await ingested.json() as { asset: { id: string } };
    const otherCapture = await request('/api/library/ingest', {
      method: 'POST', session: otherSession,
      body: { kind: 'html', text: html, mime: 'text/html', elementHtml: '<section>Other fixture</section>' },
    });
    expect(otherCapture.status).toBe(200);
    const { asset: otherAsset } = await otherCapture.json() as { asset: { id: string } };
    expect(otherAsset.id).not.toBe(asset.id);
    const otherElement = await request(`/api/library/assets/${otherAsset.id}/element`, { session: otherSession });
    await expect(otherElement.text()).resolves.toBe('<section>Other fixture</section>');
    expect((await request(`/api/library/assets/${asset.id}/raw`, { session: otherSession })).status).toBe(404);
    expect((await request(`/api/library/assets/${otherAsset.id}/element`)).status).toBe(404);
    for (const [suffix, content] of [['raw', html], ['element', elementHtml]] as const) {
      const response = await request(`/api/library/assets/${asset.id}/${suffix}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Disposition')).toBe('attachment');
      expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      await expect(response.text()).resolves.toBe(content);
    }
  });

  it('keeps unowned legacy library entries outside tenant listings and downloads', async () => {
    const id = 'legacy-unowned-asset';
    insertLibraryAsset(db, {
      id, storage: 'owned', kind: 'html', sourceTitle: 'Legacy library fixture',
      mime: 'text/html', capturedAt: Date.now(), archivedDate: '2026-11-01',
      contentHash: 'legacy-fixture-content',
      metadata: { platformUserId: ownerId },
    });
    for (const session of [ownerSession, otherSession]) {
      const listing = await request('/api/library/assets?q=Legacy+library+fixture', { session });
      await expect(listing.json()).resolves.toEqual({ assets: [] });
      expect(listing.headers.get('Cache-Control')).toBe('private, no-store');
      expect((await request(`/api/library/assets/${id}`, { session })).status).toBe(404);
    }
  });

  it('rejects importing and rebinding server directories without changing project records', async () => {
    const projectIds = listProjects(db).map((project) => project.id).sort();
    const projectBefore = getProject(db, managedId);
    for (const route of ['/api/import/folder', `/api/projects/${managedId}/working-dir`]) {
      const response = await request(route, { method: 'POST', body: { baseDir: privateDir } });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(listProjects(db).map((project) => project.id).sort()).toEqual(projectIds);
    expect(getProject(db, managedId)).toEqual(projectBefore);
  });

  it('disallows configuring, scanning, or creating projects in external locations', async () => {
    const rejected = await Promise.all([
      request('/api/project-locations', { method: 'PUT', body: { locations: [{ path: privateDir }] } }),
      request('/api/project-locations/scan', { method: 'POST' }),
      request('/api/projects', {
        method: 'POST',
        body: { id: 'external-location-project', name: 'External', projectLocationId: 'external' },
      }),
    ]);
    for (const response of rejected) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(getProject(db, 'external-location-project')).toBeNull();
  });

  it.each([
    'files',
    'search?q=fixture',
    `files/${fileName}`,
    `raw/${fileName}`,
    `preview-url?file=${fileName}`,
    'export/manifest',
  ])('rejects %s for a legacy project even when requested by its owner', async (route) => {
    const response = await request(`/api/projects/${legacyId}/${route}`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('blocks legacy external roots in shared file resolution', () => {
    expect(() => resolveProjectDir(projectsDir, legacyId, getProject(db, legacyId)?.metadata, {
      allowUnavailableSandboxImportedProject: true,
    })).toThrow('Hosted projects cannot access server directories.');
  });

  it('keeps project terminals and host editors unregistered in hosted mode', async () => {
    for (const [method, route] of [
      ['GET', `/api/projects/${managedId}/terminals`],
      ['POST', `/api/projects/${managedId}/terminals`],
      ['GET', '/api/editors'],
      ['POST', `/api/projects/${managedId}/open-in`],
    ] as const) {
      expect((await request(route, { method })).status).toBe(404);
    }
  });

  it('allows only the owner to remove a legacy project without touching the external directory', async () => {
    const id = 'legacy-folder-removal';
    const now = Date.now();
    insertProject(db, {
      id,
      name: 'Legacy project to remove',
      metadata: { importedFrom: 'folder', baseDir: privateDir, platformUserId: ownerId },
      createdAt: now,
      updatedAt: now,
    });

    const managedCopy = path.join(projectsDir, id, fileName);
    await mkdir(path.dirname(managedCopy), { recursive: true });
    await writeFile(managedCopy, 'managed legacy fixture');

    const route = `/api/projects/${id}`;
    expect((await request(route, { method: 'DELETE', session: otherSession })).status).toBe(404);
    expect(getProject(db, id)).not.toBeNull();

    const response = await request(route, { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(getProject(db, id)).toBeNull();
    expect((await request(route, { method: 'DELETE', session: otherSession })).status).toBe(404);
    await expect(readFile(path.join(privateDir, fileName), 'utf8')).resolves.toBe('private test fixture');
    await expect(readFile(managedCopy, 'utf8')).resolves.toBe('managed legacy fixture');
    for (const session of [ownerSession, otherSession]) {
      expect((await request(`${route}/raw/${fileName}`, { session })).status).toBe(404);
    }
    expect((await request('/api/projects', {
      method: 'POST', session: otherSession, body: { id, name: 'Replacement fixture' },
    })).status).toBe(409);
  });

  it('retires a managed project ID even after its directory has been removed', async () => {
    const id = 'managed-retirement-fixture';
    const make = (session: string) => request('/api/projects', {
      method: 'POST', session, body: { id, name: 'Retirement fixture' },
    });
    expect((await make(ownerSession)).status).toBe(200);
    expect((await request(`/api/projects/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await make(otherSession)).status).toBe(409);
  });

  it('lets owners read their managed files and still rejects other users', async () => {
    const file = `/api/projects/${managedId}/raw/${fileName}`;
    const owned = await request(file);
    expect(owned.status).toBe(200);
    await expect(owned.text()).resolves.toBe('managed test fixture');

    const other = await request(file, { session: otherSession });
    expect(other.status).toBe(404);
    await expect(other.json()).resolves.toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
  });
});
