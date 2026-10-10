import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { writePrivateJson } from '../src/private-files.ts';

test('private settings tighten old file permissions and replace symlinks without modifying their targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-private-test-'));
  try {
    const directory = join(root, 'runtime');
    const file = join(directory, 'tracking.json');
    await writePrivateJson(pathToFileURL(file), { threadId: null });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    await rm(file);
    await writeFile(file, '{}', { mode: 0o644 });
    await writePrivateJson(pathToFileURL(file), { threadId: null });
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const outside = join(root, 'unrelated.json');
    await writeFile(outside, 'unchanged');
    await rm(file);
    await symlink(outside, file);
    await writePrivateJson(pathToFileURL(file), { threadId: null });
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { threadId: null });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['tracking.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
