import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir, symlink } from 'node:fs/promises';
import { accessSync, constants, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, findCodex } from '../src/adapter.ts';

test('Codex discovery supports installed apps and CLI locations without shell PATH', () => {
  const home = '/Users/example';
  const discover = (executables: string[]) => findCodex({ home, environment: {}, isExecutable: path => executables.includes(path) });
  assert.equal(discover(['/opt/homebrew/bin/codex']), '/opt/homebrew/bin/codex');
  assert.equal(discover(['/usr/local/bin/codex']), '/usr/local/bin/codex');
  assert.equal(discover([join(home, 'Applications/Codex.app/Contents/Resources/codex')]), join(home, 'Applications/Codex.app/Contents/Resources/codex'));
  assert.equal(discover([join(home, '.npm-global/bin/codex')]), join(home, '.npm-global/bin/codex'));
  assert.equal(discover(['/opt/homebrew/bin/codex', '/Applications/Codex.app/Contents/Resources/codex']), '/Applications/Codex.app/Contents/Resources/codex');
  assert.equal(discover([]), 'codex');
  assert.equal(findCodex({ environment: { CODEX_BINARY: '/custom/codex' }, isExecutable: () => false }), '/custom/codex');
});

async function extensionFixture(t: { after: (callback: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), 'usage-extension-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const install = async (root: string, name: string, target = 'macos-aarch64', mode = 0o700) => {
    const directory = join(home, root, 'extensions', name, 'bin', target);
    await mkdir(directory, { recursive: true });
    const binary = join(directory, target.startsWith('windows-') ? 'codex.exe' : 'codex');
    // Discovery must only inspect this file, never execute it.
    await writeFile(binary, 'not an executable program', { mode });
    return binary;
  };
  const isExecutable = (path: string) => {
    if (!path.startsWith(`${home}/`)) return false;
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  };
  const discover = (platform: NodeJS.Platform = 'darwin', arch = 'arm64') => findCodex({ home, environment: {}, isExecutable, platform, arch });
  return { home, install, isExecutable, discover };
}

test('Codex discovery selects the newest official VS Code extension across Stable and Insiders', async t => {
  const f = await extensionFixture(t);
  await f.install('.vscode', 'openai.chatgpt-1.9.0-darwin-arm64');
  const latestStable = await f.install('.vscode', 'openai.chatgpt-1.10.0-darwin-arm64');
  await f.install('.vscode', 'other.chatgpt-99.0.0-darwin-arm64');
  await f.install('.vscode', 'openai.chatgpt-invalid');
  assert.equal(f.discover(), latestStable);
  const latestInsiders = await f.install('.vscode-insiders', 'openai.chatgpt-2.0.0-darwin-arm64');
  assert.equal(f.discover(), latestInsiders);
  const sameVersionStable = await f.install('.vscode', 'openai.chatgpt-2.0.0-darwin-arm64');
  assert.equal(f.discover(), sameVersionStable);
  const cli = '/opt/homebrew/bin/codex';
  assert.equal(findCodex({ home: f.home, environment: {}, isExecutable: path => path === cli || f.isExecutable(path) }), cli);
  assert.equal(findCodex({ home: f.home, environment: { CODEX_BINARY: '/custom/codex' }, isExecutable: f.isExecutable }), '/custom/codex');
});

test('Codex discovery skips unusable and mismatched VS Code binaries', async t => {
  const f = await extensionFixture(t);
  const usable = await f.install('.vscode', 'openai.chatgpt-1.0.0-darwin-arm64');
  await f.install('.vscode', 'openai.chatgpt-2.0.0-darwin-arm64', 'macos-aarch64', 0o600);
  await f.install('.vscode', 'openai.chatgpt-3.0.0-darwin-x64', 'macos-x86_64');
  // Even if a mismatched distribution contains a matching folder, ignore it.
  await f.install('.vscode', 'openai.chatgpt-4.0.0-darwin-x64');
  await f.install('.vscode', 'openai.chatgpt-5.0.0-linux-arm64');
  const directory = await f.install('.vscode', 'openai.chatgpt-6.0.0-darwin-arm64');
  await rm(directory); await mkdir(directory);
  assert.equal(f.discover(), usable);
  await rm(usable);
  assert.equal(f.discover(), 'codex');
});

test('Codex discovery uses native extension platform and architecture directories', async t => {
  const f = await extensionFixture(t);
  const intelMac = await f.install('.vscode', 'openai.chatgpt-1.0.0-darwin-x64', 'macos-x86_64');
  const linux = await f.install('.vscode', 'openai.chatgpt-1.0.0-linux-arm64', 'linux-aarch64');
  const windows = await f.install('.vscode', 'openai.chatgpt-1.0.0-win32-x64', 'windows-x86_64');
  assert.equal(f.discover('darwin', 'x64'), intelMac);
  assert.equal(f.discover('linux', 'arm64'), linux);
  assert.equal(f.discover('win32', 'x64'), windows);
  assert.equal(f.discover('darwin', 'ia32'), 'codex');
});

test('Codex discovery tolerates absent and unreadable extension roots', async t => {
  const f = await extensionFixture(t);
  assert.equal(f.discover(), 'codex');
  await mkdir(join(f.home, '.vscode'));
  // A root that cannot be listed must not prevent checking the other installation.
  await writeFile(join(f.home, '.vscode', 'extensions'), 'not a directory');
  const insiders = await f.install('.vscode-insiders', 'openai.chatgpt-1.0.0');
  assert.equal(f.discover(), insiders);
});

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
test('CLI wrapper uses bundled Node with a restricted Finder-style PATH', async () => {
  const f = await fixture('normal');
  try {
    const runtime = join(f.directory, 'Runtime');
    await mkdir(runtime); await symlink(process.execPath, join(runtime, 'node'));
    const module = new URL('../src/adapter.ts', import.meta.url).href;
    const script = `import { CodexAdapter } from ${JSON.stringify(module)};
const adapter = new CodexAdapter({ timeoutMs: 2000 });
try { await adapter.start(); const result = await adapter.request('account/read'); if (!result.ready) process.exitCode = 1; }
finally { await adapter.close(); }`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PATH: `${runtime}:/usr/bin:/bin`, CODEX_BINARY: f.binary }, timeout: 10_000,
    });
  } finally { await rm(f.directory, { recursive: true }); }
});
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
