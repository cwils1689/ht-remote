// BLE link to the radio: scan (or reuse the remembered MAC), connect, build
// the GATT profile, enable indications, and pass frames both ways.
// Built on @silver-zepp/easy-ble, which wraps @zos/ble's mst* calls.

import { BLEMaster } from '@silver-zepp/easy-ble'
import {
  SERVICE_UUID, WRITE_UUID, INDICATE_UUID, CCCD_UUID, RADIO_NAME_KEYWORDS, FrameAssembler
} from './protocol.js'

const SCAN_MS = 15000
const RETRY_MS = 4000
const FLUSH_MS = 40
const PROBE_STEP_MS = 2500

// If the radio stays silent after the link comes up, try the next way of
// talking to it. HTCommander uses write-without-response whenever the
// characteristic allows it, and some firmware wants the notify bit rather
// than the indicate bit.
const PROBE_STEPS = [
  { cccd: '0200', noResp: false, label: 'indicate + write' },
  { cccd: '0100', noResp: false, label: 'notify + write' },
  { cccd: '0300', noResp: true, label: 'notify/indicate + write-no-response' }
]

// 'idle' | 'scanning' | 'connecting' | 'up' | 'retrying'
export class RadioLink {
  constructor(opts) {
    this.onFrame = opts.onFrame
    this.onUp = opts.onUp
    this.onDown = opts.onDown
    this.onState = opts.onState || (() => {})
    this.onScanResult = opts.onScanResult || (() => {})
    this.log = opts.log || (() => {})
    this.mac = opts.mac || null
    this.ble = new BLEMaster()
    this.assembler = new FrameAssembler()
    this.state = 'idle'
    this.stopped = true
    this.gotData = false
    this.resetStats()
  }

  resetStats() {
    this.stats = { tx: 0, txOk: 0, txErr: 0, rx: 0, cccd: '-', probe: '-' }
    this.writeNoResp = false
  }

  setState(s) {
    this.state = s
    this.onState(s)
  }

  // Always scan first, even with a remembered MAC: easy-ble notes that a
  // direct connect without a scan can latch the watch's BLE backend.
  start() {
    this.stopped = false
    this.scan()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    try {
      this.ble.quit()
    } catch (e) {
      this.log('link: quit failed ' + e)
    }
    this.setState('idle')
  }

  clearTimers() {
    for (const k of ['retryTimer', 'flushTimer', 'probeTimer']) {
      if (this[k]) clearTimeout(this[k])
      this[k] = null
    }
  }

  // Forget the remembered radio and look for one by name.
  rescan() {
    this.mac = null
    this.stop()
    this.start()
  }

  static isRadioName(name) {
    const up = (name || '').toUpperCase()
    return RADIO_NAME_KEYWORDS.some((k) => up.indexOf(k) >= 0)
  }

  scan() {
    this.setState('scanning')
    let found = false
    this.ble.startScan(
      (dev) => {
        this.onScanResult(dev)
        if (found) return
        const match = this.mac ? dev.dev_addr === this.mac : RadioLink.isRadioName(dev.dev_name)
        if (!match) return
        found = true
        this.devName = dev.dev_name
        this.log('link: found ' + dev.dev_name + ' ' + dev.dev_addr)
        this.ble.stopScan()
        this.connect(dev.dev_addr)
      },
      {
        duration: SCAN_MS,
        on_duration: () => {
          if (!found) this.retry('no radio found')
        }
      }
    )
  }

  connect(mac) {
    this.mac = mac
    this.setState('connecting')
    this.ble.connect(mac, (res) => {
      if (this.stopped) return
      if (res.connected) {
        this.buildProfile()
      } else {
        this.retry(res.status) // reports the drop if the link was up
      }
    })
  }

  buildProfile() {
    const services = {}
    services[SERVICE_UUID] = {}
    services[SERVICE_UUID][WRITE_UUID] = []
    services[SERVICE_UUID][INDICATE_UUID] = [CCCD_UUID]
    const profile = this.ble.generateProfileObject(services)
    if (!profile) {
      this.retry('profile generation failed')
      return
    }
    this.ble.startListener(profile, (resp) => {
      if (this.stopped) return
      if (!resp.success) {
        this.retry('profile: ' + resp.message)
        return
      }
      this.log('link: profile ready')
      this.resetStats()
      this.ble.on.charaNotification((uuid, data) => this.receive(data))
      this.ble.on.charaWriteComplete((uuid, status) => {
        if (status === 0) this.stats.txOk++
        else {
          this.stats.txErr++
          if (this.stats.txErr <= 3) this.log('link: write failed, status ' + status)
        }
        this.onState(this.state)
      })
      this.ble.on.descWriteComplete((chara, desc, status) => {
        this.stats.cccd = status === 0 ? 'ok' : 'err' + status
        this.log('link: CCCD write status ' + status)
        this.onState(this.state)
      })
      this.lastRx = Date.now()
      this.probe(0)
      this.setState('up')
      this.onUp(this.mac)
    })
  }

  probe(i) {
    const step = PROBE_STEPS[i]
    this.gotData = false
    this.writeNoResp = step.noResp
    this.stats.probe = String(i + 1) + '/' + PROBE_STEPS.length
    this.log('link: probe ' + (i + 1) + ' ' + step.label)
    this.ble.write.descriptor(INDICATE_UUID, CCCD_UUID, step.cccd)
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.gotData || this.state !== 'up') return
      if (i + 1 < PROBE_STEPS.length) this.probe(i + 1)
      else this.log('link: radio silent in every mode')
    }, PROBE_STEP_MS)
  }

  receive(data) {
    this.lastRx = Date.now()
    if (!this.gotData) this.log('link: first data in probe ' + this.stats.probe)
    this.gotData = true
    this.stats.rx++
    for (const f of this.assembler.push(data)) this.onFrame(f)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      for (const f of this.assembler.flush()) this.onFrame(f)
    }, FLUSH_MS)
  }

  // Called periodically by the session. A radio that was switched off or
  // walked out of range doesn't always produce a disconnect callback, so a
  // link that has been silent too long is torn down and re-scanned.
  checkAlive(maxSilentMs) {
    if (this.state !== 'up' || !this.lastRx) return
    if (Date.now() - this.lastRx > maxSilentMs) this.retry('radio silent for ' + Math.round(maxSilentMs / 1000) + ' s')
  }

  send(bytes) {
    if (this.state !== 'up') return false
    this.stats.tx++
    this.ble.write.characteristic(WRITE_UUID, bytes, this.writeNoResp)
    return true
  }

  retry(reason) {
    this.log('link: ' + reason + ', retrying')
    if (this.stopped) return
    if (this.state === 'up') this.onDown()
    this.clearTimers()
    try {
      this.ble.quit()
    } catch (e) {}
    this.ble = new BLEMaster()
    this.setState('retrying')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.start()
    }, RETRY_MS)
  }
}
