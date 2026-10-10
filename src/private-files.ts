import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Replace settings atomically with an owner-only file; never follow an old symlink. */
export async function writePrivateJson(file: URL, value: object): Promise<void> {
  const path = fileURLToPath(file);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.usage-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
