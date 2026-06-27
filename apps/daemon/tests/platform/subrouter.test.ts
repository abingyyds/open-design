import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('requires_openai_auth = true');
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
});
