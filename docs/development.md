# Development and Validation

[← Back to the project](../README.md)

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

Validation on 2026-10-10: `npm test` completed with **25 passed and 0 failed**, covering normalization, account isolation, token calculations, process cleanup, HTTP boundaries, private file permissions, and native data endpoints.

`outputs/`, `.runtime/`, `dist/`, and environment files are excluded by `.gitignore`. The public screenshot is stored in `docs/screenshots/`. Users build the app locally and keep other local validation artifacts outside the repository.

See [SECURITY.md](../SECURITY.md) for security protections, data scope, and reporting guidance.
