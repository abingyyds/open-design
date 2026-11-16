import type { Readable, Writable } from 'node:stream';

export const requestLimit = 4 * 1024 * 1024;
const frameLimit = 6 * 1024 * 1024;

type DaemonFrame =
  | { type: 'start'; model: string; prompt: string }
  | { type: 'input'; name: string; data: string }
  | { type: 'inputs_end' }
  | { type: 'head'; status: number; contentType: string }
  | { type: 'data'; data: string }
  | { type: 'end' };

type WorkerFrame =
  | { type: 'stdout' | 'stderr'; text: string }
  | { type: 'responses'; body: string }
  | { type: 'artifact'; name: string; data: string }
  | { type: 'exit'; code: number };

function isDaemonFrame(frame: Record<string, unknown>): frame is DaemonFrame {
  switch (frame.type) {
    case 'start': return typeof frame.model === 'string' && typeof frame.prompt === 'string';
    case 'input': return typeof frame.name === 'string' && typeof frame.data === 'string';
    case 'inputs_end': return true;
    case 'head': return Number.isInteger(frame.status) && typeof frame.contentType === 'string';
    case 'data': return typeof frame.data === 'string';
    case 'end': return true;
    default: return false;
  }
}

function isWorkerFrame(frame: Record<string, unknown>): frame is WorkerFrame {
  switch (frame.type) {
    case 'stdout':
    case 'stderr': return typeof frame.text === 'string';
    case 'responses': return typeof frame.body === 'string';
    case 'artifact': return typeof frame.name === 'string' && typeof frame.data === 'string';
    case 'exit': return Number.isInteger(frame.code);
    default: return false;
  }
}

async function* readFrames<Frame extends Record<string, unknown>>(
  stream: Readable,
  validate: (frame: Record<string, unknown>) => frame is Frame,
): AsyncGenerator<Frame> {
  let pending = Buffer.alloc(0);
  for await (const data of stream) {
    const chunk = Buffer.from(data);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (pending.length + end - start > frameLimit) throw new Error('Hosted task frame is too large');
      pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      if (newline === -1) break;
      const value: unknown = JSON.parse(pending.toString('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid hosted task frame');
      }
      const frame = value as Record<string, unknown>;
      if (!validate(frame)) throw new Error('Invalid hosted task frame');
      yield frame;
      start = end + 1;
      pending = Buffer.alloc(0);
    }
  }
  if (pending.length !== 0) throw new Error('Truncated hosted task frame');
}

function writeFrame(stream: Writable, frame: DaemonFrame | WorkerFrame): Promise<void> {
  const data = JSON.stringify(frame);
  if (Buffer.byteLength(data) > frameLimit) throw new Error('Hosted task frame is too large');
  return new Promise((resolve, reject) => {
    stream.write(data + '\n', (err) => err ? reject(err) : resolve());
  });
}

export function readDaemonFrames(stream: Readable) {
  return readFrames<DaemonFrame>(stream, isDaemonFrame);
}

export function readWorkerFrames(stream: Readable) {
  return readFrames<WorkerFrame>(stream, isWorkerFrame);
}

export function writeDaemonFrame(stream: Writable, frame: DaemonFrame) {
  return writeFrame(stream, frame);
}

export function writeWorkerFrame(stream: Writable, frame: WorkerFrame) {
  return writeFrame(stream, frame);
}
