// This entry point runs inside the task's container. The daemon speaks to it
// through stdio. Its HTTP server is reachable only on the container's loopback.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { collectHostedFiles, HostedTaskFiles } from './hosted-task-files.js';
import { readDaemonFrames, requestLimit, writeWorkerFrame } from './hosted-task-wire.js';

async function run() {
  const frames = readDaemonFrames(process.stdin);
  const { value: start } = await frames.next();
  if (start?.type !== 'start') {
    throw new Error('Invalid hosted task start');
  }
  const root = process.env.OD_DATA_DIR;
  if (!root || !isAbsolute(root)) throw new Error('Hosted worker data root is required');
  const work = join(root, 'workspace');
  const home = join(root, 'home');
  await Promise.all([mkdir(work, { recursive: true }), mkdir(home, { recursive: true })]);

  const original = new HostedTaskFiles();
  for (;;) {
    const { value } = await frames.next();
    if (value?.type === 'inputs_end') break;
    if (value?.type !== 'input') throw new Error('Missing hosted task inputs');
    const data = original.receive(value.name, value.data);
    const file = join(work, value.name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' });
  }

  let pending: ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    if (pending) {
      response.writeHead(429).end();
      return;
    }
    pending = response;
    let forwarded = false;
    void (async () => {
      const parts: Buffer[] = [];
      let received = 0;
      for await (const data of request) {
        const chunk = Buffer.from(data);
        received += chunk.length;
        if (received > requestLimit) {
          response.writeHead(413).end();
          return;
        }
        parts.push(chunk);
      }
      await writeWorkerFrame(process.stdout, { type: 'responses', body: Buffer.concat(parts).toString('utf8') });
      forwarded = true;
    })().catch(() => {
      // A broken transport ends the only model channel for this task.
      response.destroy();
    }).finally(() => {
      // Successful requests keep their slot until the daemon finishes streaming.
      if (!forwarded && pending === response) pending = undefined;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Hosted task loopback listener failed');
  await writeFile(join(home, 'config.toml'), [
    'model_provider = "open_design_task"',
    `model = ${JSON.stringify(start.model)}`,
    'approval_policy = "never"',
    'disable_response_storage = true',
    '[model_providers.open_design_task]',
    'name = "Open Design Task"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'env_key = "OD_TASK_MODEL_TRANSPORT"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
  ].join('\n') + '\n');

  // The container is the sandbox. Its environment contains no host secrets.
  const child = spawn('/usr/local/bin/codex', [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-',
  ], {
    cwd: work,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: home, OD_DATA_DIR: root,
      OD_TASK_MODEL_TRANSPORT: 'container-loopback',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(start.prompt);
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  async function forward(stream: NodeJS.ReadableStream, type: 'stdout' | 'stderr') {
    stream.setEncoding('utf8');
    for await (const chunk of stream) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      await writeWorkerFrame(process.stdout, { type, text });
    }
  }
  const completed = Promise.all([exited, forward(child.stdout, 'stdout'), forward(child.stderr, 'stderr')]);
  try {
    const receive = async (): Promise<never> => {
      for await (const frame of frames) {
        if (!pending) throw new Error('Unexpected model response');
        if (frame.type === 'head') {
          if (!pending.destroyed) pending.writeHead(frame.status, { 'Content-Type': frame.contentType });
        } else if (frame.type === 'data') {
          if (!pending.destroyed) {
            await new Promise<void>((resolve) => pending!.write(Buffer.from(frame.data, 'base64'), () => resolve()));
          }
        } else if (frame.type === 'end') {
          pending.end();
          pending = undefined;
        } else {
          throw new Error('Invalid hosted model response');
        }
      }
      throw new Error('Hosted task transport disconnected');
    };
    const [code] = await Promise.race([completed, receive()]);
    if (code === 0) {
      for (const [name, data] of await collectHostedFiles(work)) {
        if (!original.get(name)?.equals(data)) {
          await writeWorkerFrame(process.stdout, { type: 'artifact', name, data: data.toString('base64') });
        }
      }
    }
    await writeWorkerFrame(process.stdout, { type: 'exit', code });
  } finally {
    child.kill('SIGTERM');
    server.closeAllConnections();
    server.close();
    process.stdin.destroy();
  }
}

void run().catch(() => {
  // Only a fixed marker leaves the worker on protocol/startup failures.
  process.stderr.write('Hosted worker failed\n');
  process.exit(1);
});
