import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readDaemonFrames, readWorkerFrames, writeDaemonFrame, writeWorkerFrame } from '../../src/platform/hosted-task-wire.js';

async function collect<Frame>(frames: AsyncIterable<Frame>): Promise<Frame[]> {
  const result: Frame[] = [];
  for await (const frame of frames) result.push(frame);
  return result;
}

describe('hosted task IPC', () => {
  it('round-trips both directions through the real codecs', async () => {
    const daemon = new PassThrough();
    const worker = new PassThrough();
    const daemonFrames = [
      { type: 'start', model: 'fixture-model', prompt: 'fixture' },
      { type: 'input', name: 'input.txt', data: 'Zml4dHVyZQ==' },
      { type: 'inputs_end' },
      { type: 'head', status: 200, contentType: 'text/event-stream' },
      { type: 'data', data: 'Zml4dHVyZQ==' },
      { type: 'end' },
    ] as const;
    const workerFrames = [
      { type: 'responses', body: '{}' },
      { type: 'stdout', text: 'fixture' },
      { type: 'stderr', text: 'test output' },
      { type: 'artifact', name: 'output.txt', data: 'Zml4dHVyZQ==' },
      { type: 'exit', code: 0 },
    ] as const;
    for (const frame of daemonFrames) await writeDaemonFrame(daemon, frame);
    for (const frame of workerFrames) await writeWorkerFrame(worker, frame);
    daemon.end();
    worker.end();

    await expect(collect(readDaemonFrames(daemon))).resolves.toEqual(daemonFrames);
    await expect(collect(readWorkerFrames(worker))).resolves.toEqual(workerFrames);
  });

  it('reassembles fragmented frames and reads multiple frames per chunk', async () => {
    const stream = Readable.from(['{"type":"std', 'out","text":"hello"}\n{"type":"exit","code":0}\n']);
    await expect(collect(readWorkerFrames(stream))).resolves.toEqual([
      { type: 'stdout', text: 'hello' }, { type: 'exit', code: 0 },
    ]);
  });

  it.each([
    '{"type":"start","model":"wrong-direction","prompt":"fixture"}\n',
    '{"type":"responses"}\n',
    '{"type":"exit","code":1.5}\n',
    '[]\n',
    'not json\n',
  ])('rejects invalid worker input', async (input) => {
    await expect(collect(readWorkerFrames(Readable.from([input])))).rejects.toThrow();
  });

  it('rejects malformed daemon input', async () => {
    const stream = Readable.from(['{"type":"head","status":"200","contentType":"text/event-stream"}\n']);
    await expect(collect(readDaemonFrames(stream))).rejects.toThrow('Invalid hosted task frame');
  });

  it('rejects truncated frames', async () => {
    const stream = Readable.from(['{"type":"exit","code":0}']);
    await expect(collect(readWorkerFrames(stream))).rejects.toThrow('Truncated hosted task frame');
  });

  it('bounds frames before decoding and before sending', async () => {
    const chunk = Buffer.alloc(4 * 1024 * 1024, 'x');
    await expect(collect(readWorkerFrames(Readable.from([chunk, chunk])))).rejects.toThrow('Hosted task frame is too large');

    const stream = new PassThrough();
    expect(() => writeWorkerFrame(stream, { type: 'stdout', text: 'x'.repeat(7 * 1024 * 1024) }))
      .toThrow('Hosted task frame is too large');
    stream.destroy();
  });
});
