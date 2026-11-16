import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredProjectDirName } from '../project-ignored-dirs.js';
import { requestLimit } from './hosted-task-wire.js';

export const hostedFileLimit = requestLimit;
const totalFileBytes = 32 * 1024 * 1024;
const maxFiles = 256;
const maxEntries = 4096;

export function isHostedFileName(name: string): boolean {
  const parts = name.split('/');
  return Buffer.byteLength(name) <= 512 && parts.length <= 32
    && parts.every((part) => /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u.test(part))
    && !parts.slice(0, -1).some(isIgnoredProjectDirName)
    && !name.endsWith('.artifact.json');
}

export class HostedTaskFiles extends Map<string, Buffer> {
  private bytes = 0;

  add(name: string, content: Buffer): void {
    if (!isHostedFileName(name) || this.has(name)) throw new Error('Invalid hosted file path');
    if (this.size >= maxFiles || content.length > hostedFileLimit || this.bytes + content.length > totalFileBytes) {
      throw new Error('Hosted workspace exceeds the file transfer limit');
    }
    this.set(name, content);
    this.bytes += content.length;
  }

  receive(name: string, data: string): Buffer {
    const content = Buffer.from(data, 'base64');
    if (content.toString('base64') !== data) throw new Error('Invalid hosted file content');
    this.add(name, content);
    return content;
  }
}

export async function readHostedFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > hostedFileLimit) {
      throw new Error('Unsupported hosted workspace file');
    }
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Hosted workspace file changed during transfer');
    return data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function collectHostedFiles(root: string, signal?: AbortSignal): Promise<HostedTaskFiles> {
  const files = new HostedTaskFiles();
  let entries = 0;

  async function collect(dir: string, prefix: string): Promise<void> {
    for await (const entry of await opendir(dir)) {
      signal?.throwIfAborted();
      if (++entries > maxEntries) throw new Error('Hosted workspace has too many entries');
      const name = prefix + entry.name;
      if (!isHostedFileName(name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !isIgnoredProjectDirName(entry.name)) {
        await collect(file, name + '/');
      } else if (entry.isFile()) {
        // Ignore links and special files. Tasks exchange only regular file bytes.
        const stat = await lstat(file);
        if (stat.isFile() && stat.nlink === 1) files.add(name, await readHostedFile(file));
      }
    }
  }

  await collect(root, '');
  return files;
}
