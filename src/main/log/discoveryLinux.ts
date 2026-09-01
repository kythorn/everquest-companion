// LINUX/WINE INSTALL-ROOT CANDIDATES (pure, dependency-free core — this port owns this file
// outright; upstream never touches it, see docs/linux-port/BACKPORT.md).
//
// On Linux, EverQuest runs inside a Wine/Proton PREFIX — an ordinary directory holding a fake
// `C:` drive at `<prefix>/drive_c` (docs/linux-port/DECISIONS.md D2: no Wine API, no `winepath`,
// `drive_c` is just a folder to us). `discoverEqRoot` (discovery.ts) already knows how to sweep
// "candidate root × Daybreak subpath, first hit with logs wins" for Windows drive letters — this
// module supplies the LINUX flavour of "candidate root": every prefix this machine plausibly
// has, instead of every drive letter.
//
// Two things Windows discovery never has to deal with (D3/D4):
//   1. THERE IS NO REGISTRY TO ASK. The real install on the dev box is Steam appid 3695821840,
//      which is above 2^31 — a non-Steam-game shortcut, an id Steam mints per-user. There is no
//      stable appid to look up, so discovery SWEEPS `compatdata/*/pfx` rather than asking Steam
//      for a specific game.
//   2. WINE'S CASING VARIES. Windows says `Users\Public`; the real Proton prefix on this box says
//      `users/Public` (lowercase `u`) — verified, not assumed. Casing varies by prefix, by
//      creator, and by Proton version, and ext4 is case-sensitive, so a hardcoded Linux spelling
//      is a bug waiting for the next prefix. `resolvePathCI` below resolves each path COMPONENT
//      through a case-insensitive `readdir` match instead of trusting a literal, which is what
//      lets this module reuse `discovery.ts`'s `DAYBREAK_SUBPATHS` table verbatim (just
//      `\` → `/`) rather than maintaining a second, divergent copy of it.
//
// PURE AND INJECTED, same shape as discovery.ts's `DiscoveryProbes`: every filesystem question
// goes through `LinuxFsProbes`, so the whole sweep is unit-testable under plain node with no real
// disk and no Electron. `realLinuxFsProbes()` binds it to the real `fs`/`os`/`process.env` for the
// one caller that needs the real machine (`discovery.ts`'s `discoverEqRoot`, wired through the
// optional `linuxPrefixCandidates` probe — never called on win32).
//
// PREFIX ROOTS SWEPT, in the order D3 specifies: `$WINEPREFIX`, `~/.wine`, Steam
// `steamapps/compatdata/*/pfx` (across every library root named in `libraryfolders.vdf`, not
// just the default one), Lutris, Bottles, Heroic. `discoverEqRoot` dedupes and is first-hit-wins,
// so the ORDER here is a preference, not a correctness requirement — but cheaper/likelier sources
// go first.
//
// WHAT'S VERIFIED ON THIS BOX vs. DOCUMENTED CONVENTION: `$WINEPREFIX`, `~/.wine` and the Steam
// `compatdata` sweep (incl. multi-library `libraryfolders.vdf`) are exercised against the real
// dev box (see `tests/logDiscoveryLinux.test.mts`'s "real Proton shape" test). Lutris is grounded
// in this box's own `~/.config/lutris/games/*.yml` (`game.prefix`, verified against a real
// Battle.net install). Bottles (`~/.local/share/bottles/bottles/<name>`, plus its Flatpak data
// dir) and Heroic (`winePrefix` in `~/.config/heroic/GamesConfig/*.json`, plus its Flatpak config
// dir) are neither installed on this box — they are each tool's own documented on-disk shape,
// included because D3 names them, not invented.

import { readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { DAYBREAK_SUBPATHS } from './discovery'

/** `DAYBREAK_SUBPATHS`, Wine-side: `\` is never a real separator under `drive_c`. */
const DAYBREAK_SUBPATHS_POSIX = DAYBREAK_SUBPATHS.map((p) => p.replace(/\\/g, '/'))

// ---------------------------------------------------------------------------
// Pure core (injectable probes → unit-testable without a real disk).
// ---------------------------------------------------------------------------

/** The filesystem/environment questions the Linux sweep asks. Injected → testable. */
export interface LinuxFsProbes {
  /** List a directory's entries, or null if it doesn't exist / can't be read (never throws). */
  listDir: (path: string) => string[] | null
  /** Read a whole text file, or null if it's absent/unreadable (never throws). */
  readFile: (path: string) => string | null
  /** Read an environment variable. */
  env: (name: string) => string | undefined
  /** The current user's home directory. */
  home: () => string
}

/** Join POSIX path segments with `/`, tolerant of stray leading/trailing slashes on each part. */
function joinPosix(base: string, ...rest: string[]): string {
  let out = base.replace(/\/+$/, '')
  for (const part of rest) out += `/${part.replace(/^\/+|\/+$/g, '')}`
  return out
}

/**
 * Resolve one path SEGMENT under `dir` case-insensitively via `listDir` — the D4 fix. Null if
 * `dir` can't be listed or holds nothing matching `segment` (any case).
 */
export function resolveSegmentCI(fs: LinuxFsProbes, dir: string, segment: string): string | null {
  const entries = fs.listDir(dir)
  if (!entries) return null
  const want = segment.toLowerCase()
  const hit = entries.find((e) => e.toLowerCase() === want)
  return hit === undefined ? null : joinPosix(dir, hit)
}

/**
 * Resolve a whole `/`-separated relative path under `root`, one case-insensitive segment at a
 * time (D4). Null the moment any segment is missing — a partial match is not a candidate.
 */
export function resolvePathCI(fs: LinuxFsProbes, root: string, relPath: string): string | null {
  let cur = root
  for (const segment of relPath.split('/').filter((s) => s.length > 0)) {
    const next = resolveSegmentCI(fs, cur, segment)
    if (next === null) return null
    cur = next
  }
  return cur
}

// ---------------------------------------------------------------------------
// Prefix-root sources (D3).
// ---------------------------------------------------------------------------

/** Where Steam itself might be installed — native package, Valve's own installer, Flatpak. */
const STEAM_ROOTS = [
  '.steam/steam',
  '.steam/debian-installation',
  '.local/share/Steam',
  '.var/app/com.valvesoftware.Steam/.local/share/Steam'
]

/**
 * Pull `"path" "…"` library roots out of a `libraryfolders.vdf`. Pure over the file's text, so
 * the (deliberately tiny — this is not a general VDF parser) shape of that key is a unit test.
 * Steam writes POSIX paths verbatim on Linux, so the only escape this needs to undo is a doubled
 * backslash, kept defensively in case a library was ever added from a Windows-side Steam.
 */
export function parseLibraryFolders(vdf: string): string[] {
  const out: string[] = []
  const re = /"path"\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(vdf)) !== null) out.push(m[1].replace(/\\\\/g, '/'))
  return out
}

/** Every Steam library root this machine might have: each `STEAM_ROOTS` entry, plus whatever
 *  `libraryfolders.vdf` under it names (a second drive, an external SSD, …). */
function steamLibraryRoots(fs: LinuxFsProbes): string[] {
  const roots = new Set<string>()
  for (const rel of STEAM_ROOTS) {
    const steamRoot = joinPosix(fs.home(), rel)
    roots.add(steamRoot)
    const vdf = fs.readFile(joinPosix(steamRoot, 'steamapps/libraryfolders.vdf'))
    if (vdf) for (const p of parseLibraryFolders(vdf)) roots.add(p.replace(/\/+$/, ''))
  }
  return [...roots]
}

/** `<library>/steamapps/compatdata/<appid>/pfx` for every appid under every library (D3: swept
 *  wholesale, never looked up by a specific appid — see the module header). */
function steamCompatDataPrefixes(fs: LinuxFsProbes): string[] {
  const out: string[] = []
  for (const lib of steamLibraryRoots(fs)) {
    const compat = joinPosix(lib, 'steamapps/compatdata')
    const ids = fs.listDir(compat)
    if (!ids) continue
    for (const id of ids) out.push(joinPosix(compat, id, 'pfx'))
  }
  return out
}

/**
 * Lutris records each game's prefix in its OWN yml under `~/.config/lutris/games/`
 * (`game.prefix`, `$GAMEDIR` meaning "this file's own directory" — never a real prefix path, so
 * it's dropped). Grounded in this box's real Battle.net install
 * (`~/.config/lutris/games/battlenet-standard-*.yml`); a line-regex over `prefix:` rather than a
 * YAML parser because that is the whole of what this needs, and the installer-task entries repeat
 * the same value the `game:` block has, which the de-dupe below absorbs for free.
 */
function lutrisPrefixes(fs: LinuxFsProbes): string[] {
  const dir = joinPosix(fs.home(), '.config/lutris/games')
  const files = fs.listDir(dir)
  if (!files) return []
  const out = new Set<string>()
  for (const f of files) {
    if (!/\.ya?ml$/i.test(f)) continue
    const content = fs.readFile(joinPosix(dir, f))
    if (!content) continue
    const re = /^\s*prefix:\s*(.+?)\s*$/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const p = m[1].trim().replace(/^['"]|['"]$/g, '')
      if (p && p !== '$GAMEDIR') out.add(p.replace(/\/+$/, ''))
    }
  }
  return [...out]
}

/** Bottles: one bottle = one prefix directory directly under its data dir (native or Flatpak). */
const BOTTLES_ROOTS = [
  '.local/share/bottles/bottles',
  '.var/app/com.usebottles.bottles/data/bottles/bottles'
]

function bottlesPrefixes(fs: LinuxFsProbes): string[] {
  const out: string[] = []
  for (const rel of BOTTLES_ROOTS) {
    const dir = joinPosix(fs.home(), rel)
    const names = fs.listDir(dir)
    if (!names) continue
    for (const n of names) out.push(joinPosix(dir, n))
  }
  return out
}

/** Heroic: `winePrefix` in each per-game config JSON (native or Flatpak). A config that doesn't
 *  parse as JSON, or has no string `winePrefix`, is simply not a source — never a hard failure. */
const HEROIC_CONFIG_DIRS = [
  '.config/heroic/GamesConfig',
  '.var/app/com.heroicgameslauncher.hgl/config/heroic/GamesConfig'
]

/** The `winePrefix` string out of one Heroic `GamesConfig/*.json`, or null for anything that
 *  doesn't parse as JSON with a non-empty string `winePrefix` — never a throw. */
function heroicWinePrefixFromConfig(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const wp = parsed.winePrefix
    return typeof wp === 'string' && wp ? wp.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

function heroicPrefixes(fs: LinuxFsProbes): string[] {
  const out = new Set<string>()
  for (const rel of HEROIC_CONFIG_DIRS) {
    const dir = joinPosix(fs.home(), rel)
    const files = fs.listDir(dir)
    if (!files) continue
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const content = fs.readFile(joinPosix(dir, f))
      const wp = content ? heroicWinePrefixFromConfig(content) : null
      if (wp) out.add(wp)
    }
  }
  return [...out]
}

/** Every Wine/Proton prefix root this machine plausibly has, in D3's order. */
export function winePrefixRoots(fs: LinuxFsProbes): string[] {
  const out: string[] = []
  const push = (p: string | undefined | null): void => {
    if (p) out.push(p.replace(/\/+$/, ''))
  }
  push(fs.env('WINEPREFIX'))
  push(joinPosix(fs.home(), '.wine'))
  for (const p of steamCompatDataPrefixes(fs)) push(p)
  for (const p of lutrisPrefixes(fs)) push(p)
  for (const p of bottlesPrefixes(fs)) push(p)
  for (const p of heroicPrefixes(fs)) push(p)
  return out
}

// ---------------------------------------------------------------------------
// The candidate builder `discovery.ts` consumes (`DiscoveryProbes.linuxPrefixCandidates`).
// ---------------------------------------------------------------------------

/**
 * Every fully-resolved EQ install-root candidate this machine's Wine prefixes might hold: each
 * prefix root's `drive_c`, walked case-insensitively (D4) against every `DAYBREAK_SUBPATHS`
 * entry (D3/D4's reuse of the Windows table). `discoverEqRoot` dedupes and is first-hit-wins, so
 * a candidate that resolves but has no `Logs/eqlog_*.txt` costs one more `readdir` there, not a
 * wrong answer.
 */
export function linuxEqRootCandidates(fs: LinuxFsProbes): string[] {
  const out: string[] = []
  for (const prefix of winePrefixRoots(fs)) {
    const driveC = joinPosix(prefix, 'drive_c')
    for (const sub of DAYBREAK_SUBPATHS_POSIX) {
      const resolved = resolvePathCI(fs, driveC, sub)
      if (resolved) out.push(resolved)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Real-environment probes.
// ---------------------------------------------------------------------------

/** The real-filesystem probe set — `discovery.ts` binds this in behind `process.platform`. */
export function realLinuxFsProbes(): LinuxFsProbes {
  return {
    listDir: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return null
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    env: (name) => process.env[name],
    home: () => homedir()
  }
}
