import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubrouterPlatform } from '../../src/platform/subrouter.js';

describe('SubrouterPlatform Codex runtime', () => {
  let platform: SubrouterPlatform | null = null;
  let dataDir: string | null = null;

  afterEach(() => {
    platform?.db.close();
    platform = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  function createPlatformUser() {
    dataDir = mkdtempSync(join(tmpdir(), 'od-platform-subrouter-'));
    platform = new SubrouterPlatform(dataDir, { OD_PLATFORM_ENABLED: '1' });
    const timestamp = Date.now();
    platform.db.prepare(`
      INSERT INTO platform_users (
        id, username, subrouter_api_key, subrouter_base_url, default_model,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sr_platform_user',
      'aws123',
      'platform-key',
      'https://subrouter.example.com',
      'claude-sonnet-4-20250514',
      timestamp,
      timestamp,
    );
    return platform;
  }

  it('writes an isolated Codex provider config for platform runs', () => {
    const service = createPlatformUser();

    const runtime = service.runtimeForUser('sr_platform_user');

    expect(runtime.model).toBe('claude-sonnet-4-20250514');
    expect(runtime.baseUrl).toBe('https://subrouter.example.com/v1');
    expect(runtime.agentEnv).toMatchObject({
      OPENAI_BASE_URL: 'https://subrouter.example.com/v1',
      OPENAI_API_KEY: 'sk-platform-key',
      CODEX_API_KEY: 'sk-platform-key',
    });
    expect(runtime.agentEnv.CODEX_HOME).toContain('codex-home');

    const config = readFileSync(join(runtime.agentEnv.CODEX_HOME, 'config.toml'), 'utf8');
    expect(config).toContain('model_provider = "open_design_platform"');
    expect(config).toContain('model = "claude-sonnet-4-20250514"');
    expect(config).toContain('[model_providers.open_design_platform]');
    expect(config).toContain('base_url = "https://subrouter.example.com/v1"');
    expect(config).toContain('env_key = "OPENAI_API_KEY"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('requires_openai_auth = false');
  });

  it('refreshes the Codex provider config when the platform model changes', () => {
    const service = createPlatformUser();
    const firstRuntime = service.runtimeForUser('sr_platform_user');

    service.setDefaultModel('sr_platform_user', 'gpt-5.5');
    const secondRuntime = service.runtimeForUser('sr_platform_user');

    expect(secondRuntime.agentEnv.CODEX_HOME).toBe(firstRuntime.agentEnv.CODEX_HOME);
    const config = readFileSync(join(secondRuntime.agentEnv.CODEX_HOME, 'config.toml'), 'utf8');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config).not.toContain('claude-sonnet-4-20250514');
  });

  it('accepts SubRouter JSON access tokens when login does not set a cookie', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { id: 'external-1', username: 'alice', token: 'access-token-1' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notFound: true }), { status: 404 }));

    const login = await service.loginSubrouter(
      'https://subrouter.example.com',
      'alice',
      'password',
    );

    expect(login.access_token).toBe('access-token-1');
    expect(login.session_cookie).toBe('');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer access-token-1',
        'New-Api-User': 'external-1',
      },
    });
    fetchMock.mockRestore();
  });

  it('enriches distributor login data with the host required by site model routing', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          id: 'external-dist-user',
          username: 'alice',
          distributor: { id: 'dist-1', slug: 'alpha-site' },
        },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=abc; Path=/; HttpOnly',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          belongs_to_distributor: true,
          distributor_id: 'dist-1',
          distributor: {
            id: 'dist-1',
            slug: 'alpha-site',
            domain: 'alpha.example.com',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const login = await service.loginSubrouter(
      'https://subrouter.example.com',
      'alice',
      'password',
    );

    expect(login.distributor?.domain).toBe('alpha.example.com');
    expect(service.distributorHeadersFromLogin(login).Host).toBe('alpha.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it('reports a dedicated error when SubRouter requires 2FA', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: true,
        data: { require_2fa: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(service.loginSubrouter(
      'https://subrouter.example.com',
      'alice',
      'password',
    )).rejects.toMatchObject({ code: 'TWO_FACTOR_REQUIRED', status: 401 });
    fetchMock.mockRestore();
  });

  it('completes a SubRouter 2FA login with the pending session cookie', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { require_2fa: true },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=pending; Path=/; HttpOnly',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { id: 'external-1', username: 'alice' },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=verified; Path=/; HttpOnly',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { belongs_to_distributor: false, distributor_id: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const login = await service.loginSubrouter(
      'https://subrouter.example.com',
      'alice',
      'password',
      '123456',
    );

    expect(login.username).toBe('alice');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://subrouter.example.com/api/user/login/2fa');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Cookie: 'session=pending',
      },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(login.session_cookie).toBe('session=verified');
    fetchMock.mockRestore();
  });

  it('preserves the dedicated 2FA error through the candidate-base-url login flow', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({
        success: true,
        data: { require_2fa: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(service.login('alice', 'password')).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('does not expose media-only models to the Codex runtime', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: true,
        data: [
          { model_name: 'gpt-5.5', category: 'chat' },
          { model_name: 'gpt-image-1', category: 'image' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await service.fetchModels('sr_platform_user');

    expect(result.models.map((model) => model.id)).toEqual(['gpt-5.5']);
    expect(result.defaultModel).toBe('gpt-5.5');
    fetchMock.mockRestore();
  });

  it('fails clearly when a platform account has no selected text model', () => {
    const service = createPlatformUser();
    service.db.prepare('UPDATE platform_users SET default_model = ? WHERE id = ?')
      .run('', 'sr_platform_user');

    expect(() => service.runtimeForUser('sr_platform_user')).toThrowError(
      expect.objectContaining({ code: 'NO_MODELS_AVAILABLE' }),
    );
  });

  it('keeps the last selected model when the upstream catalogue is temporarily unavailable', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await service.fetchModels('sr_platform_user');

    expect(result.models).toEqual([]);
    expect(result.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(service.rowForUser('sr_platform_user').default_model).toBe('claude-sonnet-4-20250514');
    fetchMock.mockRestore();
  });

  it('extends an active platform session while it is used', () => {
    const service = createPlatformUser();
    const token = service.createSession('sr_platform_user');
    const before = service.db.prepare(
      'SELECT expires_at FROM platform_sessions WHERE token_hash = ?',
    ).get(createHash('sha256').update(token).digest('hex')) as { expires_at: number };
    const request = {
      headers: { cookie: `od_platform_session=${encodeURIComponent(token)}` },
    };

    const user = service.sessionUserFromRequest(request as any);
    const after = service.db.prepare(
      'SELECT expires_at FROM platform_sessions WHERE token_hash = ?',
    ).get(createHash('sha256').update(token).digest('hex')) as { expires_at: number };

    expect(user?.id).toBe('sr_platform_user');
    expect(after.expires_at).toBeGreaterThanOrEqual(before.expires_at);
  });
});
