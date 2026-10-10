#!/bin/zsh
set -e
cd "$(dirname "$0")"
panel_node="$(command -v node || true)"
if [[ -z "$panel_node" ]]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then panel_node="$candidate"; break; fi
  done
fi
if [[ -z "$panel_node" ]]; then print '找不到 Node.js。'; exit 1; fi
"$panel_node" scripts/build.mjs
print '網頁測試版：http://127.0.0.1:4317'
exec "$panel_node" src/server.ts
