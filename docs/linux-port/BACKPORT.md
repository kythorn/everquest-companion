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
| `src/main/log/discovery.ts` | one branch into the Linux candidate generator |
| `src/main/presenceNative.ts` | one branch in `loadPresenceNative()` |
| `electron-builder.yml` | a `linux:` block; the onnxruntime/koffi platform filters |
| `package.json` | `dist:linux` script |
| `.gitattributes` | the CRLF fixture pin |

Keep this table honest. It is the merge cost of the port, written down.
