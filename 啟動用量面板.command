#!/bin/zsh
set -e
cd "$(dirname "$0")"
panel_node="$(command -v node || true)"
if [[ -z "$panel_node" ]]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then panel_node="$candidate"; break; fi
  done
fi
if [[ -z "$panel_node" ]]; then
  print '找不到 Node.js。請安裝 Node.js 22.18 以上版本，再開啟此檔案。'
  read '?按 Return 關閉…'
  exit 1
fi
panel_app="$PWD/outputs/CodexUsage.app"
panel_build=false
if [[ ! -x "$panel_app/Contents/MacOS/CodexUsage" ]]; then panel_build=true; fi
for source in native/*.swift src/*.ts scripts/build-native.mjs; do
  if [[ "$source" -nt "$panel_app/Contents/MacOS/CodexUsage" ]]; then panel_build=true; break; fi
done
if $panel_build; then "$panel_node" scripts/build-native.mjs; fi
open "$panel_app"
print '已開啟原生用量面板，請看 macOS 上方選單列的 C 百分比。'
