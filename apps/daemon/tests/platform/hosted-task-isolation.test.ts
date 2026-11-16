import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import type { StartServerResult } from '../../src/server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { SubrouterPlatform } from '../../src/platform/subrouter.js';

// Lift only the local test listener's startup gate. Actual authentication,
// project routes, run streaming, cancellation, and Docker are used below.
vi.mock(import('../../src/platform/deployment.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  hostedMaintenanceRequired: () => false,
}));

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

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workerContainerIds() {
  return execFileSync('docker', ['ps', '-aq', '--filter', 'name=od-hosted-task-'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).sort();
}

describe.skipIf(!image)('hosted chat over HTTP', () => {
  it('streams and publishes two isolated projects and cleans up canceled and failed tasks', async () => {
    const names = ['alpha', 'beta'];
    const sessions = new Map<string, string>();
    const projects = new Map<string, { id: string; conversationId: string }>();
    const turns = new Map<string, number>();
    const errors: unknown[] = [];
    const releaseSuccess = latch();
    const waitingForCancel = latch();
    const upstreamClosed = latch();
    const existingContainers = workerContainerIds();
    let daemon: StartServerResult | undefined;
    let phase = 'fixture setup';
    const dataDir = process.env.OD_DATA_DIR!;
    const gateway = createServer((req, res) => {
      void (async () => {
        expect(req.url).toBe('/model-gateway/v1/responses');
        const owner = names.find((name) => req.headers.authorization === `Bearer sk-http-fixture-${name}`);
        if (!owner) throw new Error('Unrecognized fixture credential');
        let data = '';
        for await (const chunk of req) data += chunk.toString();
        const body = JSON.parse(data);
        const mode = Array.from(data.matchAll(/http-(success|cancel|fail)-(alpha|beta)/g))
          .filter((match) => match[2] === owner).at(-1)?.[1];
        if (!mode) throw new Error('Unrecognized fixture turn');
        expect(body.model).toBe('gpt-5.4');
        expect(body.store).toBe(false);
        const id = `${mode}-${owner}`;
        const turn = (turns.get(id) ?? 0) + 1;
        turns.set(id, turn);

        if (turn === 1) {
          const command = [
            `test "$(cat input.txt)" = fixture-${owner}`,
            'mkdir -p output',
            `printf '%s' artifact-${owner} > output/${mode}.txt`,
            `printf '%s' streamed-${id}`,
          ].join(' && ');
          const tools = body.tools as Array<{ type: string; name?: string }>;
          const tool = tools.find((entry) => entry.name === 'exec_command' || entry.name === 'shell');
          if (!tool?.name) throw new Error('Missing fixture command tool');
          sendMockTurn(res, turn, {
            type: 'function_call', call_id: 'call_fixture', id: 'fc_fixture', name: tool.name,
            arguments: JSON.stringify(tool.name === 'shell'
              ? { command: ['/bin/sh', '-c', command] }
              : { cmd: command, shell: '/bin/sh', login: false }),
          });
          return;
        }
        const output = (body.input as Array<{ type: string; output?: string }>)
          .find((item) => item.type === 'function_call_output');
        expect(output?.output).toContain(`streamed-${id}`);
        if (mode === 'cancel') {
          res.once('close', () => upstreamClosed.resolve());
          waitingForCancel.resolve();
        } else if (mode === 'fail') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":{"message":"Synthetic fixture failure"}}');
        } else {
          await releaseSuccess.promise;
          if (!res.destroyed) {
            sendMockTurn(res, turn, {
              id: 'msg_fixture', type: 'message', role: 'assistant',
              content: [{ type: 'output_text', text: `result-${owner}`, annotations: [] }],
            });
          }
        }
      })().catch((error) => {
        errors.push(error);
        if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
      });
    });

    const request = (owner: string, route: string, method = 'GET', body?: object) =>
      fetch(new URL(route, daemon!.url), {
        method,
        headers: { Cookie: `od_platform_session=${sessions.get(owner)}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : null,
        signal: AbortSignal.timeout(30_000),
      });
    function runBody(owner: string, mode: string) {
      const project = projects.get(owner)!;
      return { projectId: project.id, conversationId: project.conversationId, message: `http-${mode}-${owner}` };
    }
    async function createRun(owner: string, mode: string) {
      const response = await request(owner, '/api/runs', 'POST', runBody(owner, mode));
      expect(response.status).toBe(202);
      return (await response.json() as { runId: string }).runId;
    }
    async function file(owner: string, name: string, projectOwner = owner) {
      return request(owner, `/api/projects/${projects.get(projectOwner)!.id}/files/${name}`);
    }

    try {
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const address = gateway.address();
      if (!address || typeof address === 'string') throw new Error('No project fixture gateway');

      vi.stubEnv('OD_PLATFORM_ENABLED', '1');
      vi.stubEnv('OD_HOSTED_WORKER_IMAGE', image);
      vi.stubEnv('OD_SUBROUTER_GATEWAY_BASE_URL', `http://127.0.0.1:${address.port}/model-gateway`);
      const platform = new SubrouterPlatform(dataDir);
      try {
        const insert = platform.db.prepare(`
          INSERT INTO platform_users (id, username, subrouter_api_key, default_model, created_at, updated_at)
          VALUES (?, ?, ?, 'gpt-5.4', ?, ?)
        `);
        for (const owner of names) {
          insert.run(owner, owner, `sk-http-fixture-${owner}`, Date.now(), Date.now());
          sessions.set(owner, platform.createSession(owner));
        }
      } finally {
        platform.db.close();
      }
      const { startServer } = await import('../../src/server.js');
      daemon = await startServer({ host: '127.0.0.1', port: 0, returnServer: true }) as StartServerResult;
      for (const owner of names) {
        const id = `hosted-chat-${owner}`;
        const created = await request(owner, '/api/projects', 'POST', { id, name: owner });
        expect(created.status).toBe(200);
        const { conversationId } = await created.json() as { conversationId: string };
        projects.set(owner, { id, conversationId });
        expect((await request(owner, `/api/projects/${id}/files`, 'POST', {
          name: 'input.txt', content: `fixture-${owner}`,
        })).ok).toBe(true);
      }

      expect((await request('alpha', '/api/runs', 'POST', runBody('beta', 'success'))).status).toBe(404);
      expect((await request('alpha', '/api/runs', 'POST', {
        ...runBody('alpha', 'success'), conversationId: projects.get('beta')!.conversationId,
      })).status).toBe(404);
      phase = 'concurrent streaming';
      const runIds = await Promise.all(names.map((owner) => createRun(owner, 'success')));
      expect((await request('beta', `/api/runs/${runIds[0]}/events`)).status).toBe(404);
      expect((await request('beta', `/api/runs/${runIds[0]}/cancel`, 'POST')).status).toBe(404);
      const readers = await Promise.all(names.map(async (owner, i) => {
        const events = await request(owner, `/api/runs/${runIds[i]}/events`);
        expect(events.status).toBe(200);
        const reader = events.body!.getReader();
        const decoder = new TextDecoder();
        let observed = '';
        while (!observed.includes('"type":"tool_result"') || !observed.includes(`streamed-success-${owner}`)) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Run ended before emitting progress');
          observed += decoder.decode(value, { stream: true });
        }
        expect(observed).not.toContain('"status":"succeeded"');
        expect((await file(owner, 'output/success.txt')).status).toBe(404);
        return async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            observed += decoder.decode(value, { stream: true });
          }
          return observed + decoder.decode();
        };
      }));
      releaseSuccess.resolve();
      const events = await Promise.all(readers.map((read) => read()));
      for (const [i, owner] of names.entries()) {
        expect(events[i]).toContain(`result-${owner}`);
        expect(events[i]).toContain('"status":"succeeded"');
        expect(events[i]).not.toContain(`result-${names[1 - i]}`);
        expect(events[i]).not.toContain('sk-http-fixture-');
        await expect((await file(owner, 'output/success.txt')).text()).resolves.toBe(`artifact-${owner}`);
        const { id, conversationId } = projects.get(owner)!;
        const messages = await request(owner, `/api/projects/${id}/conversations/${conversationId}/messages`);
        expect(messages.status).toBe(200);
        await expect(messages.json()).resolves.toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: `http-success-${owner}` }),
            expect.objectContaining({ role: 'assistant', content: `result-${owner}`, runStatus: 'succeeded' }),
          ]),
        });
      }
      expect((await file('alpha', 'output/success.txt', 'beta')).status).toBe(404);

      phase = 'cancellation';
      const cancelId = await createRun('alpha', 'cancel');
      await Promise.race([waitingForCancel.promise, setTimeout(20_000, null, { ref: false }).then(() => {
        throw new Error('Hosted task did not reach upstream before cancellation');
      })]);
      const canceled = await request('alpha', `/api/runs/${cancelId}/cancel`, 'POST');
      await expect(canceled.json()).resolves.toMatchObject({ run: { status: 'canceled' } });
      await Promise.race([upstreamClosed.promise, setTimeout(15_000, null, { ref: false }).then(() => {
        throw new Error('Canceled hosted task did not close upstream');
      })]);
      expect((await file('alpha', 'output/cancel.txt')).status).toBe(404);
      expect(workerContainerIds()).toEqual(existingContainers);

      phase = 'worker failure';
      const failure = await request('beta', '/api/chat', 'POST', runBody('beta', 'fail'));
      expect(failure.status).toBe(200);
      const failedEvents = await failure.text();
      expect(failedEvents).toContain('streamed-fail-beta');
      expect(failedEvents).toContain('"status":"failed"');
      expect((await file('beta', 'output/fail.txt')).status).toBe(404);
      expect(workerContainerIds()).toEqual(existingContainers);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`Hosted chat fixture failed during ${phase} (${JSON.stringify(Array.from(turns))})`, {
        cause: errors[0] ?? error,
      });
    } finally {
      releaseSuccess.resolve();
      if (daemon) {
        await daemon.shutdown();
        daemon.server.closeAllConnections();
        await new Promise<void>((resolve) => daemon!.server.close(() => resolve()));
      }
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  }, 90_000);
});
