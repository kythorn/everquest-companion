// The provable half of src/main/overlayClickThroughLinux.ts.
//
// That module's job — telling an X server which pixels of an overlay may receive pointer events —
// cannot be asserted without an X server, and a suite that needs one is a suite that does not run
// in CI. So the module keeps its two DECISIONS pure and exported, and this file pins them: which
// bytes of Electron's native handle are the window id, and which sessions have an input region
// worth setting at all. The FFI itself is covered by the measurement recorded in the module header.

import test from 'node:test'
import assert from 'node:assert/strict'
import { clickThroughSkipReason, xidFromHandle } from '../src/main/overlayClickThroughLinux'

test('xidFromHandle reads an 8-byte little-endian XID — the x86-64 shape of an X11 Window', () => {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(0x9a00006n)
  assert.equal(xidFromHandle(buf), 0x9a00006)
})

test('xidFromHandle reads a 4-byte handle too — the width is the platform pointer, not a constant', () => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(0x9c00008)
  assert.equal(xidFromHandle(buf), 0x9c00008)
})

test('xidFromHandle answers 0 for a handle too short to hold an id, rather than reading past it', () => {
  assert.equal(xidFromHandle(Buffer.alloc(0)), 0)
  assert.equal(xidFromHandle(Buffer.alloc(2)), 0)
})

test('xidFromHandle answers 0 rather than a LOSSY id when the value exceeds 2^53', () => {
  // Number() past MAX_SAFE_INTEGER silently rounds, and a rounded window id addresses either
  // nothing or — worse — some other window. Refusing is the only honest answer.
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(0xffff_ffff_ffff_ffffn)
  assert.equal(xidFromHandle(buf), 0)
})

test('every non-Linux platform is skipped — Electron owns click-through where it works', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    assert.match(String(clickThroughSkipReason(platform, {})), new RegExp(platform))
  }
})

test('an X11 Linux session is NOT skipped — this is the case the module exists for', () => {
  assert.equal(clickThroughSkipReason('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), null)
})

test('a Wayland session is skipped, and says so in the shared vocabulary', () => {
  // Deliberately the SAME answer presence gives: one question, one source (waylandReason).
  const reason = clickThroughSkipReason('linux', { XDG_SESSION_TYPE: 'wayland' })
  assert.notEqual(reason, null)
  assert.match(String(reason), /wayland/i)
})

test('Linux with a Wayland socket and no DISPLAY is skipped without needing the session label', () => {
  const reason = clickThroughSkipReason('linux', { WAYLAND_DISPLAY: 'wayland-0' })
  assert.notEqual(reason, null)
})
