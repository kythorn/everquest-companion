// ============================================================================================
// overlayClickThroughLinux.ts — THIS APP SETS ITS OWN X11 INPUT REGION.
// ============================================================================================
//
// WHAT IS BROKEN, MEASURED HERE, NOT INFERRED FROM A CHANGELOG.
//
// A locked overlay is click-through: `setOverlayIgnoreMouse` calls Electron's
// `setIgnoreMouseEvents(true)` and the window stops taking the mouse. On X11 that is implemented
// as an INPUT SHAPE — an `XShapeCombineRectangles(..., ShapeInput, ...)` narrowing the region of
// the window that can receive pointer events. Electron narrows it to a 1x1 rectangle at the
// window's top-left corner, which is as close to "nothing" as its implementation gets.
//
// On Electron 43 that stopped happening reliably on Linux. Read straight off the running app with
// `XShapeGetRectangles`, a strip that had just been told to ignore the mouse reported an input
// region covering its WHOLE rectangle — the default a window is born with. Six launches on this
// machine, one 560x360 toast strip and one 530x220 con-card strip, both parked at the top centre
// of the game:
//
//     electron 43.2.0   run 1   toast FULL      conCard FULL
//     electron 43.2.0   run 2   toast FULL      conCard FULL
//     electron 43.2.0   run 3   toast 1x1       conCard 1x1
//     electron 43.6.0           toast FULL      conCard FULL
//     electron 44.2.0           toast FULL      conCard 1x1        <-- the two DISAGREED
//
// Upstream has this as electron/electron#52456 ("setIgnoreMouseEvents no longer makes transparent
// windows click-through on Linux/X11 in Electron 43"), open, no fix, reported as DETERMINISTIC.
// The table above says otherwise and the last row is the proof: two windows in ONE process, one
// correct and one not. The call is not a no-op — it works, and then something in the window's own
// setup, show or bounds sequence puts the full region back. It is a RACE, which is why 43.6.0 and
// 44.2.0 both still lose it and why no version pin was ever going to be the fix. (42.11.2 is the
// last release believed good; adopting it buys a runtime that goes EOL on 2026-10-20 in exchange
// for a race we would still not control.)
//
// WHY THIS MATTERS MORE THAN "CLICKS DO NOT GO THROUGH". An X11 input region is not a click
// filter, it is POINTER-EVENT OWNERSHIP. While it covers the window, X delivers that rectangle's
// `MotionNotify` to us and sends the window underneath a `LeaveNotify` — so EverQuest, running
// under Wine below these strips, stops seeing the cursor MOVE at all. The reported symptom is
// therefore not "my clicks are eaten": it is an item on the cursor that stops tracking, and a drag
// that dies, whenever the pointer crosses the top middle of the screen. Confirmed in game.
//
// ============================== SO THIS FILE OWNS THE REGION ==============================
//
// Rather than asking Electron and hoping, the app states the region itself, through the same
// mechanism and the same FFI engine `presenceNativeLinux.ts` already uses for its X11 surface.
// Two calls, both from `libXext.so.6`:
//
//   * click-through  — `XShapeCombineRectangles(dpy, win, ShapeInput, 0,0, <one 0x0 rect>, 1, …)`
//     A rectangle of ZERO AREA is an EMPTY input region: every pointer event in the window's
//     rectangle belongs to whatever is underneath. Note this is strictly better than what Electron
//     does when it works — 1x1 leaves one live pixel in the corner; this leaves none. A zero-area
//     RECTANGLE rather than a zero-length rectangle LIST (`NULL, 0`) because the empty list asks
//     Xlib to send a zero-length request body from a null pointer, and "an empty region" is a
//     thing worth stating in a form that cannot be read as "no argument".
//   * capturing      — `XShapeCombineMask(dpy, win, ShapeInput, 0,0, None, ShapeSet)`
//     A `None` mask REMOVES the input shape, restoring the default: the whole window takes events.
//     Deliberately not "combine a full-size rectangle", which would leave a shape in place that
//     has to stay in sync with every resize; removing it hands the question back to the server.
//
// THIS IS APPLIED AFTER ELECTRON'S OWN CALL, NEVER INSTEAD OF IT. `setIgnoreMouseEvents` is still
// what the rest of the app (and every other platform) means by click-through, and it does more
// than the shape on the platforms where it works. This file is a Linux-only REASSERTION layered on
// top: if Electron got it right we set the same answer again for nothing, and if the race went the
// other way we correct it. There is no path where the two disagree about intent.
//
// AND WRITING IT ONCE IS NOT ENOUGH — the clobber TRAILS the write by ~30 ms, so whoever writes
// LAST wins, and an inline reassert on `show`/`resize`/`move` is early in the same turn the clobber
// is late in. `scheduleVerify` is the answer and its header carries the measured timeline: write,
// then CHECK, and write again only if the check says we lost. Bounded, self-terminating, and idle
// the moment the region reads back empty — which on this machine is one or two passes, ~380 ms
// after the window is created.
//
// MEASURED END TO END, five cold starts plus both directions: every launch converged to an empty
// input region and held it, a pointer warped into the middle of each strip landed on the window
// UNDERNEATH, and an overlay switched to interactive still captured the mouse (a full region, the
// pointer landing on the strip) — the trade this fix must not make is silently breaking the case
// where an overlay is SUPPOSED to take the mouse.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT SHARE WITH `presenceNativeLinux.ts`.
// ---------------------------------------------------------------------------------------------
// ITS `Display *`. That file states the rule this one obeys: "XLIB IS NOT THREAD-SAFE BY DEFAULT,
// so this module's one `Display *` is opened once and used from ONE thread only — the presence
// worker". This file runs on the MAIN thread (it is called from `windows.ts`, which is main's
// window layer and nothing else). Reusing that connection across the two would be exactly the
// unsynchronised two-thread use `XInitThreads()` exists to make legal, so this opens its OWN
// connection and uses it only from main. Two connections to one server is ordinary; one connection
// from two threads is a crash nobody can reproduce on demand.
//
// It DOES share `waylandReason()`, because "is there an X server to talk to" is one question and
// two answers to it would drift. On Wayland this file is a no-op — there is no X input shape to
// set, the overlays are the compositor's problem, and D5 already documents that session as
// degraded rather than broken.
//
// IMPORTABLE ON ANY PLATFORM, WINDOWS INCLUDED, WITHOUT CALLING INTO koffi — the same law
// `presenceNativeLinux.ts` states for itself. Nothing here runs a koffi call as a side effect of
// being imported; `libs()` is lazy and every entry point returns early off Linux.

import * as koffi from 'koffi'
import type { BrowserWindow } from 'electron'
import { logError, logInfo } from './errorLog'
import { waylandReason } from './presenceNativeLinux'

// ---- X11 SHAPE constants (`X11/extensions/shape.h`) --------------------------------------------

/** `ShapeInput` — the region that can RECEIVE POINTER EVENTS, as opposed to `ShapeBounding` (0,
 *  which pixels exist) and `ShapeClip` (1, which pixels are drawn). Only this one is click-through;
 *  narrowing the other two would make the window itself disappear. */
const SHAPE_INPUT = 2
/** `ShapeSet` — replace the region outright rather than union/intersect/subtract against it. */
const SHAPE_SET = 0
/** `Unsorted` — one rectangle cannot be out of order; the server still wants the parameter. */
const UNSORTED = 0
/** X11's `None`, the null resource id — here, "no mask", i.e. remove the shape entirely. */
const X_NONE = 0

type X11Fn = (...args: unknown[]) => unknown

interface ShapeCalls {
  display: unknown
  XShapeCombineRectangles: X11Fn
  XShapeCombineMask: X11Fn
  XShapeGetRectangles: X11Fn
  XFree: X11Fn
  XFlush: X11Fn
}

/** One `XRectangle` (`short x, short y, unsigned short w, unsigned short h`), all zeros: a rect of
 *  zero area, i.e. an EMPTY region. Passed instead of `(NULL, 0)` — see applyLinuxClickThrough. */
const EMPTY_RECT = Buffer.alloc(8)

/**
 * The XID of a `BrowserWindow`, from Electron's own platform handle.
 *
 * `getNativeWindowHandle()` is documented as returning the native handle — `HWND` on Windows,
 * `NSView*` on macOS, and an X11 `Window` (an `unsigned long`) on Linux. On x86-64 that is 8
 * bytes; the 4-byte branch is there because the width is the platform's pointer size and not a
 * constant this file gets to assume. `0` means "no usable id", which every caller treats as
 * "leave this window alone" rather than as an error worth logging on a hot path.
 *
 * PURE AND EXPORTED so the byte-order reasoning is a unit test rather than a claim
 * (tests/overlayClickThroughLinux.test.mts) — the one part of this module that can be proven
 * without an X server.
 */
export function xidFromHandle(handle: Buffer): number {
  if (handle.length >= 8) {
    const id = handle.readBigUInt64LE(0)
    return id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : 0
  }
  if (handle.length >= 4) return handle.readUInt32LE(0)
  return 0
}

/**
 * Whether this session has an X11 input shape worth setting, and why not when it does not.
 *
 * PURE AND ENV-INJECTABLE, `waylandReason()`'s own arrangement and for its reason: every branch is
 * exercised from fixture environments with no display and no koffi.
 */
export function clickThroughSkipReason(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string | null {
  if (platform !== 'linux') return `platform ${platform} — Electron owns click-through here`
  return waylandReason(env)
}

// ---- the one lazy load -------------------------------------------------------------------------

/** `null` until first use; `false` once we know this session will never have it (off Linux, on
 *  Wayland, or a load/bind that failed). Failure is remembered so a broken box pays the cost once
 *  and then behaves exactly as the app did before this file existed. */
let calls: ShapeCalls | null | false = null

function libs(): ShapeCalls | null {
  if (calls !== null) return calls === false ? null : calls
  const skip = clickThroughSkipReason(process.platform, process.env)
  if (skip !== null) {
    calls = false
    return null
  }
  try {
    const x11 = koffi.load('libX11.so.6')
    const xext = koffi.load('libXext.so.6')
    const XOpenDisplay = x11.func('void *XOpenDisplay(const char *display_name)') as X11Fn
    const XShapeQueryExtension = xext.func(
      'int XShapeQueryExtension(void *display, _Out_ int *event_base, _Out_ int *error_base)'
    ) as X11Fn
    const display = XOpenDisplay(null)
    if (display === null || display === undefined || display === 0) {
      throw new Error(`XOpenDisplay failed for DISPLAY=${process.env.DISPLAY ?? '(unset)'}`)
    }
    // ASKED BEFORE USED. The SHAPE extension is universal in practice but it is an EXTENSION: a
    // server without it answers 0 here, and calling into it anyway is undefined rather than merely
    // ineffective. One question at load, never again.
    const eventBase = [0]
    const errorBase = [0]
    if (Number(XShapeQueryExtension(display, eventBase, errorBase)) === 0) {
      throw new Error('the X server has no SHAPE extension')
    }
    calls = {
      display,
      XShapeCombineRectangles: xext.func(
        'void XShapeCombineRectangles(void *display, unsigned long dest, int dest_kind, ' +
          'int x_off, int y_off, void *rectangles, int n_rects, int op, int ordering)'
      ) as X11Fn,
      XShapeCombineMask: xext.func(
        'void XShapeCombineMask(void *display, unsigned long dest, int dest_kind, ' +
          'int x_off, int y_off, unsigned long src, int op)'
      ) as X11Fn,
      XShapeGetRectangles: xext.func(
        'void *XShapeGetRectangles(void *display, unsigned long window, int kind, ' +
          '_Out_ int *count, _Out_ int *ordering)'
      ) as X11Fn,
      XFree: x11.func('int XFree(void *data)') as X11Fn,
      XFlush: x11.func('int XFlush(void *display)') as X11Fn
    }
    logInfo(
      '[everquest-companion] X11 click-through: this app sets overlay input regions itself ' +
        '(electron/electron#52456 — Electron 43/44 lose them non-deterministically on X11).'
    )
    return calls
  } catch (err) {
    calls = false
    logError('main:overlayClickThroughLinux', err)
    return null
  }
}

// ---- the two entry points ----------------------------------------------------------------------

/**
 * State this window's X11 input region: EMPTY when `ignore` (every pointer event, motion included,
 * belongs to the game underneath), or SHAPELESS when not (the window takes events normally).
 *
 * Safe to call on any platform, on a destroyed window, and before the window has ever been shown —
 * an input shape is a property of the X window, not of its mapped state, so setting it early is
 * both legal and exactly what a window that opens click-through wants.
 */
export function applyLinuxClickThrough(w: BrowserWindow, ignore: boolean): void {
  const c = libs()
  if (c === null) return
  try {
    if (w.isDestroyed()) return
    const win = xidFromHandle(w.getNativeWindowHandle())
    if (win === 0) return
    if (ignore) {
      c.XShapeCombineRectangles(
        c.display,
        win,
        SHAPE_INPUT,
        0,
        0,
        EMPTY_RECT,
        1,
        SHAPE_SET,
        UNSORTED
      )
    } else {
      c.XShapeCombineMask(c.display, win, SHAPE_INPUT, 0, 0, X_NONE, SHAPE_SET)
    }
    // Xlib BUFFERS. Without this the request sits in the client-side queue until something else
    // happens to flush it, which on an idle overlay can be a long time — and "the region is set,
    // just not yet" is indistinguishable from the bug this file exists to fix.
    c.XFlush(c.display)
    // A write is only a REQUEST until something checks it — see scheduleVerify's header for the
    // measured reason. Only the click-through direction is defended; `ignore: false` asks for the
    // same default state the clobber itself restores.
    const want = wantGetters.get(w)
    if (ignore && want !== undefined) scheduleVerify(w, want)
  } catch (err) {
    logError('main:overlayClickThroughLinux', err)
  }
}

/**
 * How many rectangles the window's input region is currently made of, or `null` when the question
 * could not be asked. ZERO IS THE ANSWER WE WANT while click-through: `XShapeGetRectangles` returns
 * a NULL list with `count = 0` for an EMPTY region, and a one-rectangle list covering the whole
 * window when there is no input shape at all (the state a window is born in, and the state the
 * clobber restores). So "0" and "not 0" is the entire test, and it needs no geometry.
 */
function inputRectCount(c: ShapeCalls, win: number): number | null {
  const count = [0]
  const ordering = [0]
  const rects = c.XShapeGetRectangles(c.display, win, SHAPE_INPUT, count, ordering)
  if (rects !== null && rects !== undefined && rects !== 0) c.XFree(rects)
  const n = count[0]
  return typeof n === 'number' ? n : null
}

/** At most this many verify passes per burst, and the gap between them. Sized from the measured
 *  race: the clobber lands ~30 ms after the region is set, and everything settled inside 1.5 s of
 *  window creation on this machine — so eight passes at 150 ms covers that with a wide margin and
 *  still terminates in ~1.2 s rather than running forever. */
const VERIFY_PASSES = 8
const VERIFY_INTERVAL_MS = 150

const verifyTimers = new WeakMap<BrowserWindow, NodeJS.Timeout>()

/**
 * What each guarded window CURRENTLY wants, registered by `installLinuxClickThroughGuard`.
 *
 * It exists so that EVERY path into `applyLinuxClickThrough` is defended, not just the guard's own
 * events: `windows.ts`'s `setOverlayIgnoreMouse` — the one place click-through changes for the
 * whole app — calls the apply directly, and a write made there would otherwise be the one write
 * nobody checks. Registering the getter once, at window creation, is what lets the apply schedule
 * its own verification without every caller having to remember to.
 */
const wantGetters = new WeakMap<BrowserWindow, () => boolean>()

/**
 * WHY A VERIFY LOOP AND NOT ONE MORE CALL — the measured shape of this bug.
 *
 * Polling the region from outside the app while it started caught the whole sequence on one strip:
 *
 *     t=0.98s  window created                      input region FULL
 *     t=1.22s  Electron's setIgnoreMouseEvents     input region 1x1
 *     t=1.25s  something puts it back              input region FULL      <-- ~30 ms later
 *     t=1.49s  this module writes it again         input region EMPTY     <-- and it holds
 *
 * The clobber TRAILS whatever set the region, by about 30 ms. That is why reasserting inline on
 * `show`/`resize`/`move` is not enough on its own: our write is early in the same turn the clobber
 * is late in, so we lose to it exactly as Electron does. Being LAST is the whole trick.
 *
 * "Last" is not a number this code can know, so it does not guess one: it WRITES, then CHECKS, and
 * only writes again if the check says it lost. The loop stops the moment the region reads back
 * empty, which in practice is one or two passes — and it stops after `VERIFY_PASSES` regardless, so
 * a machine where this fight cannot be won pays a bounded cost and then behaves exactly as the app
 * did before this file existed. Coalesced per window: a burst of `move` events during a drag
 * schedules ONE loop, not one per event.
 *
 * ONLY THE CLICK-THROUGH DIRECTION IS DEFENDED. `ignore: false` asks for the DEFAULT state (no
 * input shape, whole window takes events), which is also what the clobber restores — so there is
 * nothing to fight for there, and a verify loop would be re-asserting agreement.
 */
function scheduleVerify(w: BrowserWindow, ignore: () => boolean, pass = 0): void {
  const existing = verifyTimers.get(w)
  if (existing !== undefined) clearTimeout(existing)
  if (pass >= VERIFY_PASSES) return
  const timer = setTimeout(() => {
    verifyTimers.delete(w)
    const c = libs()
    if (c === null || w.isDestroyed()) return
    // Re-read intent rather than trusting the value that scheduled this pass: a card can arrive and
    // a park can end while the loop is running, and the window's CURRENT want is the only correct
    // thing to assert.
    const want = ignore()
    if (!want) return
    try {
      const win = xidFromHandle(w.getNativeWindowHandle())
      if (win === 0) return
      if (inputRectCount(c, win) === 0) return // we won; nothing left to defend
      applyLinuxClickThrough(w, true)
      scheduleVerify(w, ignore, pass + 1)
    } catch (err) {
      logError('main:overlayClickThroughLinux', err)
    }
  }, VERIFY_INTERVAL_MS)
  // Never hold the process open for a repaint of an invisible strip.
  timer.unref?.()
  verifyTimers.set(w, timer)
}

/**
 * Keep this window's input region correct across the events that lose it.
 *
 * `show`, `resize` and `move` are the three the measured race lives in: the region survives the
 * renderer's own ask and is then replaced during the window's setup/show/bounds work. Reasserting
 * from the caller's CURRENT desired state (a getter, not a captured boolean — the desired state
 * changes as cards arrive and the park comes and goes) makes the correction idempotent and keeps
 * this file from holding a second opinion about what the window wants.
 *
 * A no-op off Linux/X11, so the call site in `windows.ts` needs no platform branch of its own.
 */
export function installLinuxClickThroughGuard(w: BrowserWindow, ignore: () => boolean): void {
  if (libs() === null) return
  wantGetters.set(w, ignore)
  const reassert = (): void => applyLinuxClickThrough(w, ignore())
  w.on('show', reassert)
  w.on('resize', reassert)
  w.on('move', reassert)
  w.on('closed', () => {
    const pending = verifyTimers.get(w)
    if (pending !== undefined) clearTimeout(pending)
    verifyTimers.delete(w)
  })
}
