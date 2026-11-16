import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { SubrouterPlatform } from '../../src/platform/subrouter.js';

const image = process.env.OD_HOSTED_TEST_IMAGE;
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function sendMockTurn(res: ServerResponse, turn: number, item: object) {
  const id = `resp_fixture_${turn}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, output: [item] } },
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

describe.skipIf(!image)('hosted task container boundary', () => {
  it('isolates concurrent authenticated tasks and keeps both users’ keys at the daemon', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'od-hosted-isolation-'));
    const fixturePath = join(dataDir, 'platform.sqlite3');
    const credentials = new Map([
      ['sk-hosted-isolation-key-alpha', { owner: 'alpha', model: 'gpt-5.4' }],
      ['sk-hosted-isolation-key-beta', { owner: 'beta', model: 'gpt-5.5' }],
    ]);
    const turns = new Map<string, number>();
    const outputs = new Set<string>();
    const errors: unknown[] = [];
    vi.stubEnv('OD_ISOLATION_PARENT_MARKER', 'host-only-fixture');
    const gateway = createServer((req, res) => {
      void (async () => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/model-gateway/v1/responses');
        const key = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const account = credentials.get(key);
        if (!account) throw new Error('Wrong fixture owner credential');
        let data = '';
        for await (const chunk of req) data += chunk.toString();
        const body = JSON.parse(data);
        expect(body.model).toBe(account.model);
        expect(body.store).toBe(false);
        const count = (turns.get(key) ?? 0) + 1;
        turns.set(key, count);
        if (count === 1) {
          expect(data).toContain(`isolation prompt for ${account.owner}`);
          const command = [
            `test ! -e ${shellQuote(fixturePath)}`,
            'test ! -e /var/run/docker.sock',
            'test -z "$OD_ISOLATION_PARENT_MARKER$SQL_DSN$OPENAI_API_KEY$CODEX_API_KEY"',
            'node -e \'if (Object.values(require("node:os").networkInterfaces()).flat().some(x => !x.internal)) process.exit(1)\'',
            'test -n "$OD_DATA_DIR" && test "$CODEX_HOME" = "$OD_DATA_DIR/home" && test "$(pwd)" = "$OD_DATA_DIR/workspace"',
            'test ! -e /tmp/od-isolation-marker',
            `printf '%s' ${account.owner} > /tmp/od-isolation-marker`,
            'test "$(id -u)" = 1000',
            `test "$(cat /tmp/od-isolation-marker)" = ${account.owner}`,
            `printf '%s' isolation-ok-${account.owner}`,
          ].join(' && ');
          const tools = body.tools as Array<{ type: string; name?: string }>;
          const tool = tools.find((t) => t.name === 'exec_command' || t.name === 'shell');
          if (!tool?.name) throw new Error('No Codex shell tool in fixture request');
          sendMockTurn(res, count, {
            type: 'function_call', call_id: 'call_fixture', id: 'fc_fixture', name: tool.name,
            arguments: JSON.stringify(tool.name === 'shell'
              ? { command: ['/bin/sh', '-c', command] }
              : { cmd: command, shell: '/bin/sh', login: false }),
          });
        } else {
          const toolOutput = (body.input as Array<{ type: string; output?: string }>)
            .find((item) => item.type === 'function_call_output');
          expect(toolOutput?.output).toContain(`isolation-ok-${account.owner}`);
          outputs.add(account.owner);
          sendMockTurn(res, count, {
            id: 'msg_fixture', type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: `Fixture echo ${key}`, annotations: [] }],
          });
        }
      })().catch((error) => {
        errors.push(error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"Fixture rejected request"}}');
      });
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('No fixture gateway address');
    const platform = new SubrouterPlatform(dataDir, {
      OD_PLATFORM_ENABLED: '1',
      OD_SUBROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${address.port}/model-gateway`,
    });
    const abort = new AbortController();
    try {
      const run = ([key, { owner, model }]: [string, { owner: string; model: string }]) => {
        const timestamp = Date.now();
        platform.db.prepare(`
          INSERT INTO platform_users (id, username, subrouter_api_key, default_model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(owner, owner, key, model, timestamp, timestamp);
        const request = { headers: { cookie: `od_platform_session=${platform.createSession(owner)}` } } as Request;
        return platform.runTaskForRequest(request, {
          image: image!, prompt: `isolation prompt for ${owner}`, signal: abort.signal,
        });
      };
      const results = await Promise.all(Array.from(credentials, run));
      expect(errors).toEqual([]);
      expect(outputs).toEqual(new Set(['alpha', 'beta']));
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('[redacted]');
        for (const key of credentials.keys()) expect(result.stdout + result.stderr).not.toContain(key);
      }
    } finally {
      abort.abort();
      platform.db.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
