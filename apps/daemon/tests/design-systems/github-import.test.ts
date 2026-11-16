import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  importGitHubDesignSystemProject,
  installHostedGitHubDesignSystemPackage,
  parseGitHubRepoUrl,
} from '../../src/design-systems/github-import.js';

describe('parseGitHubRepoUrl', () => {
  it('normalizes public GitHub repository URLs to clone URLs', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/design-system')).toEqual({
      owner: 'acme',
      repo: 'design-system',
      cloneUrl: 'https://github.com/acme/design-system.git',
    });
    expect(parseGitHubRepoUrl('https://github.com/acme/design-system.git')).toEqual({
      owner: 'acme',
      repo: 'design-system',
      cloneUrl: 'https://github.com/acme/design-system.git',
    });
  });

  it('rejects non-root or non-GitHub URLs', () => {
    expect(() => parseGitHubRepoUrl('https://example.com/acme/design-system')).toThrow(
      /github\.com/,
    );
    expect(() => parseGitHubRepoUrl('https://github.com/acme/design-system/tree/main')).toThrow(
      /repository root/,
    );
  });
});

describe('importGitHubDesignSystemProject', () => {
  let tempRoot: string;
  let fixtureRoot: string;
  let tmpRoot: string;
  let userDesignSystemsRoot: string;
  let fakeGit: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-ds-github-import-'));
    fixtureRoot = path.join(tempRoot, 'fixture-repo');
    tmpRoot = path.join(tempRoot, '.tmp');
    userDesignSystemsRoot = path.join(tempRoot, 'user-design-systems');
    fs.mkdirSync(path.join(fixtureRoot, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'src', 'styles'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({
        name: 'github-design-kit',
        description: 'A GitHub-hosted design kit.',
        dependencies: { react: '^18.0.0' },
      }),
    );
    fs.writeFileSync(path.join(fixtureRoot, 'README.md'), '# GitHub Design Kit\n\nRemote style source.\n');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'styles', 'tokens.css'), ':root { --primary: #22c55e; }');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'components', 'Card.tsx'), 'export function Card() {}');

    fakeGit = path.join(tempRoot, 'fake-git.sh');
    fs.writeFileSync(
      fakeGit,
      `#!/bin/sh
set -eu
if [ "$1" = "clone" ]; then
  target=""
  for arg in "$@"; do target="$arg"; done
  mkdir -p "$target"
  cp -R "$FAKE_GIT_SOURCE"/. "$target"/
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--abbrev-ref" ]; then
  printf 'main\\n'
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then
  printf 'abc123def456\\n'
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 1
`,
    );
    fs.chmodSync(fakeGit, 0o755);
    process.env.FAKE_GIT_SOURCE = fixtureRoot;
  });

  afterEach(() => {
    delete process.env.FAKE_GIT_SOURCE;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('stages hosted packages, preserves authored files, and assigns ownership on publication', async () => {
    const authored = '# Authored design fixture';
    fs.writeFileSync(path.join(fixtureRoot, 'DESIGN.md'), authored);
    fs.writeFileSync(path.join(fixtureRoot, 'components.html'), '<p>Authored fixture</p>');
    fs.writeFileSync(path.join(fixtureRoot, 'metadata.json'), JSON.stringify({
      projectId: 'source-project', platformUserId: 'source-user', title: 'Hosted fixture',
    }));
    fs.mkdirSync(userDesignSystemsRoot, { recursive: true });
    const id = await installHostedGitHubDesignSystemPackage(
      'https://github.com/acme/design-kit', tmpRoot, userDesignSystemsRoot,
      { gitBin: fakeGit, platformUserId: 'fixture-tenant' },
    );
    const installed = path.join(userDesignSystemsRoot, id);
    expect(fs.readFileSync(path.join(installed, 'DESIGN.md'), 'utf8')).toBe(authored);
    expect(fs.readFileSync(path.join(installed, 'components.html'), 'utf8')).toBe('<p>Authored fixture</p>');
    expect(JSON.parse(fs.readFileSync(path.join(installed, 'metadata.json'), 'utf8'))).toEqual({
      platformUserId: 'fixture-tenant', title: 'Hosted fixture',
    });
    expect(fs.readdirSync(path.join(tmpRoot, 'github-design-system-imports'))).toEqual([]);
  });

  it('rejects links in hosted checkout fixtures before publishing a package', async () => {
    fs.writeFileSync(path.join(fixtureRoot, 'DESIGN.md'), '# Hosted fixture');
    fs.symlinkSync('DESIGN.md', path.join(fixtureRoot, 'reference.md'));
    fs.mkdirSync(userDesignSystemsRoot, { recursive: true });
    await expect(installHostedGitHubDesignSystemPackage(
      'https://github.com/acme/design-kit', tmpRoot, userDesignSystemsRoot,
      { gitBin: fakeGit, platformUserId: 'fixture-tenant' },
    )).rejects.toThrow(/symbolic links/);
    expect(fs.readdirSync(userDesignSystemsRoot)).toEqual([]);
    expect(fs.readdirSync(path.join(tmpRoot, 'github-design-system-imports'))).toEqual([]);
  });

  it('clones a public GitHub URL and imports through the local project format', async () => {
    const result = await importGitHubDesignSystemProject(
      'https://github.com/acme/design-kit',
      tmpRoot,
      userDesignSystemsRoot,
      {
        gitBin: fakeGit,
        now: new Date('2026-05-18T10:00:00.000Z'),
        importMode: 'normalized',
        craftApplies: ['color'],
      },
    );

    expect(result.id).toBe('github-design-kit');
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 'od-design-system-project/v1',
      id: 'github-design-kit',
      source: {
        type: 'github',
        url: 'https://github.com/acme/design-kit.git',
        branch: 'main',
        commit: 'abc123def456',
        importedAt: '2026-05-18T10:00:00.000Z',
      },
      files: {
        design: 'DESIGN.md',
        tokens: 'tokens.css',
        components: 'components.html',
      },
      usage: 'USAGE.md',
      componentsManifest: 'components.manifest.json',
      importMode: 'normalized',
      craft: {
        applies: ['color'],
      },
      sourceFiles: {
        scanned: 'source/scanned-files.json',
        evidence: 'source/evidence.md',
        tokens: 'source/tokens.source.json',
        report: 'source/token-contract.report.json',
        snippets: 'source/snippets/INDEX.json',
      },
    });
    expect(fs.readFileSync(path.join(result.dir, 'DESIGN.md'), 'utf8')).toContain(
      'A GitHub-hosted design kit.',
    );
    expect(fs.existsSync(path.join(result.dir, 'USAGE.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'components.manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'token-contract.report.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'preview', 'app.html'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'snippets', 'card.tsx'))).toBe(true);
  });
});
