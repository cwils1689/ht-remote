// AX.25 UI frames and APRS text messages, as the radio hands them over once
// its TNC fragments are joined. Pure JS, no Zepp imports, so it runs under
// Node for tests.
//
// Copyright 2026 Clint Wilson (KO4LTW). Licensed under the Apache License, Version 2.0
// (see LICENSE and NOTICE). The AX.25 address and UI-frame layout follows the
// description in HTCommander's docs (https://github.com/Ylianst/HTCommander,
// by Ylianst, Apache-2.0).

function ascii(b, start, end) {
  let s = ''
  for (let i = start; i < end && i < b.length; i++) {
    const c = b[i]
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?'
  }
  return s
}

// 7-byte AX.25 address: six callsign characters shifted left one bit, then
// the SSID byte (SSID in bits 1-4, bit 0 set on the last address).
function parseAddress(b, at) {
  let call = ''
  for (let i = 0; i < 6; i++) call += String.fromCharCode(b[at + i] >> 1)
  const s = b[at + 6]
  return { call: call.trim(), ssid: (s >> 1) & 0x0f, last: (s & 0x01) !== 0 }
}

export function formatCall(a) {
  return a.ssid ? a.call + '-' + a.ssid : a.call
}

// Returns { dst, src, path, info } for a UI frame, or null for anything else.
export function parseAx25(bytes) {
  const b = bytes
  const addrs = []
  let at = 0
  while (at + 7 <= b.length && addrs.length < 10) {
    const a = parseAddress(b, at)
    addrs.push(a)
    at += 7
    if (a.last) break
  }
  if (addrs.length < 2 || !addrs[addrs.length - 1].last) return null
  if (at + 2 > b.length) return null
  const control = b[at]
  const pid = b[at + 1]
  if ((control & 0xef) !== 0x03 || pid !== 0xf0) return null // UI frame, no layer 3
  return {
    dst: addrs[0],
    src: addrs[1],
    path: addrs.slice(2),
    info: ascii(b, at + 2, b.length)
  }
}

// Telemetry definitions travel as messages a station sends to itself.
const TELEMETRY = /^(PARM|UNIT|EQNS|BITS)\./

// An APRS message from `from` (the AX.25 source): ":ADDRESSEE:text{id".
// Unwraps third-party traffic ("}SRC>DST,PATH:...") so messages an igate
// relays from the internet show the real sender. Returns
// { from, to, text, msgId } or null for acks, rejects, telemetry and
// everything that isn't a message.
export function parseAprsMessage(from, info) {
  for (let hops = 0; info && info[0] === '}' && hops < 3; hops++) {
    const gt = info.indexOf('>')
    const colon = info.indexOf(':')
    if (gt < 2 || colon < gt) return null
    from = info.slice(1, gt)
    info = info.slice(colon + 1)
  }
  if (!info || info[0] !== ':' || info.length < 11 || info[10] !== ':') return null
  const to = info.slice(1, 10).trim().toUpperCase()
  let text = info.slice(11)
  let msgId = null
  const m = /\{([A-Za-z0-9]{1,5})(\}[A-Za-z0-9]{0,5})?\s*$/.exec(text)
  if (m) {
    msgId = m[1]
    text = text.slice(0, m.index)
  }
  text = text.trim()
  if (!to || !text) return null
  if (/^(ack|rej)[A-Za-z0-9]{1,5}\}?/.test(text)) return null
  if (TELEMETRY.test(text)) return null
  return { from: from.toUpperCase(), to, text, msgId }
}

function baseCall(c) {
  return (c || '').toUpperCase().split('-')[0]
}

// With the radio's callsign known, only messages to that callsign (any SSID)
// count. Without it, every station-to-station message does, but bulletins
// and announcements don't.
export function isForMe(msg, myCall) {
  if (myCall) return baseCall(msg.to) === baseCall(myCall)
  return !/^(BLN|NWS-|NWS_|SKY|CWA)/.test(msg.to)
}
