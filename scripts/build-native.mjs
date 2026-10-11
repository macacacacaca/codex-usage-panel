import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function buildNative({ root = projectRoot, bundle = join(root, 'outputs/CodexUsage.app'), architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64', nodeRuntime } = {}) {
  if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('Unsupported macOS architecture.');
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric release version.');
  await rm(bundle, { recursive: true, force: true });
  const contents = join(bundle, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources/Service'), { recursive: true });
  await mkdir(join(root, '.runtime/swift-cache'), { recursive: true });
  const compile = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-O', '-target', `${architecture}-apple-macosx13.5`,
    '-module-cache-path', join(root, '.runtime/swift-cache'), '-framework', 'AppKit', '-framework', 'SwiftUI',
    ...['Models.swift', 'UsageModel.swift', 'UsageView.swift', 'main.swift'].map(name => join(root, 'native', name)),
    '-o', join(contents, 'MacOS/CodexUsage')], { stdio: 'inherit' });
  if (compile.status !== 0) throw new Error('Native compilation failed.');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.codex.usagepanel</string>
<key>CFBundleName</key><string>CodexUsage</string>
<key>CFBundleDisplayName</key><string>Codex 用量</string>
<key>CFBundleExecutable</key><string>CodexUsage</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>7</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`;
  await writeFile(join(contents, 'Info.plist'), plist);
  await cp(join(root, 'src'), join(contents, 'Resources/Service/src'), { recursive: true });
  if (nodeRuntime) {
    const runtime = join(contents, 'Resources/Runtime');
    await mkdir(runtime, { recursive: true });
    await cp(join(nodeRuntime, 'bin/node'), join(runtime, 'node'));
    await cp(join(nodeRuntime, 'LICENSE'), join(runtime, 'LICENSE.node.txt'));
    await writeFile(join(runtime, 'README.txt'), 'Node.js v24.21.0\nOfficial distribution: https://nodejs.org/dist/v24.21.0/\nThird-party notices: LICENSE.node.txt\nThe runtime executable is signed ad hoc when packaged in CodexUsage.\n');
    const signRuntime = spawnSync('codesign', ['--force', '--sign', '-', join(runtime, 'node')], { stdio: 'inherit' });
    if (signRuntime.status !== 0) throw new Error('Runtime signing failed.');
  }
  const sign = spawnSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
  if (sign.status !== 0) throw new Error('App signing failed.');
  console.log(`Native app built (${architecture}): ${bundle}`);
  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNative();
