import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHostedFiles } from '../../src/platform/hosted-task-files.js';
import { publishHostedArtifacts } from '../../src/platform/hosted-task-project.js';

describe('hosted project transfer', () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-hosted-project-'));
    project = path.join(root, 'project');
    await mkdir(project);
    await writeFile(path.join(project, 'original.txt'), 'original');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies only visible regular project files', async () => {
    await mkdir(path.join(project, 'build'));
    await writeFile(path.join(project, 'build', 'generated.txt'), 'ignored');
    await writeFile(path.join(project, '.hidden'), 'ignored');
    await writeFile(path.join(root, 'other.txt'), 'unrelated fixture');
    await symlink(path.join(root, 'other.txt'), path.join(project, 'link.txt'));
    expect(Array.from(await collectHostedFiles(project))).toEqual([['original.txt', Buffer.from('original')]]);
  });

  it('rolls back publication when another edit has changed one of the destinations', async () => {
    const original = await collectHostedFiles(project);
    await writeFile(path.join(project, 'original.txt'), 'concurrent edit');
    const artifacts = new Map([
      ['new/output.txt', Buffer.from('pending artifact')],
      ['original.txt', Buffer.from('worker edit')],
    ]);
    await expect(publishHostedArtifacts(project, original, artifacts, () => {}, new AbortController().signal))
      .rejects.toThrow('Project files changed');
    expect(await readdir(root)).toEqual(['project']);
    expect(await readdir(project)).toEqual(['original.txt']);
    expect(await readFile(path.join(project, 'original.txt'), 'utf8')).toBe('concurrent edit');
  });

  it('does not publish when canceled or the project authorization has changed', async () => {
    const original = await collectHostedFiles(project);
    const artifacts = new Map([['new.txt', Buffer.from('pending artifact')]]);
    await expect(publishHostedArtifacts(project, original, artifacts, () => {}, AbortSignal.abort()))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(publishHostedArtifacts(project, original, artifacts, () => {
      throw new Error('Project no longer available');
    }, new AbortController().signal)).rejects.toThrow('Project no longer available');
    expect(await readdir(root)).toEqual(['project']);
    expect(await readdir(project)).toEqual(['original.txt']);
  });
});
