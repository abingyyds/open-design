import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(import.meta.dirname, '../..');
const dockerfilePath = join(repoRoot, 'deploy/Dockerfile');
const composePath = join(repoRoot, 'deploy/docker-compose.yml');

async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

test('Dockerfile repairs mounted data directory ownership before dropping privileges', async () => {
  const src = await read(dockerfilePath);

  assert.match(src, /\bsu-exec\b/, 'runtime image must include su-exec');
  assert.doesNotMatch(src, /^\s*USER\s+open-design\s*$/m, 'container must start as root to repair mounted volume ownership');
  assert.match(src, /mkdir -p \\"?\$OD_DATA_DIR\\"?/, 'startup command must create the resolved data directory');
  assert.match(src, /chown -R open-design:open-design \\"?\$OD_DATA_DIR\\"?/, 'startup command must chown mounted data directory');
  assert.match(src, /exec su-exec open-design node apps\/daemon\/dist\/cli\.js --no-open/, 'daemon must run as open-design after ownership repair');
});

test('Compose stores daemon data in the mounted persistent volume', async () => {
  const src = await read(composePath);

  assert.match(src, /OD_DATA_DIR:\s*\/app\/\.od\b/, 'compose OD_DATA_DIR must match the mounted data volume');
  assert.match(src, /open_design_data:\/app\/\.od\b/, 'compose must mount the data volume at OD_DATA_DIR');
});
