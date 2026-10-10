import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = join(root, 'outputs/CodexUsage.app');
const contents = join(bundle, 'Contents');
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(contents, 'Resources/Service'), { recursive: true });
await mkdir(join(root, '.runtime/swift-cache'), { recursive: true });
const compile = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  '-module-cache-path', join(root, '.runtime/swift-cache'), '-framework', 'AppKit', '-framework', 'SwiftUI',
  ...['Models.swift', 'UsageModel.swift', 'UsageView.swift', 'main.swift'].map(name => join(root, 'native', name)),
  '-o', join(contents, 'MacOS/CodexUsage')], { stdio: 'inherit' });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.codex.usagepanel</string>
<key>CFBundleName</key><string>CodexUsage</string>
<key>CFBundleDisplayName</key><string>Codex 用量</string>
<key>CFBundleExecutable</key><string>CodexUsage</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.3.2</string>
<key>CFBundleVersion</key><string>5</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`;
await writeFile(join(contents, 'Info.plist'), plist);
const service = join(contents, 'Resources/Service');
await rm(join(service, 'src'), { recursive: true, force: true });
await cp(join(root, 'src'), join(service, 'src'), { recursive: true });
const sign = spawnSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
if (sign.status !== 0) process.exit(sign.status ?? 1);
console.log(`原生選單列 App 已建立：${bundle}`);
