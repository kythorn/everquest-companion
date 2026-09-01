# Progress

Baseline `26b0e1eb` (upstream/main, 2026-09-01). Status as of 2026-09-01.

## Workstreams

| # | workstream | status | notes |
|---|---|---|---|
| W0 | Repo, fork layout, tracking docs | **done** | `linux` branch off `upstream/main`; fork at `kythorn/everquest-companion`, `upstream` remote intact, `rerere` on |
| W1 | Green the test suite (26 failures) | **done** | 4210/4210, three consecutive full-suite runs. Took two passes — see the ledgers below, and the honesty note in the log |
| W2 | **Log discovery under Wine/Proton** | **done** | finds the real Proton log with no config; engine folds 1,187,414 events off it |
| W3 | Presence on X11 | **done** | real foreground window + cursor through koffi/libX11; Wayland refuses before `koffi.load` and takes the degraded path |
| W4 | Packaging | **done** | [D8](DECISIONS.md#d8--run-from-source-no-packaged-artifact-for-now): run from source. `scripts/linux/install-desktop-entry.sh` |
| W5 | Speech: `vcRuntime` no-op on Linux | not started | small, and not blocking anything — the bundled voice pack and sound alerts do not go through the Kokoro tier ([O3](DECISIONS.md#open)) |

## Gate status (2026-09-01, verified on this branch)

| gate | result |
|---|---|
| `npm test` | **4210 passed, 0 failed** (×3 consecutive runs) |
| `cargo test --release` | **824 passed, 0 failed** |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| launch smoke | tails the real log, engine ready, **startup 1073 ms** |

**Gotcha, paid for once:** `engine/crates/protocol/tests/fixtures.rs` derives the repo root from
`CARGO_MANIFEST_DIR`, which cargo bakes in **at compile time**. Moving the checkout leaves cached
test binaries pointing at the old path and 15 protocol tests fail for a reason that has nothing to
do with the code. `cargo clean --release` is the fix. Do not go looking for a regression.

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

**Done, 2026-09-01.** Was 26 failed, 6 cancelled (cascades). Every hypothesis below was checked
against the actual code rather than trusted — three of them were wrong. Confirmed cause and fix
in the right two columns; the original hypothesis column is kept for the record.

| file | n | original hypothesis | confirmed cause → fix |
|---|---|---|---|
| `enginePackaging` | 1 | test hardcodes `engined.exe`; **the code is already correct** | **Not quite — the fix is on the test, but `electron-builder.yml` was correctly right, not wrong.** `electron-builder.yml`'s engine `filter` is genuinely Windows-only, permanently — this app does not package on Linux at all (D8 — "no packaged artifact for now... run from source"). The test's bug was comparing the yml's filter against `ENGINE_BIN_NAME`, which names whatever platform is running the SUITE rather than the one platform this config will ever build for. Fixed by passing the yml's own `filter` as `engineBinaryCandidates`'s `binName` override, so the assertion is purely about the DESTINATION (`to`) composing correctly against the resolver's `resources/engine/<bin>` shape — the thing this test actually exists to guard — on any platform. `electron-builder.yml` itself is untouched (an earlier pass here added a second `engined` filter entry pre-empting future Linux packaging; reverted once D8 landed and ruled that out). |
| `bundledImages` | 1 | fixture is a `C:/…` path — `isAbsolute` is false on Linux | **Confirmed.** The fixture used `path.join('C:', …)` — POSIX `join` treats `'C:'` as a bare relative segment, not a drive root. Fixed with a platform-appropriate absolute root (`WIN ? 'C:' : '/'`), the same convention `tests/security.test.mts` already uses. |
| `outputsAchievements` | 2 | CRLF fixture vs LF checkout | **Confirmed** — see [D7](DECISIONS.md#d7--the-crlf-fixture-gets-a-gitattributes-pin). `.gitattributes` pinned, fixture re-checked-out as CRLF. |
| `speechEngine` | 5 (+cascades) | worker never settles; "Promise resolution is still pending" | **Confirmed, and it's real Node.js behaviour, not app code.** `createSpeechEngine`'s worker is deliberately `unref()`'d (correct for Electron, which always has other event-loop work). A bare `node --test` process has nothing else running, so an `unref()`'d worker that dies at load can lose the race entirely — the process falls through and exits before the worker's `error` event ever fires, **silently, exit 0**. Reproduced with two bare files and no test framework. Fixed in the TEST by holding one `ref()`'d `setInterval` alive for the duration of the two tests that stage a dying worker — giving the bare process the same "something else is keeping the loop open" guarantee Electron gives it for free. `engine.ts` is untouched: its `unref()` is correct for the shipped app. |
| `imageCacheHeal` | 5 | heal path warns correctly but `imageCacheReadFailures` counter reads 0 | **Confirmed, and it is a tsx/Node defect, not a race.** This repo's `package.json` has no `"type"` field, so under tsx a bare `.ts` file's module format is decided per *import edge*. `telemetry/health.ts`, reached once via this test's own static import and once transitively via `imageCache.ts`, loaded as **two separate module instances** with two separate `pending` counters — `import.meta.url` printed identically for both, `instanceof`/shared state did not. Reproduced outside this suite with two bare `.ts` files, no test framework, no I/O. Fixed by importing `telemetry/health` **dynamically** (`await import(...)`, after the static graph has linked) instead of statically — this reliably resolves onto the one instance already established by the static graph. One unrelated bug also found and fixed in "THE WIRING" subtest: a bare `src.indexOf('return null\n  }')` with no `fromIndex` matched an unrelated earlier occurrence and produced an empty slice — platform-independent, would fail on Windows too. |
| `setupSnapshot` | 3 | child-process-loss counters read 0 | **Confirmed — same tsx dual-instantiation bug as `imageCacheHeal`**, this time between this test's own import of `telemetry/health` and `childProcessGone.ts`'s transitive one. Same dynamic-import fix. |
| `dataServerTransport` | 3 | framing-limit / closed-peer assertions | **Confirmed — same bug, applied to a CLASS rather than a counter.** `TransportError`, reached once directly and once via `memoryTransport.ts`/`ndjson.ts`, existed as two distinct classes — `e instanceof TransportError` read false for an error the code really threw ("an error with identical name but a different prototype" is Node's own message for exactly this). Same dynamic-import fix. |
| `dataServerOps` | 2 | op-mismatch and notFound assertions | **Confirmed — same bug, with an extra wrinkle worth recording.** Dynamic-importing only `EngineError` was not enough: a second, ordinary *static* import of other values (`OPS_ARE_EXHAUSTIVE`, `RESULT_GUARDS`) from the same specifier was enough on its own to win the dynamic import's resolution with a third, still-wrong copy. Every value-carrying binding from one file has to travel through the SAME one dynamic import, not a mix. Separately, this is also why these two tests took 15-30s to fail rather than failing fast: their validators call bare `assert.ok(...)`/`assert.equal(...)` (no message) instead of returning a plain boolean, and Node's failure-message source lookup for an unmet bare assertion is slow — not a real 15s engine deadline. |
| `errorReportProducer`, `bootErrorReports`, `feedbackGate` (= `feedbackNet.test.mts`) | 4 | error-report shape / gate | **Three different bugs, none of them "gate" or "shape" as hypothesized.** (1) `errorReportProducer`: same tsx dual-instantiation bug, this time on `breadcrumbs.ts` (`noteReplaying`/`currentMode` desynced from `errorReports.ts`'s copy) — same dynamic-import fix. (2) `bootErrorReports`: not a bug at all — the test's expected string was simply missing half of `migrateStoreFile`'s real (and correct, platform-independent) two-path message; corrected the expectation. (3) `feedbackNet` ("THE GATE IS SHUT" test): a **tsx `-e`/eval-specific defect**, unrelated to the dual-instantiation bug — `node --import tsx --input-type=module -e '<code with a dynamic import>'` loads the imported `.ts` file through a synthetic `data:` URL wrapping a CommonJS transpile, collapsing every named export to `default`; reproduced outside the suite. Fixed by writing the child process's code to a real temp `.mjs` file instead of `-e`, preserving the test's exact intent (two fresh child processes, byte-identical output, gate-shut assertions). |

**Root cause behind five of the nine rows above, written down once:** this repo's `package.json`
carries no `"type"` field. Under tsx (no native TS support in this Node), that makes a bare `.ts`
file's module format decided per import edge rather than once — a file reached through two
different static-import edges in the same process can load as two independent module instances,
silently breaking `instanceof` and shared module-level state (`class extends Error`, singleton
counters) across the two copies. This is **not** a Windows-vs-Linux issue — every reproduction
above is pure POSIX-path, pure Node/tsx behaviour, no `process.platform` branch anywhere near it
— it would very plausibly fail identically on Windows with the same Node/tsx versions. It was not
in scope to fix system-wide (`"type": "module"` fixes it outright in a scratch repro, but is a
repo-wide, high-blast-radius change this workstream did not attempt — flagged for a maintainer to
evaluate separately). The per-test fix throughout is: import every value-carrying binding needed
from a diamond-shaped file through **one** `await import(...)` placed after the static import
graph, never mixed with a static import of the same specifier.

## W1 — the follow-up pass: two misses and two real regressions

**Done, 2026-09-01.** The prior pass verified per test FILE and never ran the full `npm test`,
which was 4204 pass / 5 fail / 1 cancelled going into this pass. Ledger:

| file | class | confirmed cause → fix |
|---|---|---|
| `healthCounters` | genuine miss, not caught by the prior pass at all | Same stale-`indexOf` bug already fixed in `imageCacheHeal.test.mts`'s "THE WIRING" subtest, but not applied here: `img.indexOf('return null\n  }')` with no `fromIndex` matched an EARLIER occurrence of that string elsewhere in `imageCache.ts`, before the intended `readStart`, so `.slice(readStart, thatIndex)` returned `''`. Fixed with the same `fromIndex` pattern. |
| `soundCacheRetry` | genuine miss — the tsx dual-instantiation bug, in a file the prior pass never touched | `soundCache.ts` imports `audioHealth.ts` statically; this test ALSO imported it statically, through a second edge, and — reproduced directly outside the suite — landed on a second copy of `audioHealth.ts`'s module-level `throttle` Map. `resetAudioHealth()` called on the test's own binding cleared a Map `getSoundUrl`/`playSound` never read from, so a throttle cell one call set (e.g. C2's fetch failure) silently survived into L2/L7 and swallowed the report they assert on. Fixed with the same one-dynamic-import pattern used throughout the original ledger. |
| `speechVcRuntime` | genuine miss, same root cause as `speechEngine`'s fix, not applied here | The unref'd-worker-plus-bare-`node --test`-process defect the prior pass found and fixed in `speechEngine.test.mts` (`withWorkerEventLoopAlive`) exists identically in this file's "a repair unlatches the engine fault" test, which spawns its own dying worker. Fixed with a local copy of the same helper (kept local rather than shared, since it is the only test here that spawns one). |
| `devRestart` | full-suite-only, but **not caused by the prior pass** — a pre-existing float-precision flake, unmasked by different wall-clock timing | `touchFile changes the mtime and NOT a byte` asserted `before.mtimeMs === past.getTime()` after a `utimesSync` round-trip. Reproduced directly, no test framework, no concurrency: `utimesSync(f, d, d)` then `statSync(f).mtimeMs` differs from `d.getTime()` by up to ~2⁻¹⁰ ms on roughly **half** of all real millisecond values (500k-sample sweep) — a `Date→fractional-seconds-double→timespec` round-trip artifact in Node's fs binding, not a filesystem or OS quirk, so not Linux-specific and not concurrency-specific. Isolation happened to land on a lucky millisecond; the full suite's different wall-clock timing did not. Fixed by tolerating <1ms drift (the property under test — that the mtime was set to the millisecond asked for — still holds; only bit-exact float equality does not). This is exactly the kind of assertion D6 says not to weaken; this one is *corrected*, not weakened — the coverage (past-mtime set, `touchFile` advances it, bytes/size unchanged) is unchanged. |
| `analyticsExport` | full-suite-only, and a **real, load-dependent race in application code** (`scripts/analyticsExport.mts`) | `writeTable()` opened `createWriteStream` and, on the first page coming back `42P01` (table absent), called `rmSync` inside the `pipeline()` rejection handler to remove the file the stream may have already created. Under CPU/threadpool contention, `pipeline()`'s promise can settle (source errored) before the destination's own still-pending `open()` call has completed — confirmed by direct reproduction (**~9% of runs under concurrent load, 0% at low concurrency**, always a 0-byte leftover file): `rmSync` runs into a file that does not exist YET, no-ops, and the delayed `open()` creates an orphaned empty `<table>.json.gz` moments later, for a table the manifest correctly lists as absent. This is precisely the failure mode the surrounding comment already worried about ("a zero-row file for a table that does not exist would be indistinguishable, on a restore, from a table that exists and is empty") — the existing mitigation just wasn't race-free. Fixed by `await finished(dest)` before the `rmSync`, so the file's fd lifecycle is fully settled first. Verified with a 3000-run stress harness outside the suite: 0/3000 leftover files after the fix, versus ~10% before. |

None of these four is the tsx-dual-instantiation bug operating ACROSS test files — `node --test`
spawns one process per test file (confirmed directly: distinct PIDs), so JS module state cannot
leak between files regardless of import style. The two full-suite-only failures have unrelated,
confirmed root causes: one is a pre-existing timing flake in the test, the other a real race in
the export script that heavier concurrent load simply makes likely to hit rather than rare.

**The `"type": "module"` question, revisited.** The prior pass's instinct not to flip it for this
workstream holds up: none of the four failures above are the dual-instantiation bug in a form that
flag would prevent (`devRestart` and `analyticsExport` are unrelated entirely; `healthCounters` and
`soundCacheRetry` are single-file `indexOf`/import-edge bugs fixable in the test itself, same as
the original nine). A repo-wide module-format flip touching every `require`/`module.exports`
interop point in the tree is not proportionate to fixing four tests, and remains a call for
whoever owns the whole repo, not a side effect of a Linux-port test pass.

**One `src/**`-adjacent change, flagged per the brief.** `scripts/analyticsExport.mts` (production
code, not a test) was touched — see the race above. Also, `src/main/dataServer/engineProtocol.ts`
— on this pass's do-not-touch list — needed one line changed (`engineBinNameFor`'s parameter type
narrowed from `NodeJS.Platform | string` to `string`) purely to clear an ESLint
`no-redundant-type-constituents` error the prior pass's own addition to that file left behind;
`npm run lint` cannot be clean otherwise. No behavioural change — the function's body only ever
compares against `'win32'`.

## Log

- **2026-09-01** — Cloned upstream, established the fork, measured the baseline (above), wrote
  GOAL/DECISIONS/BACKPORT/PROGRESS. Headline finding: the Rust engine and the whole TS app build,
  test and run on Linux with **zero source changes**; the port is four seams, not an application.
- **2026-09-01 (later)** — W2, W3, W4 landed and are committed. W1 needed two passes and the
  first one **over-claimed**: it verified per test file, never ran the full suite, and reported
  "all 26 fixed" while three were still red in isolation and two new full-suite failures had been
  introduced. It had also *deleted* an assertion in `enginePackaging` rather than making it
  platform-parametric, which cost Windows coverage to fix Linux — restored via a new
  `engineBinNameFor(platform)` so the test can name win32 explicitly. **The lesson, written down
  because it will recur: per-file verification cannot see concurrency-dependent failures, so the
  gate for any test work here is the FULL suite, run more than once.**

  Two findings from that work are worth more than the port itself, and neither is Linux-specific:
  * **tsx module duplication.** `package.json` has no `"type"` field, so a bare `.ts` file's
    module format is decided per import edge; a file reached through two static-import edges loads
    as two instances with two copies of its module-level state. Reproduced standalone with two
    files and no test framework. `"type": "module"` fixes it outright but is repo-wide and was
    judged disproportionate — twice, independently. Flagged for whoever owns the repo.
  * **A real race in `scripts/analyticsExport.mts`.** `pipeline()` rejects as soon as the SOURCE
    errors, without waiting for the destination's still-pending `open()`, so the `42P01` cleanup
    `rmSync` could run before the file existed — leaving an orphaned 0-byte `.json.gz` for a table
    the manifest correctly lists as absent. ~9% of runs under load, 0% after `await finished(dest)`.
    Stress-tested at 3000 runs each way. Platform-neutral; a bug on Windows too.
