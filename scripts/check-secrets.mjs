import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '8.30.1';
const distributions = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const distribution = `${process.platform}_${process.arch}`;
const expected = distributions[distribution];
if (!expected) throw new Error('Secret scanning supports macOS arm64/x64 and Linux x64.');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const privatePaths = /(?:^|\/)(?:\.runtime|outputs|\.codex|sessions)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)auth\.json$|\.(?:jsonl|pem|key|p12|pfx|sqlite[^/]*|db)$/i;
if (files.some(file => file !== '.env.example' && privatePaths.test(file))) {
  throw new Error('Private file types are tracked. Remove them from the Git index before publishing.');
}

const temporary = await mkdtemp(join(tmpdir(), 'codex-usage-secrets-'));
try {
  const filename = `gitleaks_${version}_${distribution}.tar.gz`;
  const archivePath = join(temporary, filename);
  execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '10', '--max-time', '600', '--output', archivePath,
    `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${filename}`], { stdio: 'inherit' });
  const archive = await readFile(archivePath);
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Scanner checksum mismatch.');
  execFileSync('tar', ['-xzf', archivePath, '-C', temporary, 'gitleaks']);
  const scanner = join(temporary, 'gitleaks');
  await chmod(scanner, 0o700);

  // Scan the exact index contents, including staged changes, without reading ignored runtime files.
  const snapshot = join(temporary, 'index');
  await mkdir(snapshot, { mode: 0o700 });
  for (const file of files) {
    const destination = join(snapshot, file);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const content = execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 10_000_000 });
    await writeFile(destination, content, { mode: 0o600 });
  }
  for (const args of [
    ['dir', '--no-banner', '--redact=100', snapshot],
    ['git', '--no-banner', '--redact=100', '--log-opts=--all', root],
  ]) {
    const result = spawnSync(scanner, args, { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Secret scanning failed. Publication must stop.');
  }
  console.log('Git index and full Git history passed secret scanning.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
