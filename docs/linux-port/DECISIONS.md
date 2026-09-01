# Design decisions

Append-only. Each entry states the decision, the alternative, and why — so a future merge
conflict can be resolved by someone who was not here.

---

## D1 — Backportability outranks elegance
**Decided.** Upstream ships daily and this fork is worth nothing the moment it cannot take those
commits. Every structural choice below is the one that minimises merge surface, even where a
cleaner refactor exists. Procedure and the ownership ledger: [`BACKPORT.md`](BACKPORT.md).

## D2 — The app is a native Linux process; only the game runs under Wine
**Decided.** The alternative — run the existing Windows build under Wine — was rejected outright:
`shared/wineDetect.ts` exists precisely because that path has a documented history of blank
windows and stuck black overlay boxes, since a transparent frameless always-on-top window is the
one shape whose correctness rests entirely on the compositor doing per-pixel alpha. We would be
porting *onto* the known-bad configuration. Native Electron on X11 does per-pixel alpha properly.

Consequence: every Wine prefix is just a directory to us. No Wine API, no `winepath`, no
`z:\` translation — `drive_c` is a folder.

## D3 — Log discovery sweeps prefixes; it does not ask Steam
**Decided.** The real install on the dev box is Steam appid **3695821840**, which is above 2^31 —
that is a *non-Steam-game shortcut*, an id Steam generates per-user. There is no stable appid to
look up, so any "ask Steam for EQ Legends" approach is dead on arrival. Discovery sweeps
`steamapps/compatdata/*/pfx` and looks for the Daybreak subpath in each, which is the same
first-hit-wins shape `discoverEqRoot` already uses for Windows drive letters.

Prefix roots to sweep, in order: `$WINEPREFIX`, `~/.wine`, Steam `compatdata/*/pfx` across every
library in `libraryfolders.vdf`, Lutris, Bottles, Heroic. First hit that actually contains a
`Logs/` with an `eqlog_*.txt` wins — again, the existing rule, unchanged.

## D4 — Wine paths are resolved case-insensitively, component by component
**Decided.** Windows says `Users\Public`; the real Proton prefix on disk says `users/Public`
(lowercase `u`). Wine's own casing varies by prefix, by creator, and by Proton version, and ext4
is case-sensitive, so a hardcoded Linux spelling is a bug waiting for the next prefix.

So the Linux candidate builder resolves each path component with a case-insensitive `readdir`
match rather than trusting a literal. This lets us reuse upstream's existing `DAYBREAK_SUBPATHS`
table (with `\` → `/`) instead of maintaining a second, divergent copy of it — which is worth
more than the syscalls, and the sweep is bounded and runs once.

## D5 — Presence is X11 through koffi; Wayland degrades, it does not block
**Decided.** `PresenceNative` is a 4-method interface behind a `loadPresenceNative()` factory —
upstream built the seam, we add an implementation behind it.

Two of the four methods need no FFI at all on Linux: `imagePath(pid)` is `readlink
/proc/<pid>/exe`, and `eqRunning()` is a scan of `/proc/*/cmdline`. The other two —
`foreground()` and `cursorShowing()` — go through **koffi against `libX11.so.6`**, deliberately
reusing the exact mechanism and dependency upstream already chose for `user32.dll`. No new
dependency, no N-API addon, no `xdotool` subprocess (upstream's standing rule against spawning a
process to ask a question applies with equal force here).

**Wayland gets no foreground window, by design.** No Wayland compositor exposes "which window is
in front" to an unprivileged client — that is the security model, not a gap. The module already
has a degraded path (`koffi.load` throwing is its one documented failure mode), so Wayland takes
it: no auto-hide, no cursor ring, everything else works. Detected via `XDG_SESSION_TYPE`.

**`eqRunning()` must match the Wine process, not a Linux one.** Under Proton the client is
`eqgame.exe` hosted by a wine loader; its `/proc/<pid>/exe` is the loader, and the EQ path appears
only in `cmdline`. Matching on the image path — which is what the Windows implementation does —
finds nothing.

## D6 — Test fixes are platform-parametric, never Linux-only
**Decided.** Of the 26 failures, most are tests asserting Windows against code that is already
platform-correct (`enginePackaging` expects `engined.exe`; the app under test correctly answers
`engined`). The fix is to make the **test** ask the same question the code answers, so it passes
on both platforms. `skip: process.platform !== 'win32'` is banned as a fix: it deletes coverage
on Windows-only behaviour we have not verified and turns a real gate into decoration.

This also makes those commits upstreamable, which is the cheapest possible merge surface — see
[`BACKPORT.md`](BACKPORT.md).

## D7 — The CRLF fixture gets a `.gitattributes` pin
**Decided.** `tests/outputsAchievements.test.mts` asserts its fixture is CRLF. The blob is **LF**;
the assertion only holds on a machine whose `core.autocrlf` rewrites it at checkout. That is a
test that depends on a developer's local git config — it already fails for any Windows
contributor with `core.autocrlf=input`. Pinning the fixture `text eol=crlf` makes the working
tree match the assertion on every platform. This is a bug fix, not an accommodation.

## D8 — Run from source; no packaged artifact for now
**Decided (owner, 2026-09-01).** `npm run build` plus a `.desktop` launcher is the whole job. An
AppImage is ceremony for a fork that is run on the machine it is developed on by someone who is
pulling upstream anyway and already has the toolchain.

This retires open question O1 and settles O2 with it: **no auto-update on Linux.** Upstream
updates from GitHub Releases and verifies an Authenticode signature; there is no equivalent here
and no release feed for this fork. The app already disables the updater when not packaged
(`Auto-update disabled (dev / not packaged)`), so this costs no code.

Revisit if the port is ever handed to someone else. Nothing in W1–W3 depends on it.

## D9 — Nothing goes upstream until the owner has been asked
**Decided (owner, 2026-09-01).** Every fix stays on this fork's `linux` branch. No pull requests
to `jmoyers/everquest-companion`, including the ones that are plainly Windows bug fixes and would
be accepted on their own merits.

The reason is not technical. Upstream is one person's project with a strong, documented working
model, and a Linux port asks him to take on a platform he does not run and cannot test. That is a
conversation to have with him directly, not something to open with a diff. An unsolicited PR —
even a good one — spends his attention and pre-empts the decision that is his to make.

**Consequence for [`BACKPORT.md`](BACKPORT.md)'s "upstream aggressively" section:** it remains the
correct strategy and the cheapest merge surface we have, and it is on hold. Nothing about how we
write the code changes — keeping every fix upstreamable is still the rule, because it is also what
keeps merges cheap for us. We simply do not send them yet.

**Design consequence, worth doing now while it is free:** name seams by FUNCTION, not by platform.
`linuxPrefixCandidates` is really "additional fully-resolved candidate roots". Named generically,
it is an extension point upstream could take without adopting Linux at all, and our Linux code
stays entirely on our side of it. Cheap now, awkward after the branch has history.

---

# Open

## O3 — Kokoro TTS tier
`onnxruntime-node` ships Linux prebuilts, so the neural voice tier may simply work once
`vcRuntime` is a no-op — but it is 115 MB and DirectML-accelerated on Windows, so Linux would be
CPU-only. Untested. Not a blocker: the bundled voice pack and sound alerts do not go through it.
