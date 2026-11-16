import {
  linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync,
} from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeId } from '../projects.js';
import { hostedFileLimit, isHostedFileName } from './hosted-task-files.js';

function statIfExists(file: string) {
  return lstatSync(file, { throwIfNoEntry: false });
}

export async function hostedProjectDirectory(projectsRoot: string, id: string): Promise<string> {
  if (!isSafeId(id)) throw new Error('Invalid hosted project');
  const root = path.join(await realpath(projectsRoot), id);
  if (!statIfExists(root)) {
    try {
      await mkdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!lstatSync(root).isDirectory() || await realpath(root) !== root) {
    throw new Error('Hosted project must use managed storage');
  }
  return root;
}

export async function publishHostedArtifacts(
  dir: string,
  original: ReadonlyMap<string, Buffer>,
  artifacts: ReadonlyMap<string, Buffer>,
  assertProjectOwner: () => void,
  signal: AbortSignal,
): Promise<string[]> {
  if (artifacts.size === 0) return [];
  const stage = await mkdtemp(path.join(path.dirname(dir), '.hosted-artifacts-'));
  const pending: Array<{ name: string; source: string; backup: string }> = [];
  const changed: Array<{ target: string; backup?: string }> = [];
  const createdDirs: string[] = [];
  try {
    for (const [name, data] of artifacts) {
      signal.throwIfAborted();
      if (!isHostedFileName(name)) throw new Error('Invalid hosted artifact');
      const source = path.join(stage, String(pending.length));
      await writeFile(source, data, { flag: 'wx', mode: 0o644, signal });
      pending.push({ name, source, backup: source + '.previous' });
    }

    // Keep the ownership check and commit together. Staging is cancellable.
    // Once publication begins, finish or roll back the whole batch.
    signal.throwIfAborted();
    assertProjectOwner();
    if (!statIfExists(dir)?.isDirectory()) throw new Error('Hosted project is unavailable');
    try {
      for (const { name, source, backup } of pending) {
        const parts = name.split('/');
        let parent = dir;
        for (const part of parts.slice(0, -1)) {
          parent = path.join(parent, part);
          const stat = statIfExists(parent);
          if (!stat) {
            mkdirSync(parent);
            createdDirs.push(parent);
          } else if (!stat.isDirectory()) {
            throw new Error('Invalid hosted artifact directory');
          }
        }
        const target = path.join(parent, parts[parts.length - 1]!);
        const stat = statIfExists(target);
        const previous = original.get(name);
        if (previous) {
          if (!stat?.isFile() || stat.nlink !== 1 || stat.size > hostedFileLimit
            || !previous.equals(readFileSync(target))) {
            throw new Error('Project files changed during the hosted task');
          }
          linkSync(target, backup);
          renameSync(source, target);
          changed.push({ target, backup });
        } else {
          // Link the staged file into place with exclusive create semantics.
          linkSync(source, target);
          changed.push({ target });
          unlinkSync(source);
        }
      }
    } catch (error) {
      for (const { target, backup } of changed.reverse()) {
        if (backup) renameSync(backup, target);
        else unlinkSync(target);
      }
      for (const parent of createdDirs.reverse()) rmdirSync(parent);
      throw error;
    }
    return pending.map(({ name }) => name);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
