# Progress

Baseline `26b0e1eb` (upstream/main, 2026-09-01). Status as of 2026-09-01.

## Workstreams

| # | workstream | status | notes |
|---|---|---|---|
| W0 | Repo, fork layout, tracking docs | **done** | `linux` branch off `upstream/main`; docs in `docs/linux-port/` |
| W1 | Green the test suite (26 failures) | not started | see the ledger below |
| W2 | **Log discovery under Wine/Proton** | not started | the one hard blocker |
| W3 | Presence on X11 | not started | overlay auto-hide + cursor ring |
| W4 | Packaging | blocked on [O1](DECISIONS.md#o1--packaging-target) | may be near-zero work |
| W5 | Speech: `vcRuntime` no-op on Linux | not started | small; unblocks the Kokoro question |

## Verified working on Linux, unmodified (2026-09-01)

- `npm run typecheck` — clean
- `npm run build` — clean
- `cargo build --release` — clean
- `cargo test --release` — **824 / 824**
- App launches: engine spawns, announces port, TCP round-trip, renderer hydrates, **startup 1344 ms**
- `koffi` and `onnxruntime-node` both load from their Linux prebuilts

## Environment (dev box)

- Debian, X11 (`XDG_SESSION_TYPE=x11`), Node v20.20.1, npm 10.8.2, Rust 1.98.0 (pinned by
  `engine/rust-toolchain.toml`, installed via rustup)
- `npm ci` needs `npm run deps:electron` afterwards — `.npmrc` sets `ignore-scripts=true`, so
  Electron's own binary is not fetched by the install
- Real log for testing: `…/compatdata/3695821840/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Jabartik_qeynos.txt` (101 MB, character Jabartik, server qeynos)

## W1 — the failure ledger

26 failed, 6 cancelled (cascades). Grouped by file and suspected cause; the cause column is a
hypothesis from the failure text, to be confirmed by whoever fixes it.

| file | n | suspected cause |
|---|---|---|
| `enginePackaging` | 1 | test hardcodes `engined.exe`; **the code is already correct** |
| `bundledImages` | 1 | fixture is a `C:/…` path — `isAbsolute` is false on Linux |
| `outputsAchievements` | 2 | CRLF fixture vs LF checkout — see [D7](DECISIONS.md#d7--the-crlf-fixture-gets-a-gitattributes-pin) |
| `speechEngine` | 5 (+cascades) | worker never settles; "Promise resolution is still pending" |
| `imageCacheHeal` | 5 | heal path warns correctly but `imageCacheReadFailures` counter reads 0 |
| `setupSnapshot` | 3 | child-process-loss counters read 0 |
| `dataServerTransport` | 3 | framing-limit / closed-peer assertions |
| `dataServerOps` | 2 | op-mismatch and notFound assertions |
| `errorReportProducer`, `bootErrorReports`, `feedbackGate` | 4 | error-report shape / gate |

**Note:** `imageCacheHeal`, `setupSnapshot` and the transport failures are *not* obviously
Windows-coupled — they may be genuine shared-state or event-loop-ordering bugs that Windows
timing hides. Do not assume they are path bugs; read each one.

## Log

- **2026-09-01** — Cloned upstream, established the fork, measured the baseline (above), wrote
  GOAL/DECISIONS/BACKPORT/PROGRESS. Headline finding: the Rust engine and the whole TS app build,
  test and run on Linux with **zero source changes**; the port is four seams, not an application.
