// Radio state and commands. Transport-agnostic: give it a send(bytes)
// function, call linkUp()/linkDown() as the BLE link changes and feed every
// received frame to handleFrame(). Timers are injectable so tests can drive it.
//
// Copyright 2026 Clint Wilson (KO4LTW). Licensed under the Apache License, Version 2.0
// (see LICENSE and NOTICE). The connect sequence, settings writes, channel
// reads, volume and packet handling follow HTCommander's radio.dart
// (https://github.com/Ylianst/HTCommander, by Ylianst, Apache-2.0),
// reimplemented in JavaScript with per-band stepping and a local settings
// copy added.

import {
  CMD, NOTIFY, PF, DUAL_OFF, VFO_A, VFO_B, VOLUME_MAX,
  buildCommand, parseFrame, parseDevInfo, parseHtStatus, parseSettings,
  parseChannel, settingsPayload, parseVolume, parseBssCallsign, parseTncFragment,
  PacketAssembler
} from './protocol.js'

const INIT_RETRY_MS = 2000
const INIT_MAX_TRIES = 8 // covers every link probe step
const CHANNEL_READ_TIMEOUT_MS = 1500
const STEP_COMMIT_MS = 300
const VOLUME_REPLY_TIMEOUT_MS = 1000

export class Radio {
  constructor(opts) {
    this.send = opts.send
    this.log = opts.log || (() => {})
    this.timers = {
      set: opts.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
      clear: opts.clearTimeout || ((t) => clearTimeout(t))
    }
    this.cache = opts.cache || null // { load() -> {}, save(obj) }
    this.listeners = []
    this.packetListeners = []
    this.channels = (this.cache && this.cache.load()) || {}
    this.resetLinkState()
  }

  resetLinkState() {
    this.connected = false
    this.info = null
    this.settings = null
    this.status = null
    this.pending = { A: null, B: null } // channel a swipe or the picker is moving to
    this.committed = { A: false, B: false } // pending channel has been written
    this.commitVfo = null
    this.writesInFlight = 0
    this.readQueue = []
    this.readInFlight = null
    this.initTries = 0
    this.volume = null // 0-15, null until the radio reports it
    this.volumeWanted = null // set while a local change is on its way
    this.volumeInFlight = false
    this.callsign = null // { call, ssid } from the radio's APRS settings
    this.packets = new PacketAssembler()
  }

  // Returns an unsubscribe function.
  onChange(fn) {
    this.listeners.push(fn)
    return () => (this.listeners = this.listeners.filter((f) => f !== fn))
  }

  emit() {
    for (const fn of this.listeners) fn(this)
  }

  // fn(ax25Bytes, channelId) for every packet the radio receives.
  onPacket(fn) {
    this.packetListeners.push(fn)
    return () => (this.packetListeners = this.packetListeners.filter((f) => f !== fn))
  }

  command(cmd, payload) {
    this.send(buildCommand(cmd, payload))
  }

  // ---- link lifecycle ----

  linkUp() {
    this.resetLinkState()
    this.connected = true
    this.requestDevInfo()
    this.emit()
  }

  linkDown() {
    this.clearAllTimers()
    this.resetLinkState()
    this.emit()
  }

  clearAllTimers() {
    for (const k of ['initTimer', 'readTimer', 'commitTimer', 'volumeTimer']) {
      if (this[k]) this.timers.clear(this[k])
      this[k] = null
    }
  }

  requestDevInfo() {
    this.command(CMD.getDevInfo, [3])
    this.initTimer = this.timers.set(() => {
      this.initTimer = null
      if (this.info || !this.connected) return
      if (++this.initTries < INIT_MAX_TRIES) this.requestDevInfo()
      else this.log('radio: no reply to getDevInfo')
    }, INIT_RETRY_MS)
  }

  // ---- incoming ----

  handleFrame(data) {
    const f = parseFrame(data)
    if (!f || f.group !== 2) return
    const b = f.bytes

    if (f.cmd === CMD.eventNotification) {
      this.handleEvent(f.status, b)
      return
    }
    if (f.cmd === CMD.rxData) {
      this.onFragment(b)
      return
    }
    if (!f.isReply) return

    switch (f.cmd) {
      case CMD.getDevInfo:
        if (f.status !== 0) return
        this.info = parseDevInfo(b)
        if (this.initTimer) this.timers.clear(this.initTimer)
        this.initTimer = null
        this.command(CMD.registerNotification, [NOTIFY.htStatusChanged])
        this.command(CMD.readSettings)
        this.command(CMD.getHtStatus)
        this.command(CMD.getVolume)
        this.command(CMD.readBssSettings)
        this.emit()
        break
      case CMD.readSettings:
        if (f.status !== 0) return
        this.applySettings(parseSettings(b))
        break
      case CMD.writeSettings:
        if (this.writesInFlight > 0) this.writesInFlight--
        if (f.status !== 0) {
          this.log('radio: writeSettings failed ' + f.status)
          this.pending = { A: null, B: null }
          this.committed = { A: false, B: false }
        }
        this.command(CMD.readSettings) // also replaces the local copy if the write failed
        this.emit()
        break
      case CMD.getVolume:
        if (f.status !== 0 || this.volumeWanted !== null) return
        this.volume = parseVolume(b)
        this.emit()
        break
      case CMD.setVolume:
        this.onVolumeReply(f.status === 0)
        break
      case CMD.readBssSettings:
        if (f.status !== 0) return
        this.callsign = parseBssCallsign(b)
        this.log('radio: callsign ' + (this.callsign ? this.callsign.call + '-' + this.callsign.ssid : 'none'))
        this.emit()
        break
      case CMD.getHtStatus:
        if (f.status !== 0) return
        this.applyStatus(parseHtStatus(b))
        break
      case CMD.readRfCh:
        this.onChannelReply(f.status === 0 ? parseChannel(b) : null)
        break
    }
  }

  handleEvent(type, b) {
    if (type === NOTIFY.htStatusChanged) this.applyStatus(parseHtStatus(b))
    else if (type === NOTIFY.htChChanged) this.command(CMD.readSettings)
    else if (type === NOTIFY.htSettingsChanged) this.applySettings(parseSettings(b))
    else if (type === NOTIFY.dataRxd) this.onFragment(b)
    else if (type === NOTIFY.bssSettingsChanged) this.command(CMD.readBssSettings)
  }

  // Settings read from the radio. A pending channel clears once the radio
  // shows it, or once every write is acknowledged and the radio still shows
  // something else (it ignored the change).
  applySettings(s) {
    const first = !this.settings
    this.settings = s
    for (const vfo of ['A', 'B']) {
      const p = this.pending[vfo]
      if (p === null) continue
      const actual = vfo === 'A' ? s.channelA : s.channelB
      const settled = this.committed[vfo] && this.writesInFlight === 0 && !this.commitTimer
      if (p === actual || settled) {
        this.pending[vfo] = null
        this.committed[vfo] = false
      }
    }
    if (first) this.queueAllChannels()
    else this.queueChannelIfUnknown(s.channelA, s.channelB)
    this.emit()
  }

  applyStatus(st) {
    const prev = this.status
    this.status = st
    if (st.isScan) this.queueChannelIfUnknown(st.currChId)
    if (prev && this.settings) {
      if (prev.currRegion !== st.currRegion) {
        // new region = new channel table
        this.channels = {}
        this.saveCache()
        this.queueAllChannels()
      }
      // While scanning the channel changes constantly; channelFor() follows
      // the status instead, so only re-read settings when scan starts/stops.
      const chMoved = prev.currChId !== st.currChId && !st.isScan
      if (chMoved || prev.doubleChannel !== st.doubleChannel || prev.isScan !== st.isScan) {
        this.command(CMD.readSettings)
      }
    }
    this.emit()
  }

  // ---- channel table ----

  queueAllChannels() {
    const n = (this.info && this.info.channelCount) || 0
    const first = this.settings ? [this.settings.channelA, this.settings.channelB] : []
    const order = first.concat(Array.from({ length: n }, (_, i) => i))
    this.readQueue = []
    for (const i of order) if (i < n && this.readQueue.indexOf(i) < 0) this.readQueue.push(i)
    this.pumpReads()
  }

  queueChannelIfUnknown(...ids) {
    for (const i of ids) {
      if (!this.channels[i] && this.readQueue.indexOf(i) < 0 && this.readInFlight !== i) {
        this.readQueue.unshift(i)
      }
    }
    this.pumpReads()
  }

  pumpReads() {
    if (this.readInFlight !== null || !this.readQueue.length || !this.connected) return
    const id = this.readQueue.shift()
    this.readInFlight = id
    this.command(CMD.readRfCh, [id])
    this.readTimer = this.timers.set(() => {
      this.readTimer = null
      this.log('radio: channel ' + id + ' read timed out')
      this.readInFlight = null
      this.pumpReads()
    }, CHANNEL_READ_TIMEOUT_MS)
  }

  onChannelReply(ch) {
    if (this.readTimer) this.timers.clear(this.readTimer)
    this.readTimer = null
    if (ch) {
      this.channels[ch.id] = { name: ch.name, rxFreq: ch.rxFreq, txDisable: ch.txDisable }
      if (!this.readQueue.length) this.saveCache()
    }
    this.readInFlight = null
    this.pumpReads()
    this.emit()
  }

  saveCache() {
    if (this.cache) this.cache.save(this.channels)
  }

  // ---- what the face shows ----

  // Model name from devInfo, else the name the radio advertises.
  get name() {
    return (this.info && this.info.name) || this.btName || 'Radio'
  }

  get dualWatch() {
    return !!this.settings && this.settings.doubleChannel !== DUAL_OFF
  }

  // 'A' or 'B'. Single-channel mode always operates VFO A.
  get activeVfo() {
    return this.settings && this.settings.doubleChannel === VFO_B ? 'B' : 'A'
  }

  get scanning() {
    if (this.status) return this.status.isScan
    return !!this.settings && this.settings.scan
  }

  channelFor(vfo) {
    if (!this.settings) return null
    // While scanning, the active VFO shows the channel the radio is on now.
    if (this.scanning && this.status && vfo === this.activeVfo) return this.status.currChId
    const p = this.pending[vfo]
    return p !== null ? p : vfo === 'A' ? this.settings.channelA : this.settings.channelB
  }

  channelInfo(id) {
    return id === null || id === undefined ? null : this.channels[id] || null
  }

  get transmitting() {
    return !!this.status && this.status.isInTx
  }

  get receiving() {
    return !!this.status && this.status.isSq && !this.status.isInTx
  }

  // ---- controls ----

  // Programmed channel ids, for the channel picker. Channels not read yet are
  // included; empty ones are not.
  channelList() {
    const n = (this.info && this.info.channelCount) || 0
    const out = []
    for (let i = 0; i < n; i++) {
      const info = this.channels[i]
      if (!info || info.rxFreq > 0) out.push(i)
    }
    return out
  }

  bandUsable(vfo) {
    return !!this.settings && !!this.info && (vfo === 'A' || this.dualWatch)
  }

  // Move a band by `delta` programmed channels (default: the active band).
  // Quick swipes just move the target; one writeSettings goes out once they
  // settle. During a scan this stops the scan instead.
  stepChannel(delta, vfo = this.activeVfo) {
    if (!delta || !this.bandUsable(vfo)) return false
    if (this.scanning) {
      this.stopScanHere()
      return true
    }
    const n = this.info.channelCount
    let id = this.channelFor(vfo)
    const dir = delta > 0 ? 1 : -1
    for (let moved = 0; moved < Math.abs(delta); moved++) {
      let next = id
      for (let tries = 0; tries < n; tries++) {
        next = (next + dir + n) % n
        const info = this.channels[next]
        if (!info || info.rxFreq > 0) break // unknown or programmed
      }
      id = next
    }
    this.pending[vfo] = id
    this.committed[vfo] = false
    this.scheduleCommit(vfo)
    this.emit()
    return true
  }

  // Jump a band straight to channel `id` (the channel picker). Stops a scan.
  setChannel(vfo, id) {
    if (!this.bandUsable(vfo) || id === null || id === undefined) return false
    const wasScanning = this.scanning
    if (wasScanning) this.toggleScan()
    this.flushCommit()
    this.pending[vfo] = id
    this.commitChannel(vfo, wasScanning ? { scan: false } : {})
    this.emit()
    return true
  }

  scheduleCommit(vfo) {
    // Another band waiting to commit goes out now rather than being lost.
    if (this.commitVfo !== vfo) this.flushCommit()
    if (this.commitTimer) this.timers.clear(this.commitTimer)
    this.commitVfo = vfo
    this.commitTimer = this.timers.set(() => {
      this.commitTimer = null
      this.commitVfo = null
      this.commitChannel(vfo)
    }, STEP_COMMIT_MS)
  }

  flushCommit() {
    if (!this.commitTimer) return
    this.timers.clear(this.commitTimer)
    this.commitTimer = null
    const vfo = this.commitVfo
    this.commitVfo = null
    this.commitChannel(vfo)
  }

  // The radio only commits the selected band's channel, so in dual watch the
  // band being changed is selected in the same write.
  commitChannel(vfo, extra) {
    const id = this.pending[vfo]
    if (id === null || !this.settings) return
    const changes = Object.assign({}, extra)
    if (vfo === 'A') changes.channelA = id
    else changes.channelB = id
    if (this.dualWatch) changes.doubleChannel = vfo === 'B' ? VFO_B : VFO_A
    this.committed[vfo] = true
    this.writeSettings(changes)
  }

  // Writes are built on the last settings read, so keep a local copy with
  // this change applied: a second write before the radio's reply then
  // doesn't undo the first. The next read replaces it.
  writeSettings(changes) {
    const raw = this.settings.raw
    const payload = settingsPayload(raw, changes)
    this.command(CMD.writeSettings, payload)
    this.writesInFlight++
    const next = new Uint8Array(5 + payload.length)
    next.set(raw.subarray(0, 5), 0)
    next.set(payload, 5)
    this.settings = parseSettings(next)
  }

  selectVfo(vfo) {
    if (!this.dualWatch) return false
    const want = vfo === 'B' ? VFO_B : VFO_A
    if (this.settings.doubleChannel === want) return true
    this.flushCommit()
    this.writeSettings({ doubleChannel: want })
    this.emit()
    return true
  }

  setDualWatch(on) {
    if (!this.settings) return
    this.flushCommit()
    this.writeSettings({ doubleChannel: on ? VFO_A : DUAL_OFF })
    this.emit()
  }

  toggleDualWatch() {
    this.setDualWatch(!this.dualWatch)
  }

  // Presses the radio's own scan button remotely (doProgFunc takes a 16-bit
  // effect code; [00 12] is the A/B button, [00 0c] is scan). Scans the
  // radio's scan list.
  toggleScan() {
    if (!this.connected) return
    this.command(CMD.doProgFunc, [0x00, PF.toggleChScan])
  }

  // Changing channel during a scan stops it, like pressing scan again.
  stopScanHere() {
    this.toggleScan()
  }

  // ---- volume ----

  stepVolume(delta) {
    if (this.volume === null || !this.connected) return false
    this.setVolume(this.volume + delta)
    return true
  }

  // Shows the new level at once. One SET_VOLUME is in flight at a time; a
  // fast crown turn sends the latest level when the previous one is acked.
  setVolume(level) {
    const v = Math.max(0, Math.min(VOLUME_MAX, Math.round(level)))
    if (v === this.volume && this.volumeWanted === null) return
    this.volume = v
    this.volumeWanted = v
    if (!this.volumeInFlight) this.sendVolume()
    this.emit()
  }

  sendVolume() {
    this.volumeInFlight = true
    this.volumeSent = this.volumeWanted
    this.command(CMD.setVolume, [this.volumeSent])
    if (this.volumeTimer) this.timers.clear(this.volumeTimer)
    this.volumeTimer = this.timers.set(() => {
      this.volumeTimer = null
      this.log('radio: no reply to setVolume')
      this.onVolumeReply(false)
    }, VOLUME_REPLY_TIMEOUT_MS)
  }

  onVolumeReply(ok) {
    if (this.volumeTimer) this.timers.clear(this.volumeTimer)
    this.volumeTimer = null
    this.volumeInFlight = false
    if (!ok) {
      this.volumeWanted = null
      this.command(CMD.getVolume)
      return
    }
    if (this.volumeWanted !== null && this.volumeWanted !== this.volumeSent) this.sendVolume()
    else this.volumeWanted = null
  }

  // Keepalive: status, plus the volume in case it was changed on the radio.
  poll() {
    if (!this.connected) return
    this.command(CMD.getHtStatus)
    if (this.volumeWanted === null) this.command(CMD.getVolume)
  }

  // ---- packets ----

  onFragment(b) {
    const frag = parseTncFragment(b)
    if (!frag) return
    const pkt = this.packets.push(frag)
    if (!pkt) return
    for (const fn of this.packetListeners) fn(pkt, frag.channelId)
  }

  shutdown() {
    this.clearAllTimers()
  }
}
