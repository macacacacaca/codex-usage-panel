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

`native/` contains the menu bar app, native views, SSE client, and service process management. `src/native.ts` generates native data payloads and shares the USD formula with the web interface. `src/adapter.ts` handles JSONL RPC; `src/service.ts` manages identity, shared polling, snapshots, and recovery; `src/domain.ts` normalizes allowance data and selects the Codex quota window; `src/tokens.ts` normalizes tokens and calculates prices; `src/local-tokens.ts` verifies session and archived-session records and aggregates request deltas within the current interval; and `src/client.ts` implements the web interface. `outputs/CodexUsage.app` is the runnable app; `web/` and `dist/` provide the retained web development version.

Tests cover normalization, account isolation, token calculations, process cleanup, HTTP boundaries, private file permissions, native data endpoints, and CLI startup with a restricted Finder-style PATH. Native model checks cover bundled runtime discovery and executable search paths. Run the checks for the commit being released; prior release results do not establish validation for a new build.

## VS Code Compatibility

The official VS Code extension bundles its own Codex executable, which may be absent from the shell PATH. After checking the existing app and CLI locations, the adapter searches the Stable and Insiders extension directories for `openai.chatgpt-*`, selecting the newest usable executable for the host platform and architecture. `CODEX_BINARY` remains an explicit override.

The bundled CLI **0.162.0-alpha.17.2** schema makes `account/rateLimits/read.accountId` optional and nullable. Before/after `account/read` email verification is sufficient to display quota data, but local records still require an explicit owner ID. Missing IDs clear local counters and invalidate pending local reads; restored IDs resume verified aggregation. Regression tests cover absent/null/blank IDs, account changes, delayed-reader isolation, and discovery without a shell PATH. These changes are in source and require rebuilding the app; existing v0.3.6 release ZIPs remain unchanged.

## Current Quota Period

Version 0.3.6 measures consumption in the currently signed-in account's active Codex 300-minute quota window. Select the canonical `codex` category when present; a legacy Codex response with no limit ID is normalized to `codex`, while explicitly unrelated categories cannot supply the window. Define `startMs = resetsAtMs − 300 × 60,000` and `endMs = resetsAtMs`; require `0 ≤ startMs ≤ now < endMs`, a finite reset, and a duration of exactly 300 minutes.

Aggregate verified request deltas from `sessions/` and `archived_sessions/` when `startMs ≤ timestampMs < endMs` and `timestampMs ≤ now`. Counts, input/cache/output splits, and model pricing all use this interval. Lifetime counters and quota percentages cannot substitute for timestamped request consumption. Preserve account-owner checks, duplicate-session/event suppression, and fork-inheritance protections.

### Copied Fork Boundaries

Legacy copied forks can omit `subagent_history_start_ordinal`. Codex writes a `thread_settings_applied` event owned by the child thread after the inherited prefix. Source builds recognize that explicit marker as the boundary: inherited token rows seed cumulative counters but do not count toward the child; only subsequent reconciled request deltas contribute. Copied records can receive new timestamps, so timestamps cannot distinguish inherited usage.

A missing, invalid, or foreign-thread marker leaves the fork unverified and USD unavailable. The marker resolves only an initially missing boundary; later settings events cannot clear real request gaps or ambiguity from an explicit numeric boundary. Regression tests cover copied current-period counters, incremental marker arrival, model changes, owner mismatches, and post-boundary counter gaps. Previously downloaded v0.3.6 release apps require rebuilding to include this fix.

### Referenced History and Rollback

Paginated rollouts can inherit a bounded prefix through `history_base` instead of copying the prefix locally. This can be a continuation or rollback of the same logical chat; the reference identifies a physical rollout, whose ID may differ from the chat ID. Source builds validate the discovered source file, account ownership, byte and ordinal boundaries, and reference ancestry before restoring the cumulative counter baseline. The inherited prefix is not charged again as new consumption.

Separate physical continuations of one chat retain their distinct paid requests. If source history contains requests A and B, and a continuation rolls back to A before making request C, actual consumption includes A, B, and C once each. Exact copies of a physical rollout are deduplicated separately. Missing or unsafe sources, invalid cutoffs, cycles, and unresolved request counters keep estimates unavailable. Tests use synthetic reference chains, rollback branches, archive copies, and invalid references; private session files are never fixtures.

### Excluded Safety Reviews

OpenAI's ChatGPT sign-in policy makes auto-review safety checks free and exempt from plan limits. [Official policy](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan). The reader excludes only the exact model ID `codex-auto-review` from current-period counters and pricing segments, while recording its verified in-period token total as `excludedReviewTokens` for details. Account, timestamp, and interval checks determine that separate period total. Version 0.3.6 also prevents a verified, exact free-review delta with no timestamp from creating paid-pricing uncertainty; it is not added to `excludedReviewTokens` because its interval cannot be established. Raw cumulative counters remain the verification baseline. Period `.complete` describes paid-request coverage; actual paid or ambiguous deltas remain conservative.

A supported paid model mixed with free auto-review requests previously made USD unavailable because the review model had no paid price entry. Separating the review requests lets the remaining complete paid segments use official API rates. This is one explicitly identified free-model case; other unknown model IDs still return unavailable pricing. Do not assign aliases or reference prices to them. Validation should cover paid/review mixtures, review-only intervals, out-of-period reviews, and unknown paid models without using private session data.

### Bounded JSONL Classification

The reader keeps a 4,000,000-byte row limit. Previously, skipping a larger ordinary message or tool-output row marked token history incomplete even when the paid counters and request breakdowns reconciled exactly. Version 0.3.6 reads discriminators from the first 8 KiB and validates the oversized row's JSON structure with bounded memory, including duplicate discriminators later in the row. A recognized unrelated record can be discarded without introducing a token gap. The classifier does not retain or expose the message body. Oversized token/identity records, ambiguous headers, malformed JSON, and genuine gaps still make the affected pricing unavailable.

Validate oversized ordinary rows alongside complete paid token events, record ordering, deceptive nested type strings, unknown or relevant oversized rows, and undated exact free-review deltas. Keep real missing paid timestamps and counter-gap tests: the fix must preserve conservative pricing without adding partial totals or model aliases.

Missing or expired windows make usage unavailable. Missing paid timestamps, genuine counter gaps, unreadable token records, or incomplete request/model/cache data can produce a clearly labelled token subtotal, with USD unavailable. Tests should cover interval boundaries, future timestamps, reset changes, missing/expired/ambiguous windows, excluded prior usage, incomplete deltas, account changes, sign-out, ownership, archives, and duplicates. Release validation results should identify the commit tested.

Native official account reads refresh every 60 seconds; local current-period consumption refreshes every 10 seconds. The web version shares the period scope while retaining its configurable official polling interval. Neither polling cadence nor local log completeness establishes an account-wide cloud token breakdown.

## Release Packaging

Version 0.3.6 provides separate macOS 13.5+ ZIP archives for Apple Silicon (`arm64`) and Intel (`x86_64`). Each contains `CodexUsage.app`, the local data service, and the official Node.js 24.21.0 runtime for that architecture. Codex itself remains an external prerequisite.

The minimum macOS version follows the [official Node.js 24.21.0 platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md#platform-list).

On a Mac with Node.js and Apple Command Line Tools, commit all public source changes and ensure the Git working tree is clean, then run:

```sh
npm run release:build
```

The packaging command uses a clean `git archive` snapshot of the current committed `HEAD`, downloads checksum-pinned official Node.js runtimes, builds both architectures, verifies signatures and architectures, and writes the ZIPs, `SHA256SUMS.txt`, and a build manifest to `outputs/releases/v0.3.6/`. It rejects uncommitted or untracked source changes. Use the manifest to confirm which commit produced the archives; upload the two ZIPs and checksum file to the matching GitHub release.

Release builds must start from clean source and package only explicitly selected app resources. Exclude `.runtime/`, `outputs/` from the source snapshot, credentials, session records, environment files, saved chat IDs, account data, and personal preferences. Never package an existing local app or copy the user's Application Support directory. Node.js downloads must be checked against the published SHA-256 sums, and bundled third-party notices must accompany the runtime. Sign the finished app ad hoc after assembling its resources, verify the signature and architecture, and publish ZIP checksums in `SHA256SUMS.txt`.

Ad hoc signatures do not identify the publisher through Apple and do not provide notarization. Release notes and installation instructions must state this limitation. The [user guide](./guide.md#install-a-release) describes Apple's per-app first-launch flow; release packages must not change Gatekeeper settings.

`outputs/`, `.runtime/`, `dist/`, and environment files are excluded by `.gitignore`. The public screenshot is stored in `docs/screenshots/`. Release archives are attached to GitHub Releases; local build and validation artifacts stay outside the repository.

See [SECURITY.md](../SECURITY.md) for security protections, data scope, and reporting guidance.
