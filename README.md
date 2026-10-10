<p align="center">
  <img src="docs/assets/readme-hero.svg" alt="Codex Usage — Your limits. At a glance. A native macOS menu bar app." width="1000">
</p>

<h1 align="center">Codex Usage</h1>

<p align="center">
  Remaining allowance, reset countdowns, and chat tokens.<br>
  A small native panel that stays in your macOS menu bar.
</p>

<p align="center">
  <strong>macOS 13+</strong> &nbsp;·&nbsp; SwiftUI + AppKit &nbsp;·&nbsp; Apple Silicon + Intel
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &nbsp; / &nbsp;
  <a href="#the-panel">The panel</a> &nbsp; / &nbsp;
  <a href="docs/guide.md">User guide</a> &nbsp; / &nbsp;
  <a href="SECURITY.md">Security</a>
</p>

---

## The panel

<p align="center">
  <img src="docs/screenshots/usage-panel.png" alt="Actual Codex Usage app: remaining short-term and weekly allowance, reset countdowns, cumulative chat tokens, and estimated API USD equivalent." width="360">
</p>

<p align="center">
  <sub>Actual usage screenshot · Traditional Chinese interface · Taipei time</sub>
</p>

**Your allowance, at a glance.** Two rows of percentages show the remaining short-term and weekly allowance in a compact **32 pt** menu bar indicator. One click opens the **336 × 330 pt** panel. It follows your macOS light or dark appearance.

| In the menu bar | Inside the panel |
| :--- | :--- |
| Remaining short-term allowance | Reset countdowns and exact reset times |
| Remaining weekly allowance | Cumulative tokens for one selected chat |
| A compact indicator with no Dock icon | Input/output details and an estimated USD equivalent |

The USD equivalent uses API pricing. **It is an estimate, not a ChatGPT/Codex subscription bill or an actual charge.** Screenshot values and reset times change with account usage.

## Quick start

### 1. Prepare your Mac

| Requirement | Version or setup |
| :--- | :--- |
| macOS | **13 or later** |
| Node.js | **22.18 or later** |
| Apple Command Line Tools | Swift; install with `xcode-select --install` |
| Codex CLI | Signed in with ChatGPT using `codex login`, or an existing local Codex/ChatGPT app sign-in |

There are **no third-party npm dependencies**. You can build directly without running `npm install`.

### 2. Build and open

```sh
git clone https://github.com/macacacacaca/codex-usage-panel.git
cd codex-usage-panel
npm run build:native
open outputs/CodexUsage.app
```

The build creates an app for your Mac's architecture with an ad hoc signature. The panel opens on launch, runs without a Dock icon, and does not require an open terminal or browser.

### 3. Choose a chat

Open settings in the panel's upper-right corner and paste a chat ID from a `codex://threads/<ID>` link. The app remembers your selection. Leave the field blank to stop tracking.

The panel tracks **one selected chat**; switching chats in Codex does not change it automatically. It runs as a standalone macOS app, with a Traditional Chinese interface and Taipei time.

## Everyday use

- **Open or close:** click the menu bar percentages. Escape or the × button closes the panel.
- **See token details:** click the token card. Use the back button to return.
- **Adjust pricing:** select API Standard or Fast in settings. This changes the estimate's pricing scenario.
- **Quit:** choose Quit in settings, right-click the menu bar indicator, or use the [stop script](./停止用量面板.command).

You can also use the [launch script](./啟動用量面板.command), which builds the app on first use. Account limits refresh every **60 seconds**; local chat tokens update every **10 seconds**. Automatic launch at login is not configured.

If the menu bar is crowded, switch to Finder, then hold **⌘** and drag the indicator toward the clock. See the [full usage guide](./docs/guide.md#launch-and-quit) for service management and menu bar limitations.

## Privacy by design

The panel reuses sign-in managed by Codex CLI and reads usage through the official Codex App Server. It does not read or copy credential files or start model conversations.

- **Local service:** binds to `127.0.0.1`, validates request origins, and requires same-origin JSON for writes.
- **Account isolation:** verifies identity before and after reads; account email and IDs stay out of the frontend and logs.
- **Limited chat data:** keeps only session identity, model information, and token counters while reading records. Regular messages are skipped.
- **Minimal storage:** token values are not saved separately. Runtime files contain process metadata and your selected chat ID, with no credential or account snapshots. The build does not bundle your tracking ID.

Use this as a local tool for your macOS user. Do not expose the service to the internet through a proxy, tunnel, or port forwarding. See [security and privacy guidance](./SECURITY.md) (Traditional Chinese) for protections and private vulnerability reporting.

## Go deeper

| Read | Find |
| :--- | :--- |
| [User guide](./docs/guide.md#launch-and-quit) | Launch, quit, settings, menu bar placement, and runtime files |
| [Data and refresh behavior](./docs/guide.md#data-features-and-web-development-version) | Native refresh intervals, the web development version, and recovery |
| [Tokens and USD estimates](./docs/guide.md#tokens-and-usd-equivalent) | Chat selection, account checks, pricing assumptions, and the formula |
| [Sign-in and data sources](./docs/guide.md#sign-in-and-data-sources) | App Server protocol, identity checks, and local HTTP boundaries |
| [Development](./docs/development.md) | Commands, source map, testing, and secret scanning |
| [Known limitations](./docs/guide.md#known-limitations) | CLI compatibility, polling, and unsupported features |

---

<sub>Design inspiration: <a href="https://www.awwwards.com/sites/reflect">Reflect — Awwwards Honorable Mention, May 11, 2023</a>. Original banner artwork and layout adapted for GitHub Markdown.</sub>
