// node --test test/
// Byte layouts follow HTCommander's radio_models.dart; every frame is the
// full BLE frame (4-byte command header + status/type byte + data).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CMD, NOTIFY, PF, buildCommand, parseFrame, parseHtStatus, parseSettings, parseChannel,
  parseDevInfo, settingsPayload, formatFreq, FrameAssembler, parseBssCallsign
} from '../lib/protocol.js'
import { Radio } from '../lib/radio.js'
import { parseAx25, parseAprsMessage, isForMe, formatCall } from '../lib/aprs.js'
import { Inbox } from '../lib/inbox.js'
import { readFileSync } from 'node:fs'
import { aboutPages, APP_VERSION } from '../lib/credits.js'

const reply = (cmd, data) => Uint8Array.from([0x00, 0x02, 0x80, cmd, 0x00, ...data])
const event = (type, data) => Uint8Array.from([0x00, 0x02, 0x00, CMD.eventNotification, type, ...data])
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

// 20 settings bytes after the header: chA=18, chB=5, aghfp call mode,
// dual watch on with A selected, squelch 3.
function settingsData({ chA = 18, chB = 5, dc = 1 } = {}) {
  const d = new Array(20).fill(0)
  d[0] = ((chA & 0x0f) << 4) | (chB & 0x0f)
  d[1] = 0x40 | (dc << 4) | 0x03
  d[2] = 0x10 // keep aghfp link
  d[9] = (chA & 0xf0) | ((chB >> 4) & 0x0f)
  return d
}

function channelData(id, rxHz, name) {
  const nameBytes = [...name].map((c) => c.charCodeAt(0))
  while (nameBytes.length < 10) nameBytes.push(0)
  return [id, ...be32(rxHz), ...be32(rxHz), 0, 0, 0, 0, 0x40, 0x00, ...nameBytes]
}

function devInfoData(channelCount) {
  // vendor, product 0x0002, hw, sw(2), feature bytes 11-12, channel count
  return [0x01, 0x00, 0x02, 0x01, 0x00, 0x5a, 0x00, 0x12, channelCount, 0x00]
}

test('buildCommand uses BLE framing with a trailing zero when empty', () => {
  assert.deepEqual([...buildCommand(CMD.getDevInfo, [3])], [0x00, 0x02, 0x00, 0x04, 0x03])
  assert.deepEqual([...buildCommand(CMD.readSettings)], [0x00, 0x02, 0x00, 0x0a, 0x00])
  assert.deepEqual([...buildCommand(CMD.doProgFunc, [PF.mainPtt])], [0x00, 0x02, 0x00, 0x42, 0x0d])
})

test('parseFrame splits reply bit, command and status', () => {
  const f = parseFrame(reply(CMD.getHtStatus, [0x80]))
  assert.equal(f.group, 2)
  assert.equal(f.cmd, CMD.getHtStatus)
  assert.equal(f.isReply, true)
  assert.equal(f.status, 0)
})

test('parseDevInfo names the VR-N76 and reads the channel count', () => {
  const info = parseDevInfo(reply(CMD.getDevInfo, devInfoData(32)))
  assert.equal(info.name, 'VR-N76')
  assert.equal(info.channelCount, 32)
})

test('parseHtStatus decodes TX, dual watch, HFP, channel, region and RSSI', () => {
  // power+TX, doubleChannel=2; channel 0x23; region 5; rssi 9; HFP linked
  const st = parseHtStatus(reply(CMD.getHtStatus, [0xc8, 0x34, 0x91, 0x48]))
  assert.equal(st.isPowerOn, true)
  assert.equal(st.isInTx, true)
  assert.equal(st.doubleChannel, 2)
  assert.equal(st.isHfpConnected, true)
  assert.equal(st.currChId, 0x23)
  assert.equal(st.currRegion, 5)
  assert.equal(st.rssi, 9)
})

test('parseSettings reads split channel numbers and dual watch', () => {
  const s = parseSettings(reply(CMD.readSettings, settingsData()))
  assert.equal(s.channelA, 18)
  assert.equal(s.channelB, 5)
  assert.equal(s.doubleChannel, 1)
  assert.equal(s.aghfpCallMode, true)
  assert.equal(s.keepAghfpLink, true)
})

test('settingsPayload changes only channel/dual-watch bits and round-trips', () => {
  const raw = reply(CMD.readSettings, settingsData())
  const payload = settingsPayload(raw, { channelB: 33, doubleChannel: 2 })
  assert.equal(payload.length, raw.length - 5)
  const back = parseSettings(Uint8Array.from([0, 2, 0x80, 0x0a, 0, ...payload]))
  assert.equal(back.channelA, 18)
  assert.equal(back.channelB, 33)
  assert.equal(back.doubleChannel, 2)
  assert.equal(back.aghfpCallMode, true) // preserved
  assert.equal(payload[1] & 0x0f, 3) // squelch preserved
  assert.equal(payload[2], 0x10) // untouched byte preserved
})

test('parseChannel reads frequency and name', () => {
  const ch = parseChannel(reply(CMD.readRfCh, channelData(7, 146520000, 'SIMPLEX')))
  assert.equal(ch.id, 7)
  assert.equal(ch.rxFreq, 146520000)
  assert.equal(ch.name, 'SIMPLEX')
  assert.equal(formatFreq(ch.rxFreq), '146.520')
})

test('FrameAssembler joins an MTU-split reply and passes short frames through', () => {
  const full = reply(CMD.readRfCh, channelData(1, 446000000, 'GMRS1'))
  const a = new FrameAssembler()
  assert.deepEqual(a.push(full.subarray(0, 20)), [])
  const out = a.push(full.subarray(20))
  assert.equal(out.length, 1)
  assert.deepEqual([...out[0]], [...full])
  assert.equal(a.push(reply(CMD.getHtStatus, [0x80, 0, 0, 0])).length, 1)
})

// ---- Radio flow with a fake link and manual timers ----

function harness(opts = {}) {
  const sent = []
  const timers = []
  const radio = new Radio({
    send: (b) => sent.push([...b]),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, done: false }
      timers.push(t)
      return t
    },
    clearTimeout: (t) => { if (t) t.done = true },
    ...opts
  })
  const runTimers = (ms) => {
    for (const t of timers.slice()) if (!t.done && t.ms <= ms) { t.done = true; t.fn() }
  }
  const cmds = () => sent.map((b) => b[3])
  return { radio, sent, cmds, runTimers }
}

function connect(h, { channels = 4, settings = {} } = {}) {
  h.radio.linkUp()
  h.radio.handleFrame(reply(CMD.getDevInfo, devInfoData(channels)))
  h.radio.handleFrame(reply(CMD.readSettings, settingsData(settings)))
}

test('connect sequence: devInfo, register, settings, status, volume, callsign, then channel reads', () => {
  const h = harness()
  connect(h, { settings: { chA: 2, chB: 0 } })
  const c = h.cmds()
  assert.deepEqual(c.slice(0, 6), [
    CMD.getDevInfo, CMD.registerNotification, CMD.readSettings, CMD.getHtStatus,
    CMD.getVolume, CMD.readBssSettings
  ])
  // first channel read is VFO A's channel
  assert.equal(c[6], CMD.readRfCh)
  assert.equal(h.sent[6][4], 2)
})

test('channel reads are serialized and fill the table', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1 } })
  for (let i = 0; i < 4; i++) {
    const last = h.sent[h.sent.length - 1]
    assert.equal(last[3], CMD.readRfCh)
    h.radio.handleFrame(reply(CMD.readRfCh, channelData(last[4], 146000000 + last[4] * 25000, 'CH' + last[4])))
  }
  assert.equal(Object.keys(h.radio.channels).length, 4)
  assert.equal(h.radio.channelInfo(3).name, 'CH3')
})

test('crown steps skip unprogrammed channels and commit one write', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  const freqs = [146520000, 0, 147000000, 446000000]
  for (let i = 0; i < 4; i++) {
    const last = h.sent[h.sent.length - 1]
    h.radio.handleFrame(reply(CMD.readRfCh, channelData(last[4], freqs[last[4]], 'X')))
  }
  h.radio.stepChannel(1) // 0 -> 2 (1 is empty)
  h.radio.stepChannel(1) // 2 -> 3
  assert.equal(h.radio.channelFor('A'), 3)
  const before = h.sent.length
  h.runTimers(300)
  assert.equal(h.sent.length, before + 1)
  const write = h.sent[h.sent.length - 1]
  assert.equal(write[3], CMD.writeSettings)
  const s = parseSettings(Uint8Array.from([0, 2, 0x80, 0x0a, 0, ...write.slice(4)]))
  assert.equal(s.channelA, 3)
  assert.equal(s.channelB, 1)
})

test('stepping VFO B in dual watch keeps B selected', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 2 } })
  h.radio.stepChannel(1)
  h.runTimers(300)
  const write = h.sent[h.sent.length - 1]
  const s = parseSettings(Uint8Array.from([0, 2, 0x80, 0x0a, 0, ...write.slice(4)]))
  assert.equal(s.channelB, 2)
  assert.equal(s.doubleChannel, 2)
})

test('selectVfo only works in dual watch', () => {
  const h = harness()
  connect(h, { settings: { dc: 0 } })
  assert.equal(h.radio.selectVfo('B'), false)
  const h2 = harness()
  connect(h2, { settings: { dc: 1 } })
  assert.equal(h2.radio.selectVfo('B'), true)
  const write = h2.sent[h2.sent.length - 1]
  assert.equal(write[3], CMD.writeSettings)
  assert.equal((write[5] & 0x30) >> 4, 2)
})

test('model 259 is a VR-N76; unknown models fall back to the Bluetooth name', () => {
  const d = devInfoData(32)
  d[1] = 0x01; d[2] = 0x03 // product 0x0103
  assert.equal(parseDevInfo(reply(CMD.getDevInfo, d)).name, 'VR-N76')
  d[2] = 0x09
  const h = harness()
  h.radio.btName = 'VR-N76'
  h.radio.linkUp()
  h.radio.handleFrame(reply(CMD.getDevInfo, d))
  assert.equal(h.radio.name, 'VR-N76')
})

test('status notification with a new channel re-reads settings', () => {
  const h = harness()
  connect(h)
  h.radio.handleFrame(event(1, [0x84, 0x10, 0x00, 0x00]))
  const before = h.sent.length
  h.radio.handleFrame(event(1, [0x84, 0x20, 0x00, 0x00]))
  assert.ok(h.sent.slice(before).some((b) => b[3] === CMD.readSettings))
})

test('link down clears radio state', () => {
  const h = harness()
  connect(h)
  h.radio.linkDown()
  assert.equal(h.radio.connected, false)
  assert.equal(h.radio.settings, null)
})

test('settingsPayload sets and clears the scan bit, keeping the rest', () => {
  const raw = reply(CMD.readSettings, settingsData())
  const on = settingsPayload(raw, { scan: true })
  assert.equal(on[1] & 0x80, 0x80)
  const back = parseSettings(Uint8Array.from([0, 2, 0x80, 0x0a, 0, ...on]))
  assert.equal(back.scan, true)
  assert.equal(back.aghfpCallMode, true)
  assert.equal(back.doubleChannel, 1)
  assert.equal(back.channelA, 18)
  const off = settingsPayload(Uint8Array.from([0, 2, 0x80, 0x0a, 0, ...on]), { scan: false })
  assert.equal(off[1] & 0x80, 0)
})

test('crown press sends the radio scan button', () => {
  const h = harness()
  connect(h)
  h.radio.toggleScan()
  const last = h.sent[h.sent.length - 1]
  assert.deepEqual(last.slice(3), [CMD.doProgFunc, 0x00, 0x0c])
})

test('while scanning, the active VFO follows the radio and a crown turn stops the scan', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  // status: power on, scanning, dual A selected, current channel 3
  h.radio.handleFrame(event(1, [0x80 | 0x04 | 0x02, 0x30, 0x00, 0x00]))
  assert.equal(h.radio.scanning, true)
  assert.equal(h.radio.channelFor('A'), 3)
  assert.equal(h.radio.channelFor('B'), 1)
  h.radio.stepChannel(1)
  const last = h.sent[h.sent.length - 1]
  assert.deepEqual(last.slice(3), [CMD.doProgFunc, 0x00, 0x0c])
})

// ---- swipes and the channel picker ----

const writes = (h) => h.sent.filter((b) => b[3] === CMD.writeSettings)
const written = (b) => parseSettings(Uint8Array.from([0, 2, 0x80, 0x0a, 0, ...b.slice(4)]))

function loadChannels(h, freqs) {
  for (let i = 0; i < freqs.length; i++) {
    const last = h.sent[h.sent.length - 1]
    h.radio.handleFrame(reply(CMD.readRfCh, channelData(last[4], freqs[last[4]], 'C' + last[4])))
  }
}

test('swiping band B while A is selected selects B and changes only B', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  assert.equal(h.radio.stepChannel(1, 'B'), true)
  assert.equal(h.radio.channelFor('B'), 2)
  h.runTimers(300)
  const s = written(writes(h).pop())
  assert.equal(s.channelA, 0)
  assert.equal(s.channelB, 2)
  assert.equal(s.doubleChannel, 2)
})

test('swiping band A while B is selected selects A', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 2 } })
  h.radio.stepChannel(-1, 'A')
  h.runTimers(300)
  const s = written(writes(h).pop())
  assert.equal(s.channelA, 3)
  assert.equal(s.doubleChannel, 1)
})

test('band B ignores swipes and picks while dual watch is off', () => {
  const h = harness()
  connect(h, { settings: { dc: 0 } })
  assert.equal(h.radio.stepChannel(1, 'B'), false)
  assert.equal(h.radio.setChannel('B', 2), false)
  assert.equal(writes(h).length, 0)
})

test('swiping A then B quickly writes both, the second keeping A', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  h.radio.stepChannel(1, 'A') // 0 -> 1
  h.radio.stepChannel(1, 'B') // 1 -> 2, commits A first
  h.runTimers(300)
  const [first, second] = writes(h).map(written)
  assert.equal(first.channelA, 1)
  assert.equal(first.doubleChannel, 1)
  assert.equal(second.channelA, 1)
  assert.equal(second.channelB, 2)
  assert.equal(second.doubleChannel, 2)
})

test('setChannel writes at once and channelList skips empty channels', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  loadChannels(h, [146520000, 0, 147000000, 446000000])
  assert.deepEqual(h.radio.channelList(), [0, 2, 3])
  h.radio.setChannel('A', 3)
  assert.equal(h.radio.channelFor('A'), 3)
  assert.equal(written(writes(h).pop()).channelA, 3)
})

test('picking a channel during a scan stops the scan and clears the scan bit', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  h.radio.handleFrame(event(1, [0x80 | 0x04 | 0x02, 0x30, 0x00, 0x00]))
  h.radio.setChannel('A', 2)
  assert.ok(h.sent.some((b) => b[3] === CMD.doProgFunc))
  const s = written(writes(h).pop())
  assert.equal(s.channelA, 2)
  assert.equal(s.scan, false)
})

test('a pending channel clears once the write is acked and settings re-read', () => {
  const h = harness()
  connect(h, { settings: { chA: 0, chB: 1, dc: 1 } })
  h.radio.setChannel('A', 2)
  assert.equal(h.radio.pending.A, 2)
  h.radio.handleFrame(reply(CMD.writeSettings, []))
  // the radio ignored it and still reports channel 0
  h.radio.handleFrame(reply(CMD.readSettings, settingsData({ chA: 0, chB: 1, dc: 1 })))
  assert.equal(h.radio.pending.A, null)
  assert.equal(h.radio.channelFor('A'), 0)
})

// ---- volume ----

test('volume is read on connect and the crown steps it one write at a time', () => {
  const h = harness()
  connect(h)
  assert.equal(h.radio.volume, null)
  assert.equal(h.radio.stepVolume(1), false)
  h.radio.handleFrame(reply(CMD.getVolume, [7]))
  assert.equal(h.radio.volume, 7)
  h.radio.stepVolume(1)
  h.radio.stepVolume(1)
  h.radio.stepVolume(1)
  assert.equal(h.radio.volume, 10)
  const sets = () => h.sent.filter((b) => b[3] === CMD.setVolume).map((b) => b[4])
  assert.deepEqual(sets(), [8]) // first one in flight
  h.radio.handleFrame(reply(CMD.getVolume, [7])) // stale poll reply is ignored
  assert.equal(h.radio.volume, 10)
  h.radio.handleFrame(reply(CMD.setVolume, []))
  assert.deepEqual(sets(), [8, 10]) // then the latest level
  h.radio.handleFrame(reply(CMD.setVolume, []))
  assert.equal(h.radio.volumeWanted, null)
})

test('volume clamps to 0-15 and a failed write re-reads it', () => {
  const h = harness()
  connect(h)
  h.radio.handleFrame(reply(CMD.getVolume, [15]))
  h.radio.stepVolume(1)
  assert.equal(h.sent.filter((b) => b[3] === CMD.setVolume).length, 0)
  h.radio.stepVolume(-20)
  assert.equal(h.radio.volume, 0)
  const before = h.sent.length
  h.radio.handleFrame(Uint8Array.from([0x00, 0x02, 0x80, CMD.setVolume, 0x05]))
  assert.equal(h.sent[before][3], CMD.getVolume)
})

// ---- APRS ----

function ax25Addr(call, ssid, last) {
  const c = call.padEnd(6, ' ')
  return [...c].map((ch) => ch.charCodeAt(0) << 1).concat([0x60 | (ssid << 1) | (last ? 1 : 0)])
}

function aprsFrame(src, dst, info, path = []) {
  const parse = (s) => {
    const [c, n] = s.split('-')
    return [c, Number(n || 0)]
  }
  const addrs = [dst, src, ...path]
  const bytes = []
  addrs.forEach((a, i) => bytes.push(...ax25Addr(...parse(a), i === addrs.length - 1)))
  bytes.push(0x03, 0xf0, ...[...info].map((c) => c.charCodeAt(0)))
  return Uint8Array.from(bytes)
}

test('parseAx25 reads addresses, path and info of a UI frame', () => {
  const ax = parseAx25(aprsFrame('W1ABC-7', 'APRS', ':N0CALL   :hi{1', ['WIDE1-1']))
  assert.equal(formatCall(ax.src), 'W1ABC-7')
  assert.equal(formatCall(ax.dst), 'APRS')
  assert.equal(formatCall(ax.path[0]), 'WIDE1-1')
  assert.equal(ax.info, ':N0CALL   :hi{1')
  const notUi = aprsFrame('W1ABC', 'APRS', 'x')
  notUi[14] = 0x3f // SABM
  assert.equal(parseAx25(notUi), null)
})

test('parseAprsMessage strips the message id and skips acks and telemetry', () => {
  assert.deepEqual(parseAprsMessage('W1ABC-7', ':N0CALL-9 :Meet at the repeater{42'), {
    from: 'W1ABC-7', to: 'N0CALL-9', text: 'Meet at the repeater', msgId: '42'
  })
  assert.equal(parseAprsMessage('W1ABC', ':N0CALL   :Reply-ack{AB}CD').msgId, 'AB')
  assert.equal(parseAprsMessage('W1ABC', ':N0CALL   :ack42'), null)
  assert.equal(parseAprsMessage('W1ABC', ':W1ABC    :PARM.Volts,Temp'), null)
  assert.equal(parseAprsMessage('W1ABC', '!4903.50N/07201.75W-'), null)
})

test('parseAprsMessage unwraps third-party traffic from an igate', () => {
  const m = parseAprsMessage('IGATE-10', '}KD9XYZ>APRS,TCPIP,IGATE-10*::N0CALL   :From the net{7')
  assert.equal(m.from, 'KD9XYZ')
  assert.equal(m.to, 'N0CALL')
  assert.equal(m.text, 'From the net')
})

test('isForMe matches the base callsign, or everything but bulletins when unknown', () => {
  const m = { to: 'N0CALL-9' }
  assert.equal(isForMe(m, 'N0CALL-7'), true)
  assert.equal(isForMe(m, 'W1ABC'), false)
  assert.equal(isForMe(m, null), true)
  assert.equal(isForMe({ to: 'BLN1' }, null), false)
})

test('TNC fragments from dataRxd events reassemble into one packet', () => {
  const h = harness()
  connect(h)
  const got = []
  h.radio.onPacket((p, ch) => got.push({ p: [...p], ch }))
  const frame = aprsFrame('W1ABC', 'APRS', ':N0CALL   :hello{1')
  const a = [...frame.subarray(0, 20)]
  const b = [...frame.subarray(20)]
  h.radio.handleFrame(event(NOTIFY.dataRxd, [0x00, ...a]))
  assert.equal(got.length, 0)
  h.radio.handleFrame(event(NOTIFY.dataRxd, [0x80 | 0x40 | 0x01, ...b, 5]))
  assert.equal(got.length, 1)
  assert.deepEqual(got[0].p, [...frame])
  assert.equal(got[0].ch, 5)
  // an out-of-order fragment drops the partial packet
  h.radio.handleFrame(event(NOTIFY.dataRxd, [0x00, ...a]))
  h.radio.handleFrame(event(NOTIFY.dataRxd, [0x80 | 0x02, ...b]))
  assert.equal(got.length, 1)
  // RX_DATA frames carry the same fragments
  h.radio.handleFrame(Uint8Array.from([0x00, 0x02, 0x00, CMD.rxData, 0x00, 0x80, ...frame]))
  assert.equal(got.length, 2)
})

test('parseBssCallsign reads the radio callsign and SSID', () => {
  const d = new Array(46).fill(0)
  d[2] = 7 << 4
  ;[...'N0CALL'].forEach((c, i) => (d[40 + i] = c.charCodeAt(0)))
  assert.deepEqual(parseBssCallsign(reply(CMD.readBssSettings, d)), { call: 'N0CALL', ssid: 7 })
  assert.equal(parseBssCallsign(reply(CMD.readBssSettings, new Array(46).fill(0))), null)
})

test('inbox drops repeats of the same message and keeps unread counts', () => {
  let saved = null
  const inbox = new Inbox({ load: () => [], save: (items) => (saved = items) })
  const added = []
  inbox.onChange((m) => m && added.push(m))
  const msg = { from: 'W1ABC', to: 'N0CALL', text: 'hi', msgId: '1' }
  assert.ok(inbox.add(msg, 1000))
  assert.equal(inbox.add(msg, 60000), null) // sender retrying
  assert.ok(inbox.add({ ...msg, msgId: '2' }, 61000))
  assert.ok(inbox.add(msg, 1000 + 3 * 3600 * 1000)) // long after: a new message
  assert.equal(added.length, 3)
  assert.equal(inbox.unread, 3)
  inbox.markRead(inbox.items[0].id)
  assert.equal(inbox.unread, 2)
  assert.equal(saved.length, 3)
  const reloaded = new Inbox({ load: () => saved, save: () => {} })
  assert.equal(reloaded.add({ ...msg, msgId: '9' }).id, 4)
})

// ---- credits ----

test('About pages credit every NOTICE entry and the version matches app.json', () => {
  const notice = readFileSync(new URL('../NOTICE', import.meta.url), 'utf8')
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
  const text = aboutPages().map((p) => p.title + ' ' + p.body.join(' ')).join(' ')
  for (const name of ['HTCommander', 'Ylianst', 'benlink', 'Kyle Husmann', 'easy-ble', 'Apache']) {
    assert.ok(text.includes(name), 'About is missing ' + name)
  }
  for (const name of ['HTCommander', 'Ylianst', 'benlink', 'Kyle Husmann', 'easy-ble', 'MIT License']) {
    assert.ok(notice.includes(name), 'NOTICE is missing ' + name)
  }
  assert.equal(APP_VERSION, app.app.version.name)
  assert.ok(aboutPages().every((p) => p.body.join('\n\n').length < 260), 'a page is too long for the screen')
})
