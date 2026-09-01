# The Linux port — goal and scope

**Fork of** [jmoyers/everquest-companion](https://github.com/jmoyers/everquest-companion)
at `26b0e1eb` (`upstream/main`, 2026-09-01). Branch `linux`.

## The goal

Run EQ Legends Companion natively on Linux, against an EverQuest client running under
Wine/Proton — **while staying mergeable with upstream forever**. Upstream is under active
daily development; a port that drifts is a port that dies. Backportability is not a nice-to-have
here, it is the primary design constraint, and it outranks elegance everywhere the two disagree.

## What "native" means here, and what it does not

The app is a **Linux Electron process** reading a log file that a **Windows EverQuest process**
writes inside a Wine prefix. The app is NOT run under Wine. Only the game is. Everything the app
touches is an ordinary Linux path that happens to live under `…/pfx/drive_c/…`.

## What we found before writing a line of code (2026-09-01, measured, not assumed)

The port is far smaller than the README implies. On a stock Debian box, at the baseline commit,
with zero source changes:

| | result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean (main + preload + 4 renderer entries) |
| `cargo build --release` | clean |
| `cargo test --release` | **824 passed, 0 failed** |
| `npm test` | 4137 passed, **26 failed**, 6 cancelled |
| `npx electron out/main/index.js` | **launches, engine spawns, TCP connects, renderer hydrates in 1.3s** |

The Rust engine — the log parser and the whole fold, i.e. the actual product — contains **no
`target_os`, no `windows`/`winapi` crate, and no `.exe` assumption**. It was already portable.
Both native npm deps ship Linux prebuilts (`koffi/build/koffi/linux_x64`,
`onnxruntime-node/bin/napi-v3/linux`).

So this is not a port of the application. It is a port of **four seams around it**:
log discovery, foreground-window presence, packaging, and a test suite that asserts Windows.

## Scope

**In scope** — the things that make the app useful on this machine:
1. **Log discovery under Wine/Proton prefixes.** The one hard blocker. The app currently looks in
   `C:\Users\Public\Daybreak Game Company\…` and finds nothing.
2. **The 26 failing tests**, so the suite is a real gate on Linux instead of noise.
3. **Presence** (foreground window, cursor) on X11 — this drives overlay auto-hide and the cursor
   ring. Degrades cleanly rather than breaking where it cannot be answered.
4. **Packaging** a Linux artifact.

**Out of scope, deliberately** — and each of these is a Windows *platform* feature, not a product
feature we are dropping:
- **NSIS installer, SmartScreen, code signing, the `eq-tools` migration** — Windows installer
  concepts with no Linux analogue.
- **The MSVC runtime fetch** (`speech/vcRuntime.ts`) — it downloads `VCRUNTIME140.dll` for a
  Windows ONNX binding. On Linux it is a no-op, not a port.
- **Registry discovery** (`native-reg`) — stays, guarded; it is already lazy and already fails
  soft. There is no registry to read.
- **Process priority** — already a documented no-op off Windows. A `nice(2)` equivalent is a
  separate, arguable change and not this port's business.
- **Telemetry/feedback backend, AWS infra, the wiki scrapers** — untouched, they are
  platform-neutral already.

## Definition of done

- `npm test` and `cargo test` green on Linux.
- The app finds the real log at
  `~/.steam/debian-installation/steamapps/compatdata/3695821840/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Jabartik_qeynos.txt`
  with no manual configuration, and shows a live DPS meter from it.
- Overlays draw on top of the game and auto-hide with it.
- A `git merge upstream/main` over a week of upstream commits lands with conflicts only in files
  this port deliberately owns.
