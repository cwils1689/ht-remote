// Benshi radio control protocol (VR-N76, UV-PRO, GA-5WB ...) over BLE GATT.
//
// Copyright 2026 Clint Wilson (KO4LTW). Licensed under the Apache License, Version 2.0
// (see LICENSE and NOTICE).
//
// Derived from HTCommander (https://github.com/Ylianst/HTCommander, by
// Ylianst, Apache-2.0): src/lib/radio/gaia_protocol.dart, radio_models.dart,
// radio.dart and docs/blogs/radio-command-protocol.md. Changed from the
// original: rewritten in JavaScript for Zepp OS and BLE-only framing; added
// volume, TNC fragment and BSS callsign parsing, with the packet and
// notification layouts cross-checked against benlink
// (https://github.com/khusmann/benlink, by Kyle Husmann, Apache-2.0).
// Pure JS, no Zepp imports, so it runs under Node for tests.
//
// Over BLE the radio takes the bare command, no GAIA 0xFF 0x01 wrapper:
//   [group_hi, group_lo, cmd_hi, cmd_lo, payload...]
// Replies set bit 0x8000 in the command, carry a status byte at [4] (0 = ok)
// and the payload from [5]. Event notifications (cmd 9) carry the
// notification type at [4] and the data from [5], so the same parsers work
// on both.

export const SERVICE_UUID = '00001100-d102-11e1-9b23-00025b00a5a5'
export const WRITE_UUID = '00001101-d102-11e1-9b23-00025b00a5a5'
export const INDICATE_UUID = '00001102-d102-11e1-9b23-00025b00a5a5'
export const CCCD_UUID = '2902'

// The radio does not advertise its control service, so scans match by name.
export const RADIO_NAME_KEYWORDS = [
  'VR-N76', 'VR-N7500', 'VR-N7600', 'VR-N75', 'UV-PRO', 'UV-50PRO', 'GA-5WB', 'DB50-B',
  'RT-660', 'RT660'
]

export const GROUP_BASIC = 2
export const GROUP_EXTENDED = 10

export const CMD = {
  getDevInfo: 4,
  readStatus: 5,
  registerNotification: 6,
  eventNotification: 9,
  readSettings: 10,
  writeSettings: 11,
  readRfCh: 13,
  getHtStatus: 20,
  getVolume: 22,
  setVolume: 23,
  readBssSettings: 33,
  rxData: 57,
  doProgFunc: 66
}

export const NOTIFY = {
  htStatusChanged: 1,
  dataRxd: 2, // a received packet fragment (APRS, BSS)
  htChChanged: 5,
  htSettingsChanged: 6,
  bssSettingsChanged: 11
}

export const VOLUME_MAX = 15

// Programmable-function effects, triggered remotely with doProgFunc.
export const PF = {
  toggleRadioTx: 4,
  toggleChScan: 12,
  mainPtt: 13,
  subPtt: 14,
  toggleDoubleCh: 17,
  toggleAbCh: 18
}

export const PRODUCT_NAMES = {
  1: 'VR-N7500',
  2: 'VR-N76',
  259: 'VR-N76', // what a VR-N76 on current firmware reports
  3: 'SA-888S',
  4: 'HG-UV98',
  5: 'HAM-AIO'
}

// settings.doubleChannel / status.doubleChannel values
export const DUAL_OFF = 0
export const VFO_A = 1
export const VFO_B = 2

function byte(b, i) {
  return i < b.length ? b[i] : 0
}

function u16(b, i) {
  return (byte(b, i) << 8) | byte(b, i + 1)
}

function u32(b, i) {
  return ((byte(b, i) << 24) | (byte(b, i + 1) << 16) | (byte(b, i + 2) << 8) | byte(b, i + 3)) >>> 0
}

export function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return Uint8Array.from(data)
}

export function hex(bytes) {
  const b = toBytes(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16) + ' '
  return s.trim()
}

// BLE framing as HTCommander sends it: a single trailing 0 byte when there is
// no payload.
export function buildCommand(cmd, payload) {
  const body = payload && payload.length ? payload : [0]
  const out = new Uint8Array(4 + body.length)
  out[0] = 0
  out[1] = GROUP_BASIC
  out[2] = 0
  out[3] = cmd & 0xff
  out.set(body, 4)
  return out
}

export function parseFrame(data) {
  const b = toBytes(data)
  if (b.length < 4) return null
  const group = u16(b, 0)
  const raw = u16(b, 2)
  return {
    group,
    cmd: raw & 0x7fff,
    isReply: (raw & 0x8000) !== 0,
    status: byte(b, 4),
    bytes: b
  }
}

export function parseDevInfo(b) {
  const productId = u16(b, 6)
  return {
    vendorId: byte(b, 5),
    productId,
    name: PRODUCT_NAMES[productId] || null, // null: use the Bluetooth name
    hwVer: byte(b, 8),
    softVer: u16(b, 9),
    regionCount: ((byte(b, 11) & 0x03) << 4) + ((byte(b, 12) & 0xf0) >> 4),
    supportVfo: (byte(b, 12) & 0x02) !== 0,
    channelCount: byte(b, 13)
  }
}

export function parseHtStatus(b) {
  const b5 = byte(b, 5)
  const b6 = byte(b, 6)
  const b7 = byte(b, 7)
  const b8 = byte(b, 8)
  return {
    isPowerOn: (b5 & 0x80) !== 0,
    isInTx: (b5 & 0x40) !== 0,
    isSq: (b5 & 0x20) !== 0,
    isInRx: (b5 & 0x10) !== 0,
    doubleChannel: (b5 & 0x0c) >> 2,
    isScan: (b5 & 0x02) !== 0,
    isHfpConnected: (b6 & 0x04) !== 0,
    isAocConnected: (b6 & 0x02) !== 0,
    rssi: b7 >> 4,
    currRegion: ((b7 & 0x0f) << 2) + (b8 >> 6),
    currChId: (((b8 & 0x3c) >> 2) << 4) + (b6 >> 4)
  }
}

export function parseSettings(b) {
  return {
    raw: Uint8Array.from(b),
    channelA: ((byte(b, 5) & 0xf0) >> 4) + (byte(b, 14) & 0xf0),
    channelB: (byte(b, 5) & 0x0f) + ((byte(b, 14) & 0x0f) << 4),
    scan: (byte(b, 6) & 0x80) !== 0,
    aghfpCallMode: (byte(b, 6) & 0x40) !== 0,
    doubleChannel: (byte(b, 6) & 0x30) >> 4,
    keepAghfpLink: (byte(b, 7) & 0x10) !== 0,
    localSpeaker: byte(b, 9) >> 6,
    btMicGain: (byte(b, 9) & 0x38) >> 3
  }
}

// Payload for writeSettings: the last settings frame minus its 5-byte header,
// with only the channel, scan and dual-watch fields replaced. Mirrors
// RadioSettings.toByteArray in HTCommander.
export function settingsPayload(raw, changes) {
  const cur = parseSettings(raw)
  const chA = changes.channelA !== undefined ? changes.channelA : cur.channelA
  const chB = changes.channelB !== undefined ? changes.channelB : cur.channelB
  const dc = changes.doubleChannel !== undefined ? changes.doubleChannel : cur.doubleChannel
  const scan = changes.scan !== undefined ? changes.scan : cur.scan
  const data = Uint8Array.from(raw.subarray(5))
  data[0] = ((chA & 0x0f) << 4) | (chB & 0x0f)
  // keep aghfp call mode and squelch; replace scan and double channel
  data[1] = (scan ? 0x80 : 0) | (data[1] & 0x40) | ((dc & 0x03) << 4) | (data[1] & 0x0f)
  if (data.length > 9) data[9] = (chA & 0xf0) | ((chB >> 4) & 0x0f)
  return data
}

// Channel names are GBK on the radio. ASCII covers what fits on the watch;
// anything else shows as '?'.
function decodeName(b, start, len) {
  let s = ''
  for (let i = start; i < start + len && i < b.length; i++) {
    const c = b[i]
    if (c === 0) break
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?'
  }
  return s.trim()
}

export function parseChannel(b) {
  return {
    id: byte(b, 5),
    txFreq: u32(b, 6) & 0x3fffffff,
    rxFreq: u32(b, 10) & 0x3fffffff,
    txDisable: (byte(b, 18) & 0x01) !== 0,
    name: decodeName(b, 20, 10)
  }
}

// GET_VOLUME reply: [status, level], level 0-15.
export function parseVolume(b) {
  return Math.min(byte(b, 5), VOLUME_MAX)
}

// The radio's own APRS callsign from a READ_BSS_SETTINGS reply (HTCommander
// RadioBssSettings.fromBytes: SSID in the high nibble of [7], callsign at
// [45..50]). null when the radio has none set.
export function parseBssCallsign(b) {
  const call = decodeName(b, 45, 6).toUpperCase()
  if (!/^[A-Z0-9]{3,6}$/.test(call)) return null
  return { call, ssid: byte(b, 7) >> 4 }
}

// A TNC data fragment, from a dataRxd event or an RX_DATA frame: a control
// byte at [5] (0x80 final, 0x40 channel id appended, 0x3f fragment id), the
// data, then the optional channel id byte.
export function parseTncFragment(b) {
  if (b.length < 6) return null
  const ctl = b[5]
  const withChannel = (ctl & 0x40) !== 0
  const end = withChannel ? b.length - 1 : b.length
  return {
    final: (ctl & 0x80) !== 0,
    fragmentId: ctl & 0x3f,
    data: Uint8Array.from(b.subarray(6, Math.max(6, end))),
    channelId: withChannel ? b[b.length - 1] : null
  }
}

// Joins TNC fragments into one AX.25 frame, as HTCommander does: a packet
// starts at fragment 0, each next fragment must be the previous id + 1, and
// anything out of order drops the partial packet.
export class PacketAssembler {
  constructor() {
    this.parts = null
    this.next = 0
  }

  push(frag) {
    if (frag.fragmentId === 0) {
      this.parts = [frag.data]
      this.next = 1
    } else if (this.parts && frag.fragmentId === this.next) {
      this.parts.push(frag.data)
      this.next++
    } else {
      this.parts = null
      return null
    }
    if (!frag.final) return null
    let len = 0
    for (const p of this.parts) len += p.length
    const out = new Uint8Array(len)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    this.parts = null
    return out
  }
}

export function formatFreq(hz) {
  if (!hz) return ''
  return (hz / 1000000).toFixed(3)
}

// Reassembles indications if the link MTU splits a reply. Every frame starts
// with 00 02 (basic) or 00 0a (extended); a chunk that does not is the tail of
// the previous one. A chunk shorter than a minimum-MTU payload (20 bytes)
// cannot have been split, so it completes the frame at once; longer ones wait
// for the next frame start or flush().
export class FrameAssembler {
  constructor() {
    this.pending = null
  }

  static isFrameStart(c) {
    return c.length >= 4 && c[0] === 0 && (c[1] === GROUP_BASIC || c[1] === GROUP_EXTENDED)
  }

  push(data) {
    const chunk = toBytes(data)
    const out = []
    if (FrameAssembler.isFrameStart(chunk)) {
      if (this.pending) out.push(this.pending)
      this.pending = Uint8Array.from(chunk)
    } else if (this.pending) {
      const joined = new Uint8Array(this.pending.length + chunk.length)
      joined.set(this.pending, 0)
      joined.set(chunk, this.pending.length)
      this.pending = joined
    } else {
      return out // stray tail, drop it
    }
    if (chunk.length < 20) {
      out.push(this.pending)
      this.pending = null
    }
    return out
  }

  flush() {
    const p = this.pending
    this.pending = null
    return p ? [p] : []
  }
}
