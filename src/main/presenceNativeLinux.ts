// ============================================================================
// presenceNativeLinux.ts — the X11 surface the presence watcher reads, IN PROCESS.
// ============================================================================
//
// This is `presenceNative.ts`'s Win32 surface, ported to the platform that file's own header
// promises a sibling for: "koffi is a general FFI engine… this module is the entire Win32 surface
// of the application, and a reviewer can read all of it." This file is the entire X11 surface —
// same promise, same shape, different library. It exists as its own file rather than a branch
// inside `presenceNative.ts` because `docs/linux-port/BACKPORT.md` ranks "a `linux*.ts` sibling
// behind an existing factory" above "edit upstream logic in place": `loadPresenceNative()` gets a
// three-line branch, and every line specific to this platform lives in a file upstream will never
// touch. See `docs/linux-port/DECISIONS.md` D5 for the decision this file is the other half of.
//
// ---------------------------------------------------------------------------------------------
// WHAT NEEDS NO FFI AT ALL — `imagePath()` and `eqRunning()`.
// ---------------------------------------------------------------------------------------------
// Both are plain reads of `/proc`, which is itself the kernel's answer to "ask a question without
// spawning a process" — `presenceNative.ts`'s header spends a page on why the old PowerShell child
// had to go, and `/proc` is that same argument's Linux ending: no `ps`, no `pgrep`, just files the
// kernel already maintains.
//
// `eqRunning()` MATCHES ON CMDLINE, NOT ON IMAGE PATH — this is D5's load-bearing fact, restated
// where the code answers it: under Proton, `eqgame.exe` is hosted by a Wine loader
// (`wine64-preloader`, or the binary Proton's own entry point ultimately execs), so
// `/proc/<pid>/exe` resolves to THE LOADER. The Win32 scan in `presenceNative.ts` matches on image
// path because on Windows that path IS `eqgame.exe`; the same check here would find nothing on
// every Proton install there is. The EQ path only ever shows up in the loader's own argv, which
// `/proc/<pid>/cmdline` carries verbatim (NUL-separated, `proc(5)`), so that is what gets scanned.
//
// ---------------------------------------------------------------------------------------------
// WHAT NEEDS koffi — `foreground()` and `cursorShowing()`, against `libX11.so.6`.
// ---------------------------------------------------------------------------------------------
// D5: reuse the exact mechanism and dependency `presenceNative.ts` already chose for
// `user32.dll` — no new dependency, no N-API addon, and no `xdotool`/`xprop` subprocess, because
// the standing rule against spawning a process to ask a question applies here with equal force.
// koffi's Linux prebuilt (`koffi/build/koffi/linux_x64`) is already in the tree for exactly this.
//
// THE PROTOCOL, in the order this file asks it:
//   1. `_NET_ACTIVE_WINDOW` off the ROOT window — the EWMH property every window manager an EQ
//      player will actually be running (Mutter, KWin, Xfwm, i3, sway's X11 back-compat path, …)
//      maintains. No property (or a `None` window id) means no foreground window, which is a
//      LEGITIMATE `null` — same meaning `GetForegroundWindow()` returning nothing has on a locked
//      Windows session.
//   2. `XGetWindowAttributes()` on that window for its size — and ITS POSITION IS NOT THE ANSWER,
//      because every window manager here REPARENTS the client into a decoration frame, and
//      `XGetWindowAttributes` reports position relative to the IMMEDIATE PARENT (the frame), not
//      the root. Measured on this machine: a window management reports `(x:10, y:40)` there while
//      really sitting at `(147, 256)` on screen. `XTranslateCoordinates(win, root, 0, 0, …)` is
//      the fix — translate the window's own origin into root (screen) coordinates, which is what
//      every consumer of `ForegroundWindow.x/y` (the overlay auto-hide rectangle, the ring's
//      hot-zone test) actually needs. Width/height are NOT reparented, so `XGetWindowAttributes`
//      answers those directly.
//   3. `_NET_WM_PID` on the window — the EWMH pid hint. `0` when absent, same "unknown" value the
//      Win32 side's own no-window sentinel uses.
//   4. The title: `_NET_WM_NAME` (type `UTF8_STRING`) FIRST, falling back to the ICCCM `WM_NAME`
//      for the handful of older/simpler clients that never adopted EWMH. Both are read through the
//      same `XGetWindowProperty` → `XFree` pair; nothing here holds an X server reply past the
//      call that decoded it.
//
// VERIFIED AGAINST A REAL X SERVER, not just typed against the header. A throwaway script on this
// dev box (`DISPLAY=:0`) opened the display, read `_NET_ACTIVE_WINDOW`, and printed this file's own
// terminal window back — real pid, the reparented-vs-translated coordinate gap described above
// measured directly (10,40 vs 147,256), and its actual title. See this port's PR/session notes for
// the transcript; the numbers above are that run's, not invented.
//
// `XWindowAttributes` IS A `koffi.struct`, NOT A HAND-OFFSET BUFFER, unlike every out-parameter in
// `presenceNative.ts`. That file's header explains why IT chose raw buffers: `GetCursorInfo` runs
// on every tick (~69/s) and the buffer form measured 5x cheaper. Nothing here runs anywhere near
// that cadence — `foreground()` matches the ~150 ms `foregroundEveryTicks` cadence, same as Win32 —
// so there is no measurement that justifies hand-counting the 20-odd fields of a struct that has
// not changed since X11R1 (and pointer-sized members mean the byte offsets are also
// architecture-dependent in a way `koffi.struct` computes correctly and a hand count could get
// wrong silently). One idiom per file, chosen for what that file actually does. ITS REGISTRATION
// LIVES IN `bindX11()`, NOT AT MODULE SCOPE — see `registerXWindowAttributes()`'s own header for
// why: `presenceNative.ts` imports this file unconditionally on every platform, so THIS MODULE
// MUST BE IMPORTABLE ON ANY PLATFORM, WINDOWS INCLUDED, WITHOUT CALLING INTO koffi AT ALL. Nothing
// in this file may run a koffi call as a side effect of being imported.
//
// XLIB IS NOT THREAD-SAFE BY DEFAULT (`XInitThreads()` exists precisely to relax that), so this
// module's one `Display *` is opened once and used from ONE thread only — the presence worker
// thread `presenceWorker.ts` already dedicates to this surface, same as Win32. `XInitThreads()` is
// deliberately not called: there is nothing else in this process ever touching this connection.
//
// ---------------------------------------------------------------------------------------------
// WAYLAND DEGRADES, IT DOES NOT CRASH (D5).
// ---------------------------------------------------------------------------------------------
// No Wayland compositor exposes "which window is in front" to an unprivileged client — that is
// the security model the protocol was designed around, not a gap in this port. So this module
// takes `presenceNative.ts`'s ONE documented failure path on purpose: `waylandReason()` is checked
// BEFORE `koffi.load()` even runs, and if the session looks like Wayland this throws a descriptive
// `Error` — same as a missing DLL would on Windows, same as a missing `libX11.so.6` would here.
// `presenceWorker.ts` already turns that throw into `X|native-unavailable` and stops cleanly (its
// own header: "THE SURFACE EITHER LOADS OR IT DOES NOT, and it is decided once, here"), and
// `presence.ts`'s collapse fold turns repeated instances of that into exactly ONE `logError` call
// rather than one per restart — that pipeline is upstream's and this port does not duplicate it.
// This file's OWN obligation is narrower and is met right at the throw site: the message names the
// exact env var and value that tripped it and points at D5, so whoever reads it — a dev console, a
// debugger paused on the throw, `errors.log` — gets the real reason, not a bare tag. (This module
// cannot call `console.*` itself to say more: `eslint.config.mjs` sets `no-console: 'error'` across
// all of `src/main`, precisely so every error-path write goes through the one door
// `errorLog.ts` owns — and that door is main-thread-only, which this worker-thread module is not.)

import * as koffi from 'koffi'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
// Imported rather than respelled, for the same reason `presenceNative.ts` imports it: the running
// scan and "is this window EverQuest" must never disagree about what the game is called.
import { EQ_CLIENT_EXES } from './presenceProtocol'
import type { ForegroundWindow, MutablePoint, PresenceNative } from './presenceNative'

// ============================================================================================
// Wayland detection — the module's one documented failure path, decided before anything loads.
// ============================================================================================

/**
 * Why this session cannot get a foreground-window surface, or `null` when X11 looks reachable.
 *
 * Pure and env-injectable on purpose: `tests/presenceNativeLinux.test.mts` exercises every branch
 * with fixture environments, with no display, no koffi, nothing that could flake in CI.
 */
export function waylandReason(env: NodeJS.ProcessEnv): string | null {
  const sessionType = env.XDG_SESSION_TYPE?.trim().toLowerCase()
  if (sessionType === 'wayland') {
    return (
      `XDG_SESSION_TYPE=wayland — no foreground-window surface exists on Wayland, by design ` +
      `(docs/linux-port/DECISIONS.md D5): no compositor exposes "which window is in front" to an ` +
      `unprivileged client. Overlay auto-hide and the cursor ring are disabled for this session; ` +
      `everything else the app does is unaffected.`
    )
  }
  // No session type at all (some minimal compositors, some containers) but a Wayland socket and
  // no X11 one: the same conclusion, reached without the label.
  if (!sessionType && env.WAYLAND_DISPLAY && !env.DISPLAY) {
    return (
      `WAYLAND_DISPLAY is set and DISPLAY is not — this session has no X11 to speak to ` +
      `(docs/linux-port/DECISIONS.md D5). Overlay auto-hide and the cursor ring are disabled.`
    )
  }
  return null
}

// ============================================================================================
// `/proc` — no FFI, no library, nothing that can fail to load.
// ============================================================================================

/** Overridable only so the test suite can point these at a fixture directory shaped like `/proc`
 *  instead of the real one; every production caller uses the default. */
export const DEFAULT_PROC_ROOT = '/proc'

const PID_DIR_NAME = /^[0-9]+$/

/**
 * A process's full image path, or '' when the kernel will not say — the same failure value
 * `presenceNative.ts`'s `imagePath()` answers for a protected or vanished process. `readlink` on
 * `/proc/<pid>/exe` is the entire call (`proc(5)`); no OpenProcess/QueryFullProcessImageName
 * two-step exists to port because Linux answers this in one syscall to begin with.
 */
export function readImagePath(pid: number, procRoot: string = DEFAULT_PROC_ROOT): string {
  try {
    return readlinkSync(`${procRoot}/${pid}/exe`)
  } catch {
    return ''
  }
}

/** The last `/`- or `\`-separated segment of a path, lowercased — mirrors `presenceNative.ts`'s
 *  own `exeBaseName`, and is applied the same way: to ONE cmdline argument, not the whole line, so
 *  a coincidental substring elsewhere in argv cannot forge a match. */
function argBaseName(arg: string): string {
  const p = arg.trim().toLowerCase().replace(/\\/g, '/')
  const cut = p.lastIndexOf('/')
  return cut < 0 ? p : p.slice(cut + 1)
}

/**
 * 1 = an EverQuest client is running, 0 = none is, -1 = the enumeration itself failed — the same
 * three answers `presenceNative.ts`'s `EnumProcesses` scan gives, over every `/proc/<pid>/cmdline`
 * instead.
 *
 * MATCHES ON CMDLINE (D5) — see this file's header for why image-path matching finds nothing under
 * Proton. Each process's argv is checked one ARGUMENT at a time, first against `EQ_CLIENT_EXES` by
 * basename (exactly the Win32 predicate, applied to whichever argv entry names the executable),
 * then — only if that missed — against the caller's EQ root as a normalised substring, which is
 * the same fallback `presenceNative.ts`'s scan performs against `imagePath()`.
 */
export function scanEqRunning(rootWithSep: string, procRoot: string = DEFAULT_PROC_ROOT): number {
  let pids: string[]
  try {
    pids = readdirSync(procRoot).filter((name) => PID_DIR_NAME.test(name))
  } catch {
    // `/proc` itself would not enumerate — the direct analogue of `EnumProcesses` failing.
    return -1
  }
  // Compared against cmdline TEXT, so normalised the same way that text is: separators unified (a
  // Wine argument spells its path with `\` as often as `/`) and lowercased — the Win32 scan's own
  // case-insensitive compare, carried over.
  const root = rootWithSep.trim().toLowerCase().replace(/\\/g, '/')
  for (const pid of pids) {
    let raw: string
    try {
      raw = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8')
    } catch {
      // The process exited between the readdir and this read — one stale entry, not the
      // enumeration failing. EnumProcesses races the same way and is read the same way: skip it.
      continue
    }
    const argv = raw.split('\0').filter((a) => a.length > 0)
    if (argv.length === 0) continue
    if (argv.some((a) => EQ_CLIENT_EXES.has(argBaseName(a)))) return 1
    if (root.length > 0 && argv.some((a) => a.toLowerCase().replace(/\\/g, '/').includes(root))) {
      return 1
    }
  }
  return 0
}

// ============================================================================================
// X11 — the typed FFI boundary, one function family per Xlib call, `presenceNative.ts`'s idiom.
// ============================================================================================

type X11Fn = (...args: unknown[]) => unknown

function bind(lib: koffi.IKoffiLib, prototype: string): X11Fn {
  return lib.func(prototype)
}

/** An Xlib `Status`/`Bool` return. Both are `typedef int` in `X11/Xlib.h` — NOT koffi's 1-byte
 *  `bool`, which is why every prototype below spells them `int` and every check here is `!== 0`
 *  rather than `=== true`. (`Status`'s "0 means success" cases — `XGetWindowProperty` — are read
 *  directly as `asInt(...) !== 0` meaning FAILURE at their own call sites; this coercer is for the
 *  more common "nonzero means success" ones: `XGetWindowAttributes`, `XTranslateCoordinates`,
 *  `XQueryPointer`.) */
function asInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
}

/** An X `Window`/`Atom`/`XID` — `unsigned long` in Xlib, i.e. 8 bytes on this platform. koffi hands
 *  back a `Number` when the value fits safely and a `BigInt` otherwise; every id this file ever
 *  sees (window ids, atoms, pids) fits, but the coercion is applied uniformly rather than assumed. */
function asULong(v: unknown): number {
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function isHandle(v: unknown): boolean {
  return v !== null && v !== undefined && v !== 0
}

/**
 * `XWindowAttributes` (`X11/Xlib.h`) — a `koffi.struct`, not a hand-offset `Buffer`. See this
 * file's header for the measurement that makes that the right call HERE (unlike `presenceNative.ts`'s
 * `CURSORINFO`/`RECT`): nothing in this module runs at tick rate, so correctness-by-construction
 * beats a saving nothing here would notice. Only `x`, `y`, `width`, `height` are ever read — the
 * rest of the fields exist so the struct's total size and member offsets are correct, which is what
 * this depends on, not what this uses.
 *
 * REGISTERED LAZILY, FROM `bindX11()`, NOT AT MODULE SCOPE. This module must stay IMPORTABLE ON
 * ANY PLATFORM — Windows included — WITHOUT CALLING INTO koffi AT ALL: `presenceNative.ts` imports
 * this file unconditionally at its own top, so the one-line platform branch inside
 * `loadPresenceNative()` has something to call, which means anything this file did at module scope
 * would run on every launch of the app, on every OS, merely from being imported. A module-scope
 * `koffi.struct(...)` would be exactly that — plus `koffi.struct` THROWS on a second registration
 * of the same name, so a second evaluation of this module (a dev tool that imports it two ways, a
 * future bundler quirk) would throw at IMPORT TIME, inside the composition root's own import
 * graph, with no recovery path: not "a Linux surface that fails to load" but "the app will not
 * start, on any platform." The flag below makes a repeat call inert instead of a repeat throw, and
 * moving the call here — next to `bindX11()`'s own `koffi.load()` — means it happens only once
 * `loadPresenceNativeLinux()` has already decided this session is Linux and is about to touch
 * koffi for real.
 */
let xWindowAttributesRegistered = false
function registerXWindowAttributes(): void {
  if (xWindowAttributesRegistered) return
  koffi.struct('XWindowAttributes', {
    x: 'int',
    y: 'int',
    width: 'int',
    height: 'int',
    border_width: 'int',
    depth: 'int',
    visual: 'void *',
    root: 'unsigned long',
    win_class: 'int',
    bit_gravity: 'int',
    win_gravity: 'int',
    backing_store: 'int',
    backing_planes: 'unsigned long',
    backing_pixel: 'unsigned long',
    save_under: 'int',
    colormap: 'unsigned long',
    map_installed: 'int',
    map_state: 'int',
    all_event_masks: 'long',
    your_event_mask: 'long',
    do_not_propagate_mask: 'long',
    override_redirect: 'int',
    screen: 'void *'
  })
  xWindowAttributesRegistered = true
}

interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** Window property replies: 32-bit-unit budget for a title read, matched to `presenceNative.ts`'s
 *  own `TITLE_CHARS` budget in bytes (256 words = 1024 bytes = that file's 512 UTF-16 units). */
const TITLE_WORDS = 256
/** `XGetWindowProperty`'s `req_type` meaning "whatever type it actually is" — `X11/Xlib.h`'s
 *  `AnyPropertyType`, spelled out because this file has no X11 headers to pull the constant from. */
const ANY_PROPERTY_TYPE = 0
/** `_NET_ACTIVE_WINDOW` holding the `None` window id — EWMH's "nothing is focused", same meaning
 *  a locked Windows session gives `GetForegroundWindow()`. */
const NO_ACTIVE_WINDOW = 0

/** The eight Xlib entry points this surface calls, bound once from `libX11.so.6`. Split out of
 *  `loadPresenceNativeLinux()` itself only to keep that function under this tree's per-function
 *  line limit — it is still the ONE place all eight prototypes are declared, read top to bottom. */
interface X11Calls {
  XOpenDisplay: X11Fn
  XDefaultRootWindow: X11Fn
  XInternAtom: X11Fn
  XGetWindowProperty: X11Fn
  XFree: X11Fn
  XGetWindowAttributes: X11Fn
  XTranslateCoordinates: X11Fn
  XQueryPointer: X11Fn
}

function bindX11(x11: koffi.IKoffiLib): X11Calls {
  // Registered here, immediately after the library this file's one koffi.load() call opens, and
  // before the `XGetWindowAttributes` prototype string below resolves `XWindowAttributes *` by
  // name — see the type's own header for why this cannot live at module scope.
  registerXWindowAttributes()
  return {
    XOpenDisplay: bind(x11, 'void *XOpenDisplay(const char *display_name)'),
    XDefaultRootWindow: bind(x11, 'unsigned long XDefaultRootWindow(void *display)'),
    XInternAtom: bind(
      x11,
      'unsigned long XInternAtom(void *display, const char *atom_name, int only_if_exists)'
    ),
    // ---- (1) properties: the active window, its pid, its title ----
    XGetWindowProperty: bind(
      x11,
      'int XGetWindowProperty(void *display, unsigned long w, unsigned long property, ' +
        'long long_offset, long long_length, int delete, unsigned long req_type, ' +
        '_Out_ unsigned long *actual_type_return, _Out_ int *actual_format_return, ' +
        '_Out_ unsigned long *nitems_return, _Out_ unsigned long *bytes_after_return, ' +
        '_Out_ void **prop_return)'
    ),
    XFree: bind(x11, 'int XFree(void *data)'),
    // ---- (2) geometry: size direct, position translated to root (see header) ----
    XGetWindowAttributes: bind(
      x11,
      'int XGetWindowAttributes(void *display, unsigned long w, ' +
        '_Out_ XWindowAttributes *window_attributes_return)'
    ),
    XTranslateCoordinates: bind(
      x11,
      'int XTranslateCoordinates(void *display, unsigned long src_w, unsigned long dest_w, ' +
        'int src_x, int src_y, _Out_ int *dest_x_return, _Out_ int *dest_y_return, ' +
        '_Out_ unsigned long *child_return)'
    ),
    // ---- (3) the pointer, the one call that runs every tick when the ring is on ----
    XQueryPointer: bind(
      x11,
      'int XQueryPointer(void *display, unsigned long w, _Out_ unsigned long *root_return, ' +
        '_Out_ unsigned long *child_return, _Out_ int *root_x_return, _Out_ int *root_y_return, ' +
        '_Out_ int *win_x_return, _Out_ int *win_y_return, _Out_ unsigned int *mask_return)'
    )
  }
}

/** Opens the one `Display *` this surface ever uses, and the root window under it. THROWS when
 *  there is no server to open — the display half of this module's one failure path. */
function openDisplay(calls: X11Calls, env: NodeJS.ProcessEnv): { display: unknown; root: number } {
  const display = calls.XOpenDisplay(null)
  if (!isHandle(display)) {
    throw new Error(
      `presenceNativeLinux: XOpenDisplay failed for DISPLAY=${env.DISPLAY ?? '(unset)'} — no X ` +
        `server reachable`
    )
  }
  return { display, root: asULong(calls.XDefaultRootWindow(display)) }
}

interface AtomTable {
  netActiveWindow: number
  netWmPid: number
  netWmName: number
  utf8String: number
  wmName: number
}

/** Interns every EWMH/ICCCM atom this file reads. `only_if_exists = False(0)` throughout: each
 *  name is well-known and this process is entitled to intern it whether or not anything has used
 *  it yet — the normal posture for `XInternAtom`. */
function internAtoms(calls: X11Calls, display: unknown): AtomTable {
  const atom = (name: string): number => asULong(calls.XInternAtom(display, name, 0))
  return {
    netActiveWindow: atom('_NET_ACTIVE_WINDOW'),
    netWmPid: atom('_NET_WM_PID'),
    netWmName: atom('_NET_WM_NAME'),
    utf8String: atom('UTF8_STRING'),
    wmName: atom('WM_NAME')
  }
}

interface PropertyReaders {
  /** One `unsigned long`-typed (format 32) property value — `_NET_ACTIVE_WINDOW`, `_NET_WM_PID` —
   *  or `null` when the window has no such property. Frees the X server reply itself. */
  readUlongProperty: (win: number, property: number) => number | null
  /** A text property — `_NET_WM_NAME`/`UTF8_STRING`, or the `WM_NAME` fallback — decoded as
   *  UTF-8. `''` when absent, so the caller can try the next atom like a Win32 empty string. */
  readTextProperty: (win: number, property: number, reqType: number) => string
}

/** `XGetWindowProperty` has one Status polarity ("0 means success") that every OTHER Xlib call in
 *  this file does not share — `asInt(status) !== 0` reads as FAILURE here, the opposite of
 *  `XGetWindowAttributes`/`XTranslateCoordinates`/`XQueryPointer` below. Read the `status !== 0`
 *  checks in both readers with that in mind. */
function makePropertyReaders(calls: X11Calls, display: unknown): PropertyReaders {
  // Reply out-params, allocated once and reused: not because this runs at tick rate (it does not,
  // `foreground()` rides the ~150 ms cadence like Win32's), but because there is no reason for a
  // fresh array on every call when one, reset before each use, does exactly as well.
  const propType = [0]
  const propFormat = [0]
  const propItems = [0]
  const propAfter = [0]
  const propData: [unknown] = [null]

  function fetch(win: number, property: number, reqType: number, maxWords: number): boolean {
    propItems[0] = 0
    propData[0] = null
    const status = asInt(
      calls.XGetWindowProperty(
        display,
        win,
        property,
        0,
        maxWords,
        0,
        reqType,
        propType,
        propFormat,
        propItems,
        propAfter,
        propData
      )
    )
    return status === 0 && propItems[0] > 0 && propData[0] !== null
  }

  function readUlongProperty(win: number, property: number): number | null {
    if (!fetch(win, property, ANY_PROPERTY_TYPE, 4)) return null
    try {
      const words = koffi.decode(propData[0], 'unsigned long', propItems[0]) as unknown as (
        | number
        | bigint
      )[]
      return asULong(words[0])
    } finally {
      calls.XFree(propData[0])
    }
  }

  function readTextProperty(win: number, property: number, reqType: number): string {
    if (!fetch(win, property, reqType, TITLE_WORDS)) return ''
    try {
      const bytes = koffi.decode(propData[0], 'uint8', propItems[0]) as unknown as Uint8Array
      return Buffer.from(bytes).toString('utf8')
    } finally {
      calls.XFree(propData[0])
    }
  }

  return { readUlongProperty, readTextProperty }
}

/** Size direct from `XGetWindowAttributes`; position TRANSLATED to root — see this file's header
 *  for why the raw attributes' position is the wrong answer under a reparenting window manager. */
function makeGeometryReader(
  calls: X11Calls,
  display: unknown,
  root: number
): (win: number) => WindowRect | null {
  const destX = [0]
  const destY = [0]
  const destChild = [0]
  return function windowRect(win: number): WindowRect | null {
    const attrs: WindowRect = { x: 0, y: 0, width: 0, height: 0 }
    if (asInt(calls.XGetWindowAttributes(display, win, attrs)) === 0) return null
    destX[0] = 0
    destY[0] = 0
    destChild[0] = 0
    const translated =
      asInt(calls.XTranslateCoordinates(display, win, root, 0, 0, destX, destY, destChild)) !== 0
    return {
      x: translated ? destX[0] : attrs.x,
      y: translated ? destY[0] : attrs.y,
      width: attrs.width,
      height: attrs.height
    }
  }
}

/**
 * X11 has no "is the cursor being drawn" question the way `GetCursorInfo`'s flag answers one —
 * there is no compositor-agnostic notion of a hidden system cursor to ask about on X (a client can
 * warp/hide its OWN rendering, but that is not state the server exposes), so this always answers
 * TRUE. That is also exactly the interface's documented failure direction (`cursorShowing` "answers
 * TRUE" when it cannot know), so answering it unconditionally here is the same contract, not a
 * different one.
 *
 * The POSITION still comes from a real call — `XQueryPointer` — and follows the interface's other
 * rule exactly: a failed query writes `NaN` into `out.x` rather than leaving a stale point.
 */
function makeCursorReader(
  calls: X11Calls,
  display: unknown,
  root: number
): (out?: MutablePoint) => boolean {
  const qRoot = [0]
  const qChild = [0]
  const qRootX = [0]
  const qRootY = [0]
  const qWinX = [0]
  const qWinY = [0]
  const qMask = [0]
  return function cursorShowing(out?: MutablePoint): boolean {
    if (!out) return true
    qRoot[0] = 0
    qChild[0] = 0
    qRootX[0] = 0
    qRootY[0] = 0
    qWinX[0] = 0
    qWinY[0] = 0
    qMask[0] = 0
    const ok =
      asInt(
        calls.XQueryPointer(display, root, qRoot, qChild, qRootX, qRootY, qWinX, qWinY, qMask)
      ) !== 0
    if (!ok) {
      out.x = Number.NaN
      return true
    }
    out.x = qRootX[0]
    out.y = qRootY[0]
    return true
  }
}

/**
 * Open `libX11.so.6` and wire up this file's four `PresenceNative` methods. THROWS if any of it
 * fails — a Wayland session (checked first, before anything loads), a missing library, a missing
 * export, or a display that will not open — which is this module's one failure path, exactly
 * mirroring `presenceNative.ts`'s `loadPresenceNative()`. Called from the presence WORKER thread
 * only, same as the Win32 loader.
 *
 * `env` defaults to `process.env` and exists as a parameter only so
 * `tests/presenceNativeLinux.test.mts` can drive the Wayland branch with fixture environments
 * without touching the real process environment.
 */
export function loadPresenceNativeLinux(env: NodeJS.ProcessEnv = process.env): PresenceNative {
  const reason = waylandReason(env)
  if (reason) throw new Error(`presenceNativeLinux: ${reason}`)

  const calls = bindX11(koffi.load('libX11.so.6'))
  const { display, root } = openDisplay(calls, env)
  const atoms = internAtoms(calls, display)
  const { readUlongProperty, readTextProperty } = makePropertyReaders(calls, display)
  const windowRect = makeGeometryReader(calls, display, root)
  const cursorShowing = makeCursorReader(calls, display, root)

  function foreground(): ForegroundWindow | null {
    const active = readUlongProperty(root, atoms.netActiveWindow)
    if (active === null || active === NO_ACTIVE_WINDOW) return null
    const rect = windowRect(active)
    if (!rect) return null
    const pid = readUlongProperty(active, atoms.netWmPid) ?? 0
    let title = readTextProperty(active, atoms.netWmName, atoms.utf8String)
    if (!title) title = readTextProperty(active, atoms.wmName, ANY_PROPERTY_TYPE)
    return { pid, x: rect.x, y: rect.y, width: rect.width, height: rect.height, title }
  }

  return {
    cursorShowing,
    foreground,
    imagePath: (pid: number) => readImagePath(pid),
    eqRunning: (rootWithSep: string) => scanEqRunning(rootWithSep)
  }
}
