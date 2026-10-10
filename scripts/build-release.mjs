import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildNative } from './build-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeVersion = '24.21.0';
const distributions = {
  arm64: { nodeArch: 'arm64', sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057' },
  x86_64: { nodeArch: 'x64', sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097' },
};

if (process.platform !== 'darwin') throw new Error('Release packaging requires macOS and Apple Command Line Tools.');
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) throw new Error('Commit all public source changes before building a release.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const temporary = await mkdtemp(join(tmpdir(), 'codex-usage-release-'));
try {
  const source = join(temporary, 'source');
  await mkdir(source, { mode: 0o700 });
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
  const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const output = join(root, 'outputs/releases', `v${version}`);
  await mkdir(output, { recursive: true });
  const checksums = [];
  for (const [architecture, distribution] of Object.entries(distributions)) {
    const filename = `node-v${nodeVersion}-darwin-${distribution.nodeArch}.tar.gz`;
    const download = join(temporary, filename);
    console.log(`Downloading official Node.js ${nodeVersion} (${architecture})…`);
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '10', '--max-time', '240', '--output', download, `https://nodejs.org/dist/v${nodeVersion}/${filename}`], { stdio: 'inherit' });
    const digest = createHash('sha256').update(await readFile(download)).digest('hex');
    if (digest !== distribution.sha256) throw new Error(`Node.js checksum mismatch for ${architecture}.`);
    execFileSync('tar', ['-xzf', download, '-C', temporary]);
    const nodeRuntime = join(temporary, `node-v${nodeVersion}-darwin-${distribution.nodeArch}`);
    const bundle = join(temporary, architecture, 'CodexUsage.app');
    await buildNative({ root: source, bundle, architecture, nodeRuntime });
    const nativeBinary = join(bundle, 'Contents/MacOS/CodexUsage');
    const nodeBinary = join(bundle, 'Contents/Resources/Runtime/node');
    for (const binary of [nativeBinary, nodeBinary]) {
      const actual = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim();
      if (actual !== architecture) throw new Error(`Unexpected architecture: ${actual}.`);
      execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'inherit' });
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    execFileSync('plutil', ['-lint', join(bundle, 'Contents/Info.plist')], { stdio: 'inherit' });
    const appArchive = `CodexUsage-v${version}-macos-${architecture}.zip`;
    const appPath = join(output, appArchive);
    // Copy only the fresh app. Exclude extended attributes, ACLs, and resource forks.
    execFileSync('ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noacl', bundle, appPath]);
    const data = await readFile(appPath);
    checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${appArchive}`);
    console.log(`Packaged ${appArchive} (${(data.length / 1024 / 1024).toFixed(1)} MiB).`);
  }
  await writeFile(join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  await writeFile(join(output, 'release-manifest.json'), JSON.stringify({ version, commit, nodeVersion, architectures: Object.keys(distributions), assets: checksums.map(line => line.split('  ')[1]) }, null, 2) + '\n');
  console.log(`Release assets ready: outputs/releases/v${version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
