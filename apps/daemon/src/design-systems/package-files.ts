import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Hosted packages must only contain files and directories owned by the package. */
export async function isRegularDesignSystemTree(root: string): Promise<boolean> {
  try {
    if (!(await lstat(root)).isDirectory()) return false;
    const pending = [root];
    while (pending.length) {
      const dir = pending.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
        else if (!entry.isFile()) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
