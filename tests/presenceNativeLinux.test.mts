// THE X11 SURFACE, MADE (W3 of the Linux port — see docs/linux-port/DECISIONS.md D5).
//
// `src/main/presenceNativeLinux.ts` is this fork's own file (docs/linux-port/BACKPORT.md's
// ownership ledger), the Linux sibling `tests/presenceNative.test.mts` already keeps for the
// Win32 surface — same shape, same reason: the module under test is the module the app loads, no
// copy of the implementation lives here.
//
// TWO KINDS OF ASSERTION, SPLIT THE SAME WAY THE SOURCE FILE IS:
//   * `/proc` parsing (`readImagePath`, `scanEqRunning`) and Wayland detection (`waylandReason`,
//     and `loadPresenceNativeLinux()`'s throw before it) need NO display and NO koffi call at
//     all, so they run unconditionally — on this dev box, in CI, on Windows. The load-bearing case
//     among them is the one this dev box cannot produce on its own: a real EverQuest client is not
//     running here, and even if it were, this box has no Proton install to prove the "matches
//     `eqgame.exe` by CMDLINE, not by `/proc/<pid>/exe`" claim D5 makes. So a fixture directory
//     shaped like `/proc` stands in for a Proton process — its `exe` symlink deliberately points
//     at a WINE LOADER, never at `eqgame.exe`, which is exactly the shape a real Proton prefix
//     produces and exactly the case an image-path match (the Win32 predicate) would miss.
//   * `foreground()`/`cursorShowing()` need a real X server, gated on `DISPLAY` so the suite still
//     passes on Windows and in CI — but this dev box IS an X11 session (`XDG_SESSION_TYPE=x11`,
//     `DISPLAY=:0`), so these run for real here rather than being decoration. A throwaway script
//     run outside this suite (see the port's session notes) printed this very terminal window's
//     pid, its REPARENTED-vs-ROOT coordinate gap (`XGetWindowAttributes` said `(10, 40)`,
//     `XTranslateCoordinates` said `(147, 256)` — the same window), and its real title back; these
//     tests assert the SHAPE of that same answer rather than re-deriving the exact numbers, which
//     is what `tests/presenceNative.test.mts` does for the Win32 side too (a locked build agent's
//     foreground window is not a fixed fact either).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PROC_ROOT,
  loadPresenceNativeLinux,
  readImagePath,
  scanEqRunning,
  waylandReason
} from '../src/main/presenceNativeLinux'

const NO_DISPLAY = !process.env.DISPLAY && 'no X server on this machine (DISPLAY is unset)'

/** A pid high enough that no real process owns it — the direct analogue of
 *  `tests/presenceNative.test.mts`'s `NO_SUCH_PID`. */
const NO_SUCH_PID = 2147483632

// ---- fixture `/proc` builder ------------------------------------------------------------------

interface FixtureProcess {
  /** What `/proc/<pid>/exe` resolves to. A Proton pid's is the WINE LOADER, never `eqgame.exe` —
   *  that gap is the whole point of D5, and the fixtures below make it explicit rather than
   *  incidental. */
  exeTarget: string
  /** `/proc/<pid>/cmdline`'s argv, NUL-joined the way `proc(5)` actually lays it out. Omit to
   *  leave the pid with NO `cmdline` file at all (a process gone between `readdir` and the read). */
  cmdline?: string[]
}

/** Builds a directory shaped like `/proc`: numeric subdirectories, each an `exe` symlink and
 *  (usually) a `cmdline` file, plus one NON-numeric entry every real `/proc` also has (`self`),
 *  which `scanEqRunning`'s pid filter must silently ignore rather than choke on. */
function buildProcFixture(processes: Record<number, FixtureProcess>): string {
  const root = mkdtempSync(join(tmpdir(), 'presenceNativeLinux-proc-'))
  mkdirSync(join(root, 'self')) // the one non-numeric entry every real /proc has
  for (const [pid, proc] of Object.entries(processes)) {
    const dir = join(root, pid)
    mkdirSync(dir)
    symlinkSync(proc.exeTarget, join(dir, 'exe'))
    if (proc.cmdline) {
      writeFileSync(join(dir, 'cmdline'), proc.cmdline.join('\0') + '\0')
    }
  }
  return root
}

// ---- waylandReason() / the degrade path — no display, no koffi, runs everywhere ---------------

test('waylandReason() names the exact env var and value for an explicit Wayland session', () => {
  const reason = waylandReason({ XDG_SESSION_TYPE: 'wayland' })
  assert.equal(typeof reason, 'string')
  assert.match(reason ?? '', /XDG_SESSION_TYPE=wayland/)
  assert.match(reason ?? '', /D5/)
})

test('waylandReason() is case-insensitive about the session type', () => {
  assert.notEqual(waylandReason({ XDG_SESSION_TYPE: 'Wayland' }), null)
  assert.notEqual(waylandReason({ XDG_SESSION_TYPE: 'WAYLAND' }), null)
})

test('waylandReason() flags a Wayland-only session even with no XDG_SESSION_TYPE at all', () => {
  const reason = waylandReason({ WAYLAND_DISPLAY: 'wayland-0' })
  assert.notEqual(reason, null)
  assert.match(reason ?? '', /WAYLAND_DISPLAY/)
})

test('waylandReason() lets an explicit X11 session through', () => {
  assert.equal(waylandReason({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), null)
})

test('waylandReason() does not block an ambiguous environment (no hints either way)', () => {
  // Neither XDG_SESSION_TYPE nor WAYLAND_DISPLAY is set — some minimal setups (containers, a
  // stripped-down window manager) never set either. Silence is not a Wayland signal; this module
  // still tries X11 and lets `XOpenDisplay` be the one that says whether a server exists.
  assert.equal(waylandReason({}), null)
})

test('a Wayland session type does NOT need DISPLAY set for the WAYLAND_DISPLAY branch to apply', () => {
  // Coverage for the guard's own condition: WAYLAND_DISPLAY set AND DISPLAY unset. Setting DISPLAY
  // too (XWayland) takes the "ambiguous" path above instead — this module does not special-case
  // XWayland, by design (see this file's header and the source's own header).
  assert.equal(waylandReason({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), null)
})

test('loadPresenceNativeLinux() throws on a Wayland session before touching koffi at all', () => {
  // No DISPLAY, no libX11 needed for this assertion to be meaningful — the whole point is that the
  // throw happens BEFORE `koffi.load()`, so this passes on a machine with no X11 anything.
  assert.throws(
    () => loadPresenceNativeLinux({ XDG_SESSION_TYPE: 'wayland' }),
    /Wayland/,
    'the module\'s one failure path, taken on purpose — see D5'
  )
})

// ---- readImagePath() — /proc/<pid>/exe, no FFI ------------------------------------------------

test('readImagePath() answers this very process\'s own executable off the REAL /proc', () => {
  assert.equal(readImagePath(process.pid), process.execPath)
})

test('readImagePath() answers empty for a pid that does not exist, not garbage', () => {
  assert.equal(readImagePath(NO_SUCH_PID), '')
})

test('readImagePath() answers empty for a procRoot that does not exist at all', () => {
  assert.equal(readImagePath(process.pid, '/proc/does-not-exist-at-all'), '')
})

test('readImagePath() follows the exe symlink verbatim, even when it is not eqgame.exe', () => {
  // The fixture proves readImagePath() itself does no EverQuest-specific interpretation — it is
  // scanEqRunning() that has to know better (next section). This is D5's gap made concrete: a
  // Proton pid's own image path is honestly reported as the WINE LOADER.
  const root = buildProcFixture({
    4242: { exeTarget: '/home/player/.wine/drive_c/windows/system32/wine64-preloader' }
  })
  assert.equal(
    readImagePath(4242, root),
    '/home/player/.wine/drive_c/windows/system32/wine64-preloader'
  )
})

// ---- scanEqRunning() — /proc/*/cmdline, matched on argv text, never on image path (D5) --------

test('scanEqRunning() answers -1 when /proc itself will not enumerate', () => {
  assert.equal(scanEqRunning('', '/proc/does-not-exist-at-all'), -1)
})

test('scanEqRunning() answers 0 against the REAL /proc — this test process is not EverQuest', () => {
  assert.notEqual(scanEqRunning('', DEFAULT_PROC_ROOT), -1, 'the enumeration itself must work')
  assert.equal(scanEqRunning('', DEFAULT_PROC_ROOT), 0)
})

test(
  'scanEqRunning() finds a Proton process by CMDLINE even though its own /proc/<pid>/exe is the ' +
    'wine loader, not eqgame.exe — the exact gap D5 exists to close',
  () => {
    const root = buildProcFixture({
      // The loader: /proc/<pid>/exe points at Wine's own binary. An image-path match (the Win32
      // predicate, ported unchanged) would find NOTHING here.
      5001: {
        exeTarget: '/home/player/.wine/drive_c/windows/system32/wine64-preloader',
        cmdline: [
          '/home/player/.wine/drive_c/windows/system32/wine64-preloader',
          'Z:\\home\\player\\Games\\EverQuest Legends\\eqgame.exe',
          'patchme'
        ]
      },
      // A decoy: an unrelated process that must NOT be mistaken for the game.
      5002: {
        exeTarget: '/usr/bin/bash',
        cmdline: ['/usr/bin/bash', '--login']
      }
    })
    assert.equal(scanEqRunning('', root), 1)
    // And readImagePath() on that SAME pid proves the negative: the image-path route this scan
    // deliberately does not take would have answered nothing useful.
    assert.doesNotMatch(readImagePath(5001, root).toLowerCase(), /eqgame/)
  }
)

test('scanEqRunning() also matches via the EQ root as a cmdline substring, backslashes and all', () => {
  const root = buildProcFixture({
    6001: {
      exeTarget: '/home/player/.wine/drive_c/windows/system32/wine64-preloader',
      // No literal "eqgame.exe" argument this time — only a path under the EQ root, spelled with
      // Windows separators, the way a Wine argv often is.
      cmdline: [
        '/home/player/.wine/drive_c/windows/system32/wine64-preloader',
        'Z:\\home\\player\\Games\\EverQuest Legends\\Launcher.exe'
      ]
    }
  })
  const eqRoot = 'Z:\\home\\player\\Games\\EverQuest Legends\\'
  assert.equal(scanEqRunning(eqRoot, root), 1)
  // A root that does not match anything in argv, and no client name either: no false positive.
  assert.equal(scanEqRunning('Z:\\nowhere\\', root), 0)
})

test('scanEqRunning() skips a process that vanished between readdir and the cmdline read', () => {
  // A pid directory with no `cmdline` file at all — readFileSync throws ENOENT, which must be one
  // stale entry skipped, not the whole enumeration reading as failed.
  const root = buildProcFixture({
    7001: { exeTarget: '/usr/bin/true' } // no `cmdline` — the process raced away
  })
  assert.equal(scanEqRunning('', root), 0)
})

test('scanEqRunning() ignores non-numeric /proc entries (the fixture always plants one: "self")', () => {
  const root = buildProcFixture({
    8001: { exeTarget: '/usr/bin/bash', cmdline: ['/usr/bin/bash'] }
  })
  // Would throw (ENOTDIR/ENOENT reading "self/cmdline" as if it were a pid) if the pid filter let
  // "self" through instead of skipping it.
  assert.doesNotThrow(() => scanEqRunning('', root))
  assert.equal(scanEqRunning('', root), 0)
})

test('an empty EQ root disables the substring fallback but not the client-name match', () => {
  const root = buildProcFixture({
    9001: {
      exeTarget: '/home/player/.wine/drive_c/windows/system32/wine64-preloader',
      cmdline: ['wine64-preloader', 'eqgame.exe']
    }
  })
  assert.equal(scanEqRunning('', root), 1, 'the client name alone is enough')
})

// ---- foreground() / cursorShowing() — real X11, gated on a real display -----------------------

test('loadPresenceNativeLinux() opens the real display and answers itself', { skip: NO_DISPLAY }, () => {
  assert.doesNotThrow(() => loadPresenceNativeLinux())
})

test(
  'foreground() answers a pid and a rectangle for THIS real X11 session',
  { skip: NO_DISPLAY },
  () => {
    const native = loadPresenceNativeLinux()
    const fg = native.foreground()
    // Null is legitimate (no _NET_ACTIVE_WINDOW — a window manager with no EWMH, or nothing
    // focused) and is not a failure, mirroring tests/presenceNative.test.mts's own posture.
    if (fg === null) return
    assert.ok(Number.isInteger(fg.pid) && fg.pid >= 0, `pid ${String(fg.pid)}`)
    for (const [name, v] of Object.entries({ x: fg.x, y: fg.y, width: fg.width, height: fg.height })) {
      // Negative x/y are ordinary (a window on a monitor to the left of/above the primary) —
      // nothing here clamps them, same rule as the Win32 side. Only a non-integer is a decode bug.
      assert.ok(Number.isInteger(v), `${name} is not an integer: ${String(v)}`)
    }
    assert.equal(typeof fg.title, 'string')
  }
)

test(
  'foreground()\'s pid, when nonzero, points at a real /proc entry on this machine',
  { skip: NO_DISPLAY },
  () => {
    const native = loadPresenceNativeLinux()
    const fg = native.foreground()
    if (fg === null || fg.pid === 0) return
    // Cross-checks _NET_WM_PID against the SAME /proc this file's own readImagePath() reads —
    // proving the two halves of this module (koffi and /proc) agree about what a pid is.
    assert.notEqual(readImagePath(fg.pid), undefined)
  }
)

test('cursorShowing() answers true and a finite root-relative point on this real display', {
  skip: NO_DISPLAY
}, () => {
  const native = loadPresenceNativeLinux()
  const point = { x: Number.NaN, y: Number.NaN }
  const showing = native.cursorShowing(point)
  assert.equal(showing, true, 'X11 has no hidden-cursor signal to answer with — always true')
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `point was not filled: ${JSON.stringify(point)}`)
})

test('cursorShowing() called with no `out` still answers true and does no work', {
  skip: NO_DISPLAY
}, () => {
  const native = loadPresenceNativeLinux()
  assert.equal(native.cursorShowing(), true)
})
