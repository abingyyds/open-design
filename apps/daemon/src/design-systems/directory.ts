import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function reserveDesignSystemDirectory(
  root: string,
  base: string,
  reservedIds: Iterable<string> = [],
): Promise<string> {
  await mkdir(root, { recursive: true });
  const reserved = new Set(reservedIds);
  for (let index = 1; ; index++) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (reserved.has(id)) continue;
    try {
      await mkdir(path.join(root, id), { mode: 0o700 });
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
