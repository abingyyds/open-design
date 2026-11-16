import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { HostedTaskFiles } from './hosted-task-files.js';
import { readWorkerFrames, requestLimit, writeDaemonFrame } from './hosted-task-wire.js';

export type HostedResponses = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;

export interface HostedTask {
  /** Local image ID supplied by the trusted operator. */
  image: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  files?: ReadonlyMap<string, Buffer>;
  onStdout?: (text: string) => void;
}

const runTool = promisify(execFile);
const maxOutput = 2 * 1024 * 1024;
const maxProviderRequests = 24;
const workerTmp = '/tmp';

export async function runHostedTask(task: HostedTask, responses: HostedResponses) {
  if (!/^sha256:[a-f0-9]{64}$/.test(task.image)) throw new Error('Expected an immutable hosted worker image ID');
  if (!task.prompt || Buffer.byteLength(task.prompt) > 1024 * 1024) throw new Error('Invalid hosted task prompt');
  const transport = new AbortController();
  const signal = AbortSignal.any([transport.signal, AbortSignal.timeout(180_000), ...(task.signal ? [task.signal] : [])]);
  signal.throwIfAborted();
  const name = `od-hosted-task-${randomUUID()}`;
  const child = spawn('docker', [
    'run', '--pull=never', '--rm', '--init', '--interactive', '--name', name,
    '--network=none', '--ipc=private', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user=1000:1000', '--pids-limit=128', '--memory=768m', '--cpus=1',
    '--tmpfs', `${workerTmp}:rw,nosuid,nodev,size=128m,mode=1777`,
    '--env', `OD_DATA_DIR=${workerTmp}/open-design-task`,
    task.image,
  ], { stdio: ['pipe', 'pipe', 'pipe'], signal });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  // Docker can close the input pipe while a response is in flight.
  child.stdin.on('error', () => {});
  child.stderr.resume();
  void exited.catch(() => {});
  const artifacts = new HostedTaskFiles();
  let stdout = '';
  let stderr = '';
  let requests = 0;
  let exitCode: number | null = null;
  let outputBytes = 0;
  let completed = false;
  let delivery: Promise<void> | null = null;

  async function deliverResponses(body: Record<string, unknown>): Promise<void> {
    const response = await responses(body, signal);
    const type = response.headers.get('content-type')?.split(';', 1)[0];
    await writeDaemonFrame(child.stdin, {
      type: 'head', status: response.status,
      contentType: type === 'text/event-stream' ? type : 'application/json',
    });
    if (response.body) {
      const reader = response.body.getReader();
      let responseBytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          responseBytes += value.length;
          if (responseBytes > 16 * 1024 * 1024) throw new Error('Hosted model response is too large');
          await writeDaemonFrame(child.stdin, { type: 'data', data: Buffer.from(value).toString('base64') });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    await writeDaemonFrame(child.stdin, { type: 'end' });
  }

  try {
    await writeDaemonFrame(child.stdin, { type: 'start', model: task.model, prompt: task.prompt });
    for (const [file, content] of task.files ?? []) {
      signal.throwIfAborted();
      await writeDaemonFrame(child.stdin, { type: 'input', name: file, data: content.toString('base64') });
    }
    await writeDaemonFrame(child.stdin, { type: 'inputs_end' });
    for await (const frame of readWorkerFrames(child.stdout)) {
      signal.throwIfAborted();
      if (exitCode !== null) throw new Error('Unexpected frame after hosted task exit');
      switch (frame.type) {
        case 'stdout':
        case 'stderr': {
          outputBytes += Buffer.byteLength(frame.text);
          if (outputBytes > maxOutput) throw new Error('Hosted task output limit exceeded');
          if (frame.type === 'stdout') {
            stdout += frame.text;
            task.onStdout?.(frame.text);
          } else {
            stderr += frame.text;
          }
          break;
        }
        case 'artifact':
          artifacts.receive(frame.name, frame.data);
          break;
        case 'exit':
          exitCode = frame.code;
          break;
        case 'responses': {
          if (++requests > maxProviderRequests) throw new Error('Hosted task model request limit exceeded');
          if (Buffer.byteLength(frame.body) > requestLimit) {
            throw new Error('Invalid hosted model request');
          }
          const body: unknown = JSON.parse(frame.body);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Error('Invalid hosted model request');
          }
          if (delivery) throw new Error('A hosted model request is already in progress');
          delivery = deliverResponses(body as Record<string, unknown>)
            .catch((error) => { transport.abort(error); })
            .finally(() => { delivery = null; });
          break;
        }
      }
    }
    const dockerExit = await exited;
    if (delivery) throw new Error('Hosted worker exited during a model request');
    signal.throwIfAborted();
    if (dockerExit !== 0 || exitCode === null) throw new Error('Hosted worker stopped before reporting completion');
    completed = true;
    return { code: exitCode, stdout, stderr, artifacts };
  } finally {
    transport.abort();
    child.stdin.destroy();
    await delivery;
    if (!completed) {
      await runTool('docker', ['rm', '--force', name], { timeout: 10_000 }).catch(() => {});
      if (child.exitCode === null) child.kill();
    }
  }
}
