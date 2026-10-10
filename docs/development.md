# Development and Validation

[← Back to the project](../README.md)

## Build from Source

Running a [downloaded release](https://github.com/macacacacaca/codex-usage-panel/releases/latest) does not require these tools. For a source build, install macOS 13.5+, Node.js 22.18+, and Apple Command Line Tools (`xcode-select --install`). Codex app or CLI with ChatGPT sign-in is required for usage data in both cases. There are no third-party npm dependencies, so `npm install` is not needed.

```sh
git clone https://github.com/macacacacaca/codex-usage-panel.git
cd codex-usage-panel
npm run build:native
open outputs/CodexUsage.app
```

## Commands and Source Map

```sh
npm run probe  # Read-only diagnostics: plan, windows, and presence of identity fields
npm run probe -- --tokens  # Include normalized token endpoint diagnostics
npm run build  # Native Node.js TypeScript type stripping; generate browser JavaScript
npm run build:native  # Build SwiftUI/AppKit app, bundle the service, and sign ad hoc
npm test  # Normalization, time boundaries, isolation, recovery, cleanup, HTTP boundaries
npm run security:check  # Scan the Git index and full history with a checksum-verified scanner
npm run demo  # Clearly labeled demo mode; does not start Codex App Server
```

`native/` contains the menu bar app, native views, SSE client, and service process management. `src/native.ts` generates native data payloads and shares the USD formula with the web interface. `src/adapter.ts` handles JSONL RPC; `src/service.ts` manages identity, shared polling, snapshots, and recovery; `src/domain.ts` normalizes allowance data; `src/tokens.ts` normalizes tokens and calculates prices; `src/local-tokens.ts` verifies and incrementally reads chat records; and `src/client.ts` implements the web interface. `outputs/CodexUsage.app` is the runnable app; `web/` and `dist/` provide the retained web development version.

Validation on 2026-10-11: `npm test` completed with **27 passed and 0 failed**, covering normalization, account isolation, token calculations, process cleanup, HTTP boundaries, private file permissions, native data endpoints, and CLI startup with a restricted Finder-style PATH. Native model checks cover bundled runtime discovery and executable search paths.

## Release Packaging

Version 0.3.2 provides separate macOS 13.5+ ZIP archives for Apple Silicon (`arm64`) and Intel (`x86_64`). Each contains `CodexUsage.app`, the local data service, and the official Node.js 24.21.0 runtime for that architecture. Codex itself remains an external prerequisite.

The minimum macOS version follows the [official Node.js 24.21.0 platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list).

On a Mac with Node.js and Apple Command Line Tools, commit all public source changes and ensure the Git working tree is clean, then run:

```sh
npm run release:build
```

The packaging command uses a clean `git archive` snapshot of the current committed `HEAD`, downloads checksum-pinned official Node.js runtimes, builds both architectures, verifies signatures and architectures, and writes the ZIPs, `SHA256SUMS.txt`, and a build manifest to `outputs/releases/v0.3.2/`. It rejects uncommitted or untracked source changes. Use the manifest to confirm which commit produced the archives; upload the two ZIPs and checksum file to the matching GitHub release.

Release builds must start from clean source and package only explicitly selected app resources. Exclude `.runtime/`, `outputs/` from the source snapshot, credentials, session records, environment files, saved chat IDs, account data, and personal preferences. Never package an existing local app or copy the user's Application Support directory. Node.js downloads must be checked against the published SHA-256 sums, and bundled third-party notices must accompany the runtime. Sign the finished app ad hoc after assembling its resources, verify the signature and architecture, and publish ZIP checksums in `SHA256SUMS.txt`.

Ad hoc signatures do not identify the publisher through Apple and do not provide notarization. Release notes and installation instructions must state this limitation. The [user guide](./guide.md#install-a-release) describes Apple's per-app first-launch flow; release packages must not change Gatekeeper settings.

`outputs/`, `.runtime/`, `dist/`, and environment files are excluded by `.gitignore`. The public screenshot is stored in `docs/screenshots/`. Release archives are attached to GitHub Releases; local build and validation artifacts stay outside the repository.

See [SECURITY.md](../SECURITY.md) for security protections, data scope, and reporting guidance.
