#!/usr/bin/env bash
# Build what is stale and launch the app from this checkout (D8: run from source).
#
# There are TWO build products and forgetting the second is the classic mistake: `npm run build`
# compiles the Electron app, but the engine — the Rust binary that actually parses and folds the
# log — is a separate cargo build the app only ever LOOKS for. Miss it and the app launches
# perfectly and shows you nothing, which reads as a bug in the app rather than a missing binary.
# This builds both, and skips either if it is already current.
#
#   ./scripts/linux/run.sh            build what is stale, then run
#   ./scripts/linux/run.sh --clean    force both builds first
#   ./scripts/linux/run.sh --no-build just run what is already built
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
ENGINE_BIN="engine/target/release/engined"

case "${1:-}" in
  --no-build) ;;
  *)
    if [[ "${1:-}" == "--clean" ]]; then
      "$CARGO" clean --release --manifest-path engine/Cargo.toml
      rm -rf out
    fi
    # The engine first: it is the slow one, and a failure here should stop us before we spend
    # time on a renderer bundle we would not be able to feed.
    echo "==> engine (cargo build --release)"
    "$CARGO" build --release --manifest-path engine/Cargo.toml
    [[ -x "$ENGINE_BIN" ]] || { echo "engine did not produce $ENGINE_BIN" >&2; exit 1; }
    echo "==> app (electron-vite build)"
    npm run build
    ;;
esac

[[ -f out/main/index.js ]] || { echo "no build at out/main/index.js — run without --no-build" >&2; exit 1; }
[[ -x "$ENGINE_BIN" ]] || echo "WARNING: $ENGINE_BIN missing — the app will start but fold nothing" >&2

# Settings/alerts live in the 'dev' channel dir, because CHANNEL is app.isPackaged ? prod : dev
# (src/main/channel.ts) and a run-from-source launch is never packaged.
echo "==> launching (userData: ~/.config/everquest-companion-dev)"
exec ./node_modules/.bin/electron out/main/index.js "${@:2}"
