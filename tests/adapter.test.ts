import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapter.ts';

async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'usage-cli-test-'));
  const binary = join(directory, 'fake-codex.mjs');
  await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
let ready = false, initializations = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') { initializations++; send({ id: m.id, result: {} }); }
  else if (m.method === 'initialized') ready = true;
  else if (${JSON.stringify(mode)} === 'timeout') {}
  else if (${JSON.stringify(mode)} === 'exit') process.exit(0);
  else send({ id: m.id, result: { ready, initializations } });
});
`);
  await chmod(binary, 0o700); return { directory, binary };
}
test('adapter performs one handshake, forbids write methods and terminates its own child', async () => {
  const f = await fixture('normal'); const adapter = new CodexAdapter({ binary: f.binary, timeoutMs: 1000 });
  try {
    await Promise.all([adapter.start(), adapter.start()]);
    assert.deepEqual(await adapter.request('account/read'), { ready: true, initializations: 1 });
    await assert.rejects(adapter.request('account/logout'), { code: 'method_forbidden' });
    const pid = adapter.child!.pid!; await adapter.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(adapter.pending.size, 0);
  } finally { await adapter.close(); await rm(f.directory, { recursive: true }); }
});
test('RPC timeout clears pending requests and unexpected exit rejects outstanding reads', async () => {
  for (const mode of ['timeout', 'exit']) {
    const f = await fixture(mode); const adapter = new CodexAdapter({ binary: f.binary, timeoutMs: 2000 });
    try {
      await adapter.start();
      adapter.timeoutMs = 100;
      await assert.rejects(adapter.request('account/read'), { code: mode === 'timeout' ? 'timeout' : 'service_stopped' });
      assert.equal(adapter.pending.size, 0);
    } finally { await adapter.close(); await rm(f.directory, { recursive: true }); }
  }
});
