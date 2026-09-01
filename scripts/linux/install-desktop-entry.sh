#!/usr/bin/env bash
# Install a desktop entry for a RUN-FROM-SOURCE build (docs/linux-port/DECISIONS.md D8).
#
# There is no installer on this port and deliberately so: the app is built and run out of the
# checkout by someone who is already pulling upstream. All this does is make that checkout
# launchable from the desktop like anything else, so the companion can be started while the game
# is up without a terminal.
#
# It writes ONE file into the user's own XDG data dir and touches nothing system-wide, nothing
# under /usr, and nothing needing root. Re-running it is how you update it; `--uninstall` removes
# it. The Exec line points at this checkout by absolute path — move the checkout and re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ENTRY="$APPS/everquest-companion.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$ENTRY"
  echo "removed $ENTRY"
  update-desktop-database "$APPS" 2>/dev/null || true
  exit 0
fi

# The built main entry, not a dev server: `npm run dev` wants a terminal it can own and a watcher
# nobody launching from a desktop icon asked for.
if [[ ! -f "$ROOT/out/main/index.js" ]]; then
  echo "no build found at $ROOT/out/main/index.js — run 'npm run build' first" >&2
  exit 1
fi

mkdir -p "$APPS"
cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=EverQuest Companion
Comment=Live DPS meter and log analysis for EverQuest Legends
Exec=$ROOT/node_modules/.bin/electron $ROOT/out/main/index.js
Icon=$ROOT/build/icon.png
Terminal=false
Categories=Game;Utility;
StartupWMClass=everquest-companion
DESKTOP

chmod +x "$ENTRY"
update-desktop-database "$APPS" 2>/dev/null || true
echo "installed $ENTRY"
echo "  exec: $ROOT/node_modules/.bin/electron $ROOT/out/main/index.js"
echo "re-run after 'npm run build' if you move this checkout; '--uninstall' removes it."
