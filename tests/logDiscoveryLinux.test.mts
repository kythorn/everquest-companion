// LINUX/WINE INSTALL-ROOT DISCOVERY (docs/linux-port/DECISIONS.md D3/D4): everything
// `src/main/log/discoveryLinux.ts` does to turn "some Wine prefixes exist on this machine" into
// the same kind of candidate `discoverEqRoot` (discovery.ts) already knows how to sweep for
// Windows drive letters. Three layers, all driven through injected `LinuxFsProbes` — no real disk,
// no Electron — except the one test marked "real box", which deliberately reads the actual dev
// machine and is skipped where that machine's install isn't present (not a platform skip: the
// injected-probe tests above it already prove the logic on any OS).
//
//   1. `resolveSegmentCI` / `resolvePathCI` — the D4 fix: a Wine prefix's casing varies (this
//      machine's real prefix spells it `users/Public`, not `Users\Public`), so each path
//      component is resolved through a case-insensitive `readdir` match rather than trusted
//      literally.
//   2. `winePrefixRoots` (+ `parseLibraryFolders`) — the D3 sweep: `$WINEPREFIX`, `~/.wine`, Steam
//      `compatdata/*/pfx` across every library `libraryfolders.vdf` names, Lutris, Bottles,
//      Heroic.
//   3. `linuxEqRootCandidates` — the two combined, reusing `discovery.ts`'s own
//      `DAYBREAK_SUBPATHS` table (D4) — plus `discoverEqRoot`'s new `linuxPrefixCandidates` probe,
//      which must never disturb the existing win32 sweep order (extraCandidates → fixedDrives →
//      Linux prefixes).
//
// Run: `node --import tsx --test tests/logDiscoveryLinux.test.mts`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { discoverEqRoot, type DiscoveryProbes } from '../src/main/log/discovery'
import {
  linuxEqRootCandidates,
  parseLibraryFolders,
  realLinuxFsProbes,
  resolvePathCI,
  resolveSegmentCI,
  winePrefixRoots,
  type LinuxFsProbes
} from '../src/main/log/discoveryLinux'

// --- a tiny in-memory filesystem for LinuxFsProbes --------------------------

/** Build injected `LinuxFsProbes` from a plain directory-listing / file-content map. Every path
 *  is an exact string key (this module's own `joinPosix` output shape: `/`-joined, no trailing
 *  slash) — no globbing, no normalization, so a test's map IS the contract being asserted. */
function fakeFs(opts: {
  dirs: Record<string, string[]>
  files?: Record<string, string>
  env?: Record<string, string>
  home?: string
}): LinuxFsProbes {
  const files = opts.files ?? {}
  const env = opts.env ?? {}
  const home = opts.home ?? '/home/tester'
  return {
    listDir: (path) => opts.dirs[path] ?? null,
    readFile: (path) => (path in files ? files[path] : null),
    env: (name) => env[name],
    home: () => home
  }
}

// --- resolveSegmentCI / resolvePathCI (D4) ----------------------------------

test('resolveSegmentCI: matches a directory entry regardless of case', () => {
  const fs = fakeFs({ dirs: { '/pfx/drive_c': ['users', 'Program Files'] } })
  assert.equal(resolveSegmentCI(fs, '/pfx/drive_c', 'Users'), '/pfx/drive_c/users')
  assert.equal(resolveSegmentCI(fs, '/pfx/drive_c', 'USERS'), '/pfx/drive_c/users')
  assert.equal(resolveSegmentCI(fs, '/pfx/drive_c', 'users'), '/pfx/drive_c/users')
})

test('resolveSegmentCI: null when the directory has no such entry, in any case', () => {
  const fs = fakeFs({ dirs: { '/pfx/drive_c': ['users'] } })
  assert.equal(resolveSegmentCI(fs, '/pfx/drive_c', 'Public'), null)
})

test('resolveSegmentCI: null when the directory itself cannot be listed', () => {
  const fs = fakeFs({ dirs: {} })
  assert.equal(resolveSegmentCI(fs, '/does/not/exist', 'users'), null)
})

test('resolvePathCI: chains segments through mismatched casing at every level', () => {
  // The real dev-box shape: only `users` is lowercase; everything below it matches Windows casing
  // exactly (verified against the real prefix — see the "real box" test below).
  const fs = fakeFs({
    dirs: {
      '/pfx/drive_c': ['users', 'Program Files'],
      '/pfx/drive_c/users': ['Public', 'steamuser'],
      '/pfx/drive_c/users/Public': ['Daybreak Game Company', 'Desktop'],
      '/pfx/drive_c/users/Public/Daybreak Game Company': ['Installed Games'],
      '/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games': ['EverQuest Legends']
    }
  })
  const resolved = resolvePathCI(
    fs,
    '/pfx/drive_c',
    'Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends'
  )
  assert.equal(resolved, '/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends')
})

test('resolvePathCI: null the moment one segment is missing, however deep', () => {
  const fs = fakeFs({
    dirs: {
      '/pfx/drive_c': ['users'],
      '/pfx/drive_c/users': ['Public']
      // 'Daybreak Game Company' does not exist under Public — no entry for that dir at all.
    }
  })
  assert.equal(resolvePathCI(fs, '/pfx/drive_c', 'Users/Public/Daybreak Game Company'), null)
})

// --- parseLibraryFolders (Steam's libraryfolders.vdf) -----------------------

test('parseLibraryFolders: reads every "path" value out of a real-shaped VDF', () => {
  const vdf = `"libraryfolders"
{
	"0"
	{
		"path"		"/home/tester/.steam/debian-installation"
		"label"		""
	}
	"1"
	{
		"path"		"/mnt/extra-drive/SteamLibrary"
		"label"		""
	}
}`
  assert.deepEqual(parseLibraryFolders(vdf), [
    '/home/tester/.steam/debian-installation',
    '/mnt/extra-drive/SteamLibrary'
  ])
})

test('parseLibraryFolders: an empty/malformed file yields no libraries, not a throw', () => {
  assert.deepEqual(parseLibraryFolders(''), [])
  assert.deepEqual(parseLibraryFolders('not vdf at all'), [])
})

// --- winePrefixRoots (D3 sweep order) ---------------------------------------

test('winePrefixRoots: $WINEPREFIX and ~/.wine come first, unconditionally', () => {
  const fs = fakeFs({ dirs: {}, env: { WINEPREFIX: '/custom/prefix' }, home: '/home/tester' })
  const roots = winePrefixRoots(fs)
  assert.deepEqual(roots.slice(0, 2), ['/custom/prefix', '/home/tester/.wine'])
})

test('winePrefixRoots: sweeps compatdata across every library named in libraryfolders.vdf', () => {
  const home = '/home/tester'
  const fs = fakeFs({
    home,
    dirs: {
      [`${home}/.steam/steam/steamapps/compatdata`]: ['111', '3695821840'],
      [`/mnt/extra/steamapps/compatdata`]: ['222']
    },
    files: {
      [`${home}/.steam/steam/steamapps/libraryfolders.vdf`]: `"libraryfolders"
{
	"0" { "path" "${home}/.steam/steam" }
	"1" { "path" "/mnt/extra" }
}`
    }
  })
  const roots = winePrefixRoots(fs)
  // Both the default library and the second one named in the VDF are swept.
  assert.ok(roots.includes(`${home}/.steam/steam/steamapps/compatdata/111/pfx`))
  assert.ok(roots.includes(`${home}/.steam/steam/steamapps/compatdata/3695821840/pfx`))
  assert.ok(roots.includes('/mnt/extra/steamapps/compatdata/222/pfx'))
})

test('winePrefixRoots: reads a Lutris game prefix out of its yml, ignoring $GAMEDIR', () => {
  const home = '/home/tester'
  const fs = fakeFs({
    home,
    dirs: { [`${home}/.config/lutris/games`]: ['battlenet-standard-123.yml'] },
    files: {
      [`${home}/.config/lutris/games/battlenet-standard-123.yml`]: `game:
  prefix: /home/tester/Games/battlenet
script:
  installer:
  - task:
      prefix: $GAMEDIR
`
    }
  })
  const roots = winePrefixRoots(fs)
  assert.ok(roots.includes('/home/tester/Games/battlenet'))
  assert.ok(!roots.includes('$GAMEDIR'))
})

test('winePrefixRoots: lists Bottles bottles and reads Heroic winePrefix configs', () => {
  const home = '/home/tester'
  const fs = fakeFs({
    home,
    dirs: {
      [`${home}/.local/share/bottles/bottles`]: ['MyBottle'],
      [`${home}/.config/heroic/GamesConfig`]: ['app123.json']
    },
    files: {
      [`${home}/.config/heroic/GamesConfig/app123.json`]: JSON.stringify({ winePrefix: '/home/tester/Games/Heroic/Prefixes/app123' })
    }
  })
  const roots = winePrefixRoots(fs)
  assert.ok(roots.includes(`${home}/.local/share/bottles/bottles/MyBottle`))
  assert.ok(roots.includes('/home/tester/Games/Heroic/Prefixes/app123'))
})

test('winePrefixRoots: an unreadable/malformed Heroic config is skipped, not a throw', () => {
  const home = '/home/tester'
  const fs = fakeFs({
    home,
    dirs: { [`${home}/.config/heroic/GamesConfig`]: ['broken.json'] },
    files: { [`${home}/.config/heroic/GamesConfig/broken.json`]: '{ not json' }
  })
  assert.doesNotThrow(() => winePrefixRoots(fs))
})

// --- linuxEqRootCandidates (D3 + D4 combined) -------------------------------

test('linuxEqRootCandidates: resolves the default public-install subpath under a prefix, case-insensitively', () => {
  const fs = fakeFs({
    env: { WINEPREFIX: '/pfx' },
    dirs: {
      '/pfx/drive_c': ['users'],
      '/pfx/drive_c/users': ['Public'],
      '/pfx/drive_c/users/Public': ['Daybreak Game Company'],
      '/pfx/drive_c/users/Public/Daybreak Game Company': ['Installed Games'],
      '/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games': ['EverQuest Legends']
    }
  })
  const candidates = linuxEqRootCandidates(fs)
  assert.ok(
    candidates.includes('/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends')
  )
})

test('linuxEqRootCandidates: a prefix with none of the Daybreak subpaths contributes nothing', () => {
  const fs = fakeFs({
    env: { WINEPREFIX: '/pfx' },
    dirs: { '/pfx/drive_c': ['Program Files'] }
  })
  assert.deepEqual(linuxEqRootCandidates(fs), [])
})

// --- discoverEqRoot integration: the new probe never disturbs the win32 order -----------------

test('discoverEqRoot: linuxPrefixCandidates is probed AFTER extraCandidates and the drive sweep', () => {
  const winTarget = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const linuxTarget = '/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends'
  // `discoverEqRoot` returns on the FIRST hit, so to see the full probe ORDER `hasLogs` must
  // never match — the order is read from `seen`, the win/loses case is the next test.
  const seen: string[] = []
  const probes: DiscoveryProbes = {
    hasLogs: (root) => {
      seen.push(root)
      return false
    },
    extraCandidates: () => ['E:\\Games\\EQL'],
    fixedDrives: () => ['C:'],
    linuxPrefixCandidates: () => [linuxTarget]
  }
  assert.equal(discoverEqRoot(probes), null)
  const idx = (s: string): number => seen.indexOf(s)
  assert.ok(idx('E:\\Games\\EQL') < idx(winTarget), 'extraCandidates before the drive sweep')
  assert.ok(idx(winTarget) < idx(linuxTarget), 'the drive sweep before Linux prefix candidates')

  // And when BOTH a drive-sweep candidate and a Linux candidate would satisfy discovery, the
  // one tried first (the drive sweep) is the one returned.
  const bothMatch: DiscoveryProbes = {
    hasLogs: (root) => root === winTarget || root === linuxTarget,
    extraCandidates: () => [],
    fixedDrives: () => ['C:'],
    linuxPrefixCandidates: () => [linuxTarget]
  }
  assert.equal(discoverEqRoot(bothMatch), winTarget)
})

test('discoverEqRoot: linuxPrefixCandidates wins when nothing else matches', () => {
  const linuxTarget = '/pfx/drive_c/users/Public/Daybreak Game Company/Installed Games/EverQuest Legends'
  const probes: DiscoveryProbes = {
    hasLogs: (root) => root === linuxTarget,
    extraCandidates: () => [],
    fixedDrives: () => ['C:'],
    linuxPrefixCandidates: () => [linuxTarget]
  }
  assert.equal(discoverEqRoot(probes), linuxTarget)
})

test('discoverEqRoot: omitting linuxPrefixCandidates entirely behaves exactly as before (win32 path)', () => {
  const target = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const probes: DiscoveryProbes = {
    hasLogs: (root) => root === target,
    extraCandidates: () => [],
    fixedDrives: () => ['C:']
  }
  assert.equal(discoverEqRoot(probes), target)
})

// --- the real box (docs/linux-port/GOAL.md's definition of done) -----------------------------
//
// Deliberately NOT injected: this is the one test that reads the actual dev machine, to prove the
// sweep finds the real Steam appid 3695821840 prefix and its lowercase `users`. Skipped (not
// failed) where that install isn't present — this is an environment gate on a specific machine's
// data, not the banned `skip: process.platform !== 'win32'` pattern (D6): every claim about the
// LOGIC is already pinned by the injected-probe tests above, on any OS.
const REAL_TARGET =
  `${homedir()}/.steam/debian-installation/steamapps/compatdata/3695821840/pfx/drive_c/users` +
  '/Public/Daybreak Game Company/Installed Games/EverQuest Legends'

test('linuxEqRootCandidates: finds the real Proton prefix on this dev box', { skip: !existsSync(REAL_TARGET) }, () => {
  const candidates = linuxEqRootCandidates(realLinuxFsProbes())
  assert.ok(
    candidates.includes(REAL_TARGET),
    `expected ${REAL_TARGET} among candidates, got:\n${candidates.join('\n')}`
  )
})
