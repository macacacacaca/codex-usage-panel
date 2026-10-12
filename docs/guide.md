# Codex Usage Reference

[← Back to the project](../README.md)

Detailed behavior, data sources, pricing, and limitations for the native app and retained web development version.

## Install a Release

Download the Apple Silicon or Intel ZIP for your Mac from [GitHub Releases](https://github.com/macacacacaca/codex-usage-panel/releases/latest), unzip it, move `CodexUsage.app` to Applications, and open it. Releases require macOS 13.5+ and an installed Codex app or CLI signed in with ChatGPT. They include Node.js 24.21.0 and the local service, so no development tools are needed. They do not include Codex, credentials, session records, or personal runtime settings. Version 0.3.5 follows your signed-in account and shows local consumption within its current 5-hour quota period; no chat ID is required.

The app is ad hoc signed and has no Developer ID signature or Apple notarization. If the first launch is blocked, try opening it, then use **System Settings → Privacy & Security → Open Anyway** and confirm **Open** if you trust the download. [Apple documents this per-app exception](https://support.apple.com/102445).

Release ZIP checksums are supplied in `SHA256SUMS.txt`. The ZIP contains `CodexUsage.app`; choose `arm64` for Apple Silicon or `x86_64` for Intel. Updates currently use the same manual download-and-replace process; quit the existing app before replacing it. Personal settings stay in your macOS user account, outside the app bundle.

## Launch and Quit

1. Open `CodexUsage.app` in Applications. For a source build, double-click `outputs/CodexUsage.app` or use the [launch script](../啟動用量面板.command), which builds the app automatically on first use. The panel opens on launch. Afterward, click the **two rows of percentages** in the macOS menu bar to open it. Opening the app again while it is running also expands the panel.
2. Click the menu bar indicator to expand or collapse the panel. The × button in the upper-right corner and Escape also close it; right-click the indicator to open the panel or quit. The app has no Dock icon and does not require an open terminal.
3. Choose Quit in the upper-right settings page. Source users can also double-click the [stop script](../停止用量面板.command). The app stops the data service it started. If it reused another instance's service, that service remains running.
4. To reopen the app, double-click it again. Automatic launch at login is not configured, and the app does not modify system login items.

If another app's menus or the screen notch hide the indicator, switch to Finder without quitting your current app, then **hold ⌘ and drag the two rows of percentages toward the clock**. Native `NSStatusItem.autosaveName` preserves the position. macOS provides no public API to force the indicator to the far right or guarantee that it stays visible.

Token Details opens a separate page with input, cached input, output, total tokens, and USD values from verified local requests in the current account's active 5-hour quota period. Use the upper-left back button to return. Settings also uses a separate page. Missing period information shows unavailable consumption; incomplete local data shows a labelled token subtotal and withholds USD.

The visual design in version 0.3.2 takes inspiration from [Reflect's Awwwards entry](https://www.awwwards.com/sites/reflect): adaptive dark and light backgrounds, thin lavender and muted blue progress bars, subtle borders, and separate font sizes for numbers and percentage signs. Click anywhere on the main token card to see details. API Standard/Fast pricing scenarios and Quit are available in the upper-right settings page. The panel remains 336 × 330 pt, with a 32 pt menu bar indicator.

The app manages its local data service automatically. HTTP/SSE is used for internal data transfer, so users do not need to open a URL. Native process records and startup logs that exclude sensitive data are stored in `~/Library/Application Support/CodexUsage/runtime/`. Native pricing preferences are stored in UserDefaults; token data is not saved separately. Older installations can retain legacy tracking settings, but version 0.3.5 requires no manual chat selection. If an older service occupies port 4317, quit the old app before opening the new version.

Release packages bundle Node.js **24.21.0**. Local validation used that version on Apple Silicon. The app prefers the CLI executable bundled with the local Codex or ChatGPT app.

The native app uses port 4317 and can reuse a service of the same version that exposes the native endpoints. Running one usage tool at a time is recommended. This is a standalone macOS menu bar app, separate from the Codex app.

## Data Features and Web Development Version

The native app refreshes official account limits every 60 seconds, treating the persistent menu bar indicator as visible. Verified local requests in the current quota period are aggregated every 10 seconds, including archived-session records. The web version remains available for development using `npm start` or `啟動網頁測試版.command`; it uses the same account and period scope. The configurable refresh intervals, browser preferences, and Alt+R shortcut below apply to the web version.

- Displays short-term, long-term, and other allowance categories supplied by the source. Percentages and progress bars show the **remaining** allowance.
- Refreshes every 30, 60, or 120 seconds while visible, depending on settings. After being hidden for more than one minute, it refreshes every five minutes. With multiple panels, the shortest interval among visible panels is used.
- Background refreshes keep cards visible. Failed reads retain the last snapshot for a verified identity. After 120 seconds without a successful read, the display is marked as stale.
- Recalculates countdowns every 30 seconds from the absolute reset time. At zero, the service reads again; the allowance is not shown as replenished until that read succeeds.
- Supports manual refresh, live SSE status, a 15-second deadline for a complete read, and retry backoff of 15, 30, 60, 120, and 300 seconds with jitter.
- Stores system/light/dark theme, time zone, and refresh preferences in the browser. Account and allowance data remain in process memory.
- Uses a native browser dialog for settings, closed with Escape. All controls support Tab navigation; **Alt+R** refreshes. Countdown updates are not announced through a screen reader live region.
- Shows available resets only when the source provides them. The panel cannot use resets or purchase allowance.
- Reads the current account's local token records every 10 seconds and aggregates request deltas within the active 5-hour quota period without increasing account API polling. API Standard/Fast USD conversion can be selected.

## Tokens and USD Equivalent

Token consumption follows the currently verified Codex account's **active 5-hour quota period** in both the native app and the web development version. Its boundaries come from the official Codex quota response: `start = reset time − 300 minutes` and `end = reset time`, with `windowDurationMins` required to equal **300**. A request is included when its timestamp is at or after the start, before the reset, and no later than the current time. This is a fixed quota interval, not a rolling “last five hours.”

The main count, input/output details, and USD estimate use **per-request token deltas** from the current account's verified `sessions/` and `archived_sessions/` records on this Mac. Cumulative session counters are used to verify deltas, not added as lifetime totals. Model, cache, and output pricing applies only to included requests in this interval. No manual chat ID is required; account changes or sign-out clear previous counters.

### Free Auto-Review Checks

For ChatGPT sign-ins, OpenAI treats auto-review safety checks as free and outside plan usage limits. [OpenAI's guidance](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan). Version 0.3.5 recognizes the exact local model ID `codex-auto-review`, removes its request deltas from current-period consumption and pricing segments, and reports them separately as excluded safety-review tokens in details.

When a period contains a supported paid model and these free checks, the paid requests can receive a USD estimate without treating the checks as an unknown paid model. Supported paid requests still use official API rates. Other unknown model IDs remain unpriced; the app does not substitute a model alias or reference rate. Missing or incomplete data can still withhold USD.

### Local Scope and Pricing

**Local consumption has a narrower scope than account quota.** Other-device and cloud activity may consume quota without producing records on this Mac. The app does not infer tokens or dollars from quota percentages, and account lifetime totals are not used for the current-period count or estimate. Official quota updates can lag activity.

If no unexpired 300-minute Codex window is available, consumption is unavailable. Missing reset information, an expired reset, or ambiguous quota categories cannot define a period. Missing request timestamps, counter gaps, unreadable records, or incomplete pricing metadata can leave a labelled token subtotal; USD is withheld rather than pricing partial data.

Active and archived copies of the same session are counted once. Forked sessions exclude inherited parent counters when the record boundary can be verified; ambiguous forks are excluded. Unreadable or incomplete records withhold USD estimates instead of presenting a price for partial data.

When reading Codex session JSONL records, the service retains only session identity, timestamps, model information, and `token_count` counters. It matches `creator_account_id` against the verified account's usage `accountId`; records with missing or mismatched ownership are excluded. Reads are incremental, and duplicate events are not counted twice. Truncated or missing files, model changes, and incomplete records trigger revalidation. Regular chat messages are skipped and are not sent to the frontend, logs, or other services. Token data is not saved separately.

The estimated USD equivalent uses [official API pricing](https://developers.openai.com/api/docs/pricing). **It is not a ChatGPT/Codex subscription bill or an actual charge.** API Standard is the default pricing scenario; Fast (2×) can be selected in settings. This is a user-selected pricing scenario, not an indication of the execution speed recorded in the session. Pricing was checked on **2026-10-12**, with support for `gpt-6.1-sol`, `gpt-6-astra`, and `gpt-6-luna`. For a single request with more than 272,000 input tokens, input, cached input, and cache-write rates are multiplied by 2, and output rates by 1.5, before applying the selected scenario.

For each included paid request: `(uncached input × input rate + cached input × cached-input rate + cache writes × cache-write rate + output × output rate) ÷ 1,000,000`; the panel sums those estimates within the period. Uncached input excludes cached input and cache writes. Reasoning tokens are already included in output and are not added again. Free `codex-auto-review` requests are excluded before this sum. If timestamps, counters, the model, token breakdown, events, or per-request length are incomplete, the app shows “—” instead of a partial price. Estimates exclude tools, storage, regional surcharges, and other charges. Update `src/tokens.ts` when prices change.

The quota period is revalidated against the current time and refreshed account limits. At reset, the app waits for a valid new interval rather than showing the previous period as current. Local aggregation updates every 10 seconds, but polling does not guarantee immediate cloud data or a cross-device token breakdown.

## Sign-In and Data Sources

Data comes from the official [Codex App Server](https://learn.chatgpt.com/docs/app-server). The app launches `codex app-server --listen stdio://` and completes the `initialize`/`initialized` handshake. The adapter allows only `initialize`, `account/read`, `account/rateLimits/read`, and `account/usage/read`; it does not start model conversations. A failed token history endpoint does not disable allowance tracking.

The panel reuses ChatGPT sign-in managed by Codex CLI without reading or copying credential files. If you are not signed in, run `codex login` in a terminal, complete the official flow, and refresh. API key and Bedrock sign-ins do not provide the subscription allowances required by this panel; the app displays an explanation.

The service checks the signed-in identity using `account/read` before and after each read and requires an `accountId` in allowance responses. The raw email is used only in memory to compute an identity digest, and `accountId` is used only for internal account isolation. Neither is sent to the frontend or logs. Old data is cleared when identity cannot be verified, on sign-in notifications, or when App Server disconnects. Temporary allowance read failures may retain a snapshot from the same verified sign-in session.

The service binds only to `127.0.0.1`. It validates Host, Origin, and cross-site requests, does not enable CORS, and requires same-origin JSON for POST requests. Pages accept only their own scripts and styles; APIs expose only normalized allowance and token information. Runtime files store process and instance metadata, with no account snapshots, token snapshots, or credentials; legacy tracking settings from an older installation may remain. Do not expose this service to the internet through a reverse proxy.

## Known Limitations

- Release apps have ad hoc signatures and are not notarized by Apple; first launch can require a per-app Gatekeeper exception. There is no automatic updater.
- Codex itself is not bundled. An existing Codex app or CLI installation with ChatGPT sign-in is required.
- The Codex CLI/App Server protocol continues to change. This version was checked against the TypeScript schema generated by CLI **0.162.0-alpha.2**. Repeat connection checks and validation after updating the CLI.
- The current `account/read` schema does not provide a separate account ID. The panel uses a digest of the sign-in email together with the usage response's `accountId`, checking identity before and after reads. Allowance data is hidden if either identity field is missing.
- A separate App Server is not guaranteed to receive usage notifications generated by other clients, so polling remains necessary. Sparse notifications trigger a complete reread.
- Consumption requires an active 300-minute Codex quota window. If an explicit `codex` quota category exists, it supplies the window; a legacy response without a limit ID is normalized to `codex`. Multiple unrelated categories do not establish a Codex period.
- Counts and USD cover verified local requests in that period on this Mac. Missing or incomplete records can prevent a complete estimate; cloud and other-device activity may be absent.
- Desktop notifications, historical trends, and purchasing or consuming resets are not supported.
- Background browser timers may be throttled. The shared service continues polling, and becoming visible again or waking the computer triggers a refresh.
