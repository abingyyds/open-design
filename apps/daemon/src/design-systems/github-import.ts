import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isRegularDesignSystemTree } from './package-files.js';

import {
  LocalDesignSystemImportError,
  type LocalDesignSystemImportOptions,
  type LocalDesignSystemImportResult,
  importLocalDesignSystemProject,
} from './import.js';

const execFileAsync = promisify(execFile);

export type GitHubDesignSystemImportOptions = Pick<
  LocalDesignSystemImportOptions,
  'craftApplies' | 'importMode' | 'name' | 'now' | 'reservedIds' | 'platformUserId'
> & {
  branch?: string;
  gitBin?: string;
};

export type ParsedGitHubRepoUrl = {
  cloneUrl: string;
  owner: string;
  repo: string;
};

type ExecGitResult = {
  stdout: string | Buffer;
  stderr: string | Buffer;
};

export async function importGitHubDesignSystemProject(
  githubUrl: string,
  tmpRoot: string,
  userDesignSystemsRoot: string,
  options: GitHubDesignSystemImportOptions = {},
): Promise<LocalDesignSystemImportResult> {
  const importedAt = (options.now ?? new Date()).toISOString();
  return withGitHubCheckout(githubUrl, tmpRoot, options, async (cloneDir, parsed, gitBin, branch) => {
    const [detectedBranch, commit] = await Promise.all([
      readGitStdout(gitBin, ['-C', cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD']),
      readGitStdout(gitBin, ['-C', cloneDir, 'rev-parse', 'HEAD']),
    ]);
    const sourceBranch = branch ?? normalizeDetachedBranch(detectedBranch);
    return importLocalDesignSystemProject(cloneDir, userDesignSystemsRoot, {
      now: new Date(importedAt),
      fallbackName: parsed.repo,
      ...(options.name ? { name: options.name } : {}),
      ...(options.reservedIds ? { reservedIds: options.reservedIds } : {}),
      ...(options.importMode ? { importMode: options.importMode } : {}),
      ...(options.craftApplies ? { craftApplies: options.craftApplies } : {}),
      ...(options.platformUserId ? { platformUserId: options.platformUserId } : {}),
      source: {
        type: 'github',
        url: parsed.cloneUrl,
        commit,
        importedAt,
        ...(sourceBranch ? { branch: sourceBranch } : {}),
      },
    });
  });
}

/** Install an authored package without regenerating its design or preview files. */
export async function installHostedGitHubDesignSystemPackage(
  githubUrl: string,
  tmpRoot: string,
  userDesignSystemsRoot: string,
  options: { platformUserId: string; gitBin?: string },
): Promise<string> {
  return withGitHubCheckout(githubUrl, tmpRoot, options, async (cloneDir, parsed) => {
    const designFile = await stat(path.join(cloneDir, 'DESIGN.md')).catch(() => null);
    if (!designFile?.isFile()) {
      throw new LocalDesignSystemImportError('BAD_REQUEST', 'Repository does not contain a DESIGN.md file');
    }

    const metadataPath = path.join(cloneDir, 'metadata.json');
    let metadata: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) metadata = raw as Record<string, unknown>;
    } catch {
      // Missing or invalid metadata is optional.
    }
    delete metadata.projectId;
    metadata.platformUserId = options.platformUserId;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}
`, 'utf8');
    await rm(path.join(cloneDir, '.git'), { recursive: true, force: true });

    const id = parsed.repo.slice(0, 64);
    const dest = path.join(userDesignSystemsRoot, id);
    try {
      await mkdir(dest, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LocalDesignSystemImportError('BAD_REQUEST', 'A design system with this name is already installed');
      }
      throw err;
    }
    try {
      await rename(cloneDir, dest);
    } catch (err) {
      await rmdir(dest).catch(() => {});
      throw err;
    }
    return id;
  });
}

async function withGitHubCheckout<T>(
  githubUrl: string,
  tmpRoot: string,
  options: GitHubDesignSystemImportOptions,
  consume: (dir: string, repo: ParsedGitHubRepoUrl, gitBin: string, branch: string | undefined) => Promise<T>,
): Promise<T> {
  const parsed = parseGitHubRepoUrl(githubUrl);
  const cloneRoot = path.join(tmpRoot, 'github-design-system-imports');
  await mkdir(cloneRoot, { recursive: true });
  const staging = await mkdtemp(path.join(cloneRoot, 'checkout-'));
  const cloneDir = path.join(staging, 'repo');
  const gitBin = options.gitBin ?? 'git';
  const cloneArgs = ['clone', '--depth', '1'];
  const branch = cleanBranch(options.branch);
  if (branch) cloneArgs.push('--branch', branch);
  cloneArgs.push(parsed.cloneUrl, cloneDir);

  try {
    await execGit(gitBin, cloneArgs, undefined, 120_000);
    if (options.platformUserId && !(await isRegularDesignSystemTree(cloneDir))) {
      throw new LocalDesignSystemImportError('BAD_REQUEST', 'Hosted design systems cannot contain symbolic links or special files');
    }
    return await consume(cloneDir, parsed, gitBin, branch);
  } catch (err) {
    if (err instanceof LocalDesignSystemImportError) throw err;
    throw new LocalDesignSystemImportError(
      'BAD_REQUEST',
      `could not import public GitHub repository: ${formatGitError(err)}`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export function parseGitHubRepoUrl(input: string): ParsedGitHubRepoUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new LocalDesignSystemImportError('BAD_REQUEST', 'GitHub URL must be a valid https://github.com URL');
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new LocalDesignSystemImportError('BAD_REQUEST', 'only public https://github.com repositories are supported');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const rawRepo = parts[1];
  if (!owner || !rawRepo || parts.length > 2) {
    throw new LocalDesignSystemImportError('BAD_REQUEST', 'GitHub URL must point to a repository root');
  }

  const repo = rawRepo.replace(/\.git$/i, '');
  if (!isGitHubPathSegment(owner) || !isGitHubPathSegment(repo)) {
    throw new LocalDesignSystemImportError('BAD_REQUEST', 'GitHub repository owner/name contains unsupported characters');
  }

  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function cleanBranch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed) || trimmed.includes('..') || trimmed.startsWith('/')) {
    throw new LocalDesignSystemImportError('BAD_REQUEST', 'GitHub branch contains unsupported characters');
  }
  return trimmed;
}

function normalizeDetachedBranch(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'HEAD') return undefined;
  return trimmed;
}

function isGitHubPathSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith('.') && !value.endsWith('.');
}

async function readGitStdout(gitBin: string, args: string[]): Promise<string> {
  const result = await execGit(gitBin, args, undefined, 20_000);
  return String(result.stdout).trim();
}

async function execGit(
  gitBin: string,
  args: string[],
  cwd: string | undefined,
  timeout: number,
): Promise<ExecGitResult> {
  return await execFileAsync(gitBin, args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

function formatGitError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n').slice(-1)[0] ?? stderr.trim();
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return String(err);
}
