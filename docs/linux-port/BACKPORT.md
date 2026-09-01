# Tracking upstream

Upstream ships daily. This file is the procedure that keeps that cheap.

## Layout

```
upstream/main   jmoyers/everquest-companion, never committed to
linux           this port; the only branch we write
```

```bash
git fetch upstream
git merge upstream/main        # on `linux`
```

## The rule that makes merges cheap

**Prefer a platform branch inside an existing file over a new parallel file; prefer a new file
under an existing seam over editing many.** Concretely, in descending order of preference:

1. **Extend an existing platform switch.** `ENGINE_BIN_NAME` already reads
   `process.platform === 'win32' ? 'engined.exe' : 'engined'`. Upstream wrote that seam; use it.
2. **Add a `linux*.ts` sibling behind an existing factory.** `loadPresenceNative()` is a factory
   returning a 4-method interface. A `presenceNativeLinux.ts` chosen by one `if` inside that
   factory is a 3-line diff in the file upstream edits, plus a file upstream will never touch.
3. **Only then, edit upstream logic in place** — and when you do, keep the hunk small and
   contiguous, because a merge conflict is resolved by reading the hunk.

**Never reformat, re-order imports, or "tidy" a file this port does not functionally change.**
A whitespace diff in a hot upstream file costs a conflict on every future merge and buys nothing.

## Fix the test, not just for us

Several of the 26 failures are tests asserting `engined.exe` or a `C:\` path against code that is
already platform-correct. **The fix is to make the test platform-parametric so it passes on BOTH
platforms**, never to skip it on Linux and never to make it Linux-only. Those fixes are
upstreamable as-is, and anything upstream accepts is a file that stops conflicting forever.

Candidates to offer upstream as PRs (they are correctness fixes on Windows too):
- the `.gitattributes` rule pinning the CRLF fixture (upstream's suite currently depends on the
  developer's `core.autocrlf`, so it fails for any Windows contributor who sets it `input`);
- every test that hardcodes `engined.exe` rather than `ENGINE_BIN_NAME`.

## Ownership ledger

Files this port owns outright (upstream will never touch them — merges here are free):

| file | why |
|---|---|
| `docs/linux-port/**` | this port's documentation |
| `src/main/log/discoveryLinux.ts` | Wine/Proton prefix sweep |
| `src/main/presenceNativeLinux.ts` | X11 presence via koffi |

Files this port edits, and must therefore expect conflicts in (keep hunks minimal):

| file | the hunk |
|---|---|
| `src/main/log/discovery.ts` | one optional `linuxPrefixCandidates` probe field; the drive sweep split into a helper to keep the branching flat. Absent ⇒ byte-identical behaviour, so win32 and every existing test are untouched |
| `src/main/log/config.ts` | wires that probe to the real filesystem — it is the only place `DiscoveryProbes` is actually assembled, so the field would never fire without it. Guarded `process.platform === 'win32' ? [] : …` |
| `src/main/presenceNative.ts` | one branch in `loadPresenceNative()` |
| `electron-builder.yml` | a `linux:` block; the onnxruntime/koffi platform filters |
| `package.json` | `dist:linux` script |
| `.gitattributes` | the CRLF fixture pin |

Keep this table honest. It is the merge cost of the port, written down.

---

# The long game: how this fork stays alive

Everything above is the mechanics of one merge. This is the operating procedure that keeps the
cost of the *next hundred* merges near zero.

## The GitHub fork

Use GitHub's **Fork** button rather than pushing this checkout to a fresh repo. The fork
*relationship* is the point, not the copy: it gives you "N commits ahead / M behind" against
upstream at a glance, one-click PR creation back to upstream, and `gh repo sync`. A detached
mirror can do the merging but makes contributing back a manual chore, and contributing back is
the cheapest thing we do.

The one real trade-off: **a fork of a public repo is always public.** GitHub offers no private
fork. If this ever needs to be private, it must be a mirror (private repo, `upstream` remote) and
you lose the PR ergonomics. For this port, public is correct — the fixes want to go home.

```bash
gh repo fork jmoyers/everquest-companion --remote=false   # fork on GitHub, leave local remotes alone
git remote add origin git@github.com:<you>/everquest-companion.git
git push -u origin linux
```

`upstream` must keep pointing at `jmoyers/everquest-companion`. Do not let `origin` and
`upstream` blur — every procedure here depends on which is which.

## Branch model

| branch | rule |
|---|---|
| `main` | a **pristine mirror of upstream**. Never commit to it. Its only job is to be a clean base for the PR branches below, and a fast-forward target for `gh repo sync`. |
| `linux` | the port. Your default branch — set it in the repo settings so clones and PRs land here. |
| `upstream/<topic>` | short-lived, cut from `main`, one per PR you send home. Deleted once merged. |

## Merge the port branch. Do not rebase it.

```bash
git fetch upstream && git merge upstream/main     # on `linux`
```

Rebasing a long-lived port onto a moving upstream means **re-resolving every historical conflict
on every rebase**, and rewriting published history each time. Merging records each resolution once
and keeps it. Rebase and cherry-pick belong on the short-lived PR branches, where a clean linear
patch is the actual deliverable.

## Turn on `git rerere`. This is the highest-leverage line in this file.

```bash
git config rerere.enabled true
git config rerere.autoUpdate true
```

*Reuse recorded resolution.* Git remembers how you resolved a given conflict hunk and replays it
automatically the next time the same hunk conflicts. For a fork whose whole cost is re-resolving
the same handful of hunks against a daily-moving upstream, this converts a recurring tax into a
one-time one. Turn it on before the first merge, not after.

## Merge often — the cost is superlinear in drift

Weekly, not quarterly. Ten commits of upstream drift is a conflict you can read; a thousand is an
archaeology project. Every merge:

```bash
git fetch upstream && git merge upstream/main
npm run typecheck && npm test
(cd engine && cargo test --release)
npm run build && npx electron out/main/index.js     # the smoke test that matters
git tag merged-upstream-$(date +%F)                 # so a later bisect has anchors
```

The launch smoke is not optional. Every failure this port has *found* so far — the `C:\` log path,
the Win32 presence surface — was invisible to the type checker and visible in the first ten
seconds of a real launch.

## Fix upstream's CI in your fork before it spams you

`.github/workflows/build.yml` has three jobs, **all `runs-on: windows-latest`**, and the `release`
job wants `AZURE_*` code-signing secrets that exist only in upstream's repo. Forked unchanged,
these fail on every push forever, and CI you have learned to ignore is worse than no CI.

Either disable Actions in the fork's settings, or — better — replace them with a Linux workflow
that runs what actually gates this port: `typecheck`, `npm test`, `cargo test`, `npm run build`.

**Then add the job that earns its keep: a scheduled merge probe.** Nightly, on a throwaway branch,
attempt `git merge upstream/main` and run the suite. Open an issue when it conflicts or breaks.
That converts "upstream broke my port" from something discovered weeks later during a painful
manual merge into a dated notification naming the commit that did it.

## Upstream everything that is not Linux-specific

> **ON HOLD (owner, 2026-09-01 — [D9](DECISIONS.md#d9--nothing-goes-upstream-until-the-owner-has-been-asked)).**
> No PRs to upstream until the owner has spoken to the maintainer directly. The strategy below is
> still correct and still governs how we WRITE code — keeping every fix upstreamable is what keeps
> our own merges cheap. We just do not send them yet.

Every commit upstream accepts is merge surface **deleted permanently**. That makes upstreaming the
highest-return maintenance activity available, well above tidying anything on our side.

A change qualifies if it is correct on Windows too. From this port so far: the `.gitattributes`
CRLF pin, and every test that hardcoded `engined.exe` instead of asking `ENGINE_BIN_NAME`. Both
are bugs on Windows — the first fails for any Windows contributor with `core.autocrlf=input`, the
second asserts against code that is already platform-correct.

Send them as separate, single-purpose PRs from `upstream/<topic>` branches cut from `main`. Match
`AGENTS.md`'s house style and commit voice; a patch that reads like the tree it lands in gets
merged, and one that reads like a fork's patch gets questions.

## When upstream rewrites a file we hold a hunk in

Do not fight it. Re-derive our change against their new structure and look for the seam they just
created — a refactor usually *adds* an extension point, and moving our hunk onto it shrinks the
ledger. Then update the ownership table above in the same commit. That table is only worth having
while it is true.
