import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubrouterPlatform } from '../../src/platform/subrouter.js';
import { sendHostedResponses } from '../../src/platform/hosted-task-credentials.js';

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
      'gpt-5.4',
      timestamp,
      timestamp,
    );
    return platform;
  }

  it('prepares a hosted login without provisioning or refreshing a model key', async () => {
    const service = createPlatformUser();
    const provision = vi.spyOn(service, 'ensureSubrouterKey');
    const login = { external_user_id: 'fixture-id', username: 'fixture-user', base_url: 'https://subrouter.example.com' };
    const first = await service.prepareAccount(login, 'fixture-user');
    expect(first).toMatchObject({
      user: { username: 'fixture-user', account: { configured: false } },
      models: [], defaultModel: '',
    });
    const existing = { key: 'fixture-existing-key', id: 'fixture-existing-key-id', model: 'gpt-5.4' };
    service.db.prepare('UPDATE platform_users SET subrouter_api_key = ?, subrouter_api_key_id = ?, default_model = ? WHERE id = ?')
      .run(existing.key, existing.id, existing.model, first.user!.id);
    const returning = await service.prepareAccount(login, 'fixture-user');
    expect(returning.user?.id).toBe(first.user?.id);
    expect(service.db.prepare('SELECT subrouter_api_key AS key, subrouter_api_key_id AS id, default_model AS model FROM platform_users WHERE id = ?')
      .get(first.user!.id)).toEqual(existing);
    expect(provision).not.toHaveBeenCalled();
  });

  it('resolves the selected model without creating a task home on the daemon', () => {
    const service = createPlatformUser();
    expect(service.modelForUser('sr_platform_user')).toBe('gpt-5.4');
    service.setDefaultModel('sr_platform_user', 'gpt-5.5');
    expect(service.modelForUser('sr_platform_user')).toBe('gpt-5.5');
    expect(existsSync(join(service.dataDir, 'users'))).toBe(false);
  });

  it('requires a platform session before allocating a hosted task', async () => {
    const service = createPlatformUser();
    const request = { headers: { cookie: 'od_platform_session=invalid' } } as Request;
    await expect(service.runTaskForRequest(request, { image: '', prompt: 'test' })).rejects.toMatchObject({
      code: 'PLATFORM_LOGIN_REQUIRED',
    });
  });

  it.each([
    ['https://gateway.example.test/v1', 'https://gateway.example.test/v1/responses'],
    ['https://gateway.example.test/models/tenant/v1/', 'https://gateway.example.test/models/tenant/v1/responses'],
  ])('appends Responses to the configured gateway URL %s', async (baseUrl, expectedUrl) => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
    try {
      await sendHostedResponses(baseUrl, 'sk-fixture-key', 'gpt-5.4', {}, new AbortController().signal);
      expect(mock).toHaveBeenCalledWith(new URL(expectedUrl), expect.objectContaining({
        method: 'POST', redirect: 'error',
      }));
    } finally {
      mock.mockRestore();
    }
  });

  it('redacts a credential split across upstream response chunks', async () => {
    const key = 'sk-synthetic-hosted-key';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const part of ['prefix sk-synt', 'hetic-hosted', '-key suffix']) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(stream));
    try {
      const result = await sendHostedResponses(
        'https://gateway.example.com/v1', key, 'gpt-5.4', { model: 'untrusted' }, new AbortController().signal,
      );
      expect(mock).toHaveBeenCalledWith(new URL('https://gateway.example.com/v1/responses'), expect.objectContaining({
        redirect: 'error', body: '{"model":"gpt-5.4","store":false,"background":false}',
      }));
      await expect(result.text()).resolves.toBe('prefix [redacted] suffix');
    } finally {
      mock.mockRestore();
    }
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

  it('forwards an optional Turnstile token to SubRouter login', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { id: 'external-1', username: 'alice' },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=abc; Path=/; HttpOnly',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notFound: true }), { status: 404 }));

    await service.loginSubrouter(
      'https://subrouter.example.com',
      'alice',
      'password',
      undefined,
      'captcha-token',
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://subrouter.example.com/api/user/login?turnstile=captcha-token',
    );
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

  it('only exposes Responses-compatible models and prefers GPT over Claude', async () => {
    const service = createPlatformUser();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: true,
        data: [
          { model_name: 'claude-sonnet-4-20250514', category: 'chat' },
          { model_name: 'gpt-5.5', category: 'chat' },
          { model_name: 'deepseek-chat', category: 'chat' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await service.fetchModels('sr_platform_user');

    expect(result.models.map((model) => model.id)).toEqual(['gpt-5.5']);
    expect(result.defaultModel).toBe('gpt-5.5');
    expect(service.rowForUser('sr_platform_user').default_model).toBe('gpt-5.5');
    fetchMock.mockRestore();
  });

  it('allows an explicitly configured Responses-compatible model id', async () => {
    const service = createPlatformUser();
    service.env.OD_SUBROUTER_RESPONSES_MODELS = 'claude-sonnet-4-20250514';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: true,
        data: [{ model_name: 'claude-sonnet-4-20250514', category: 'chat' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await service.fetchModels('sr_platform_user');

    expect(result.models.map((model) => model.id)).toEqual(['claude-sonnet-4-20250514']);
    fetchMock.mockRestore();
  });

  it('fails clearly when a platform account has no selected text model', () => {
    const service = createPlatformUser();
    service.db.prepare('UPDATE platform_users SET default_model = ? WHERE id = ?')
      .run('', 'sr_platform_user');

    expect(() => service.modelForUser('sr_platform_user')).toThrowError(
      expect.objectContaining({ code: 'NO_MODELS_AVAILABLE' }),
    );
  });

  it('rejects a Chat Completions-only model before Codex can send Responses traffic', () => {
    const service = createPlatformUser();
    service.db.prepare('UPDATE platform_users SET default_model = ? WHERE id = ?')
      .run('claude-sonnet-4-20250514', 'sr_platform_user');

    expect(() => service.modelForUser('sr_platform_user')).toThrowError(
      expect.objectContaining({ code: 'MODEL_UNSUPPORTED_FOR_CODEX' }),
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
    expect(result.defaultModel).toBe('gpt-5.4');
    expect(service.rowForUser('sr_platform_user').default_model).toBe('gpt-5.4');
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
