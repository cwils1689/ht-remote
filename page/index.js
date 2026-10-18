// Main face: band A on top, band B below, a ring that turns red on TX and
// green while the squelch is open, and a messages pill along the bottom.
//   crown turn             volume (shown in a pop-up while adjusting)
//   crown press            scan on/off
//   swipe left/right       next/previous channel on the band you swipe
//   tap a band             select it (dual watch only)
//   double-tap a band      channel list for that band
//   long-press a band      dual watch on/off
//   lower button           leave the app (sideways swipes never do)
//   tap MSG                received APRS messages
//   tap the status line    credits and licenses
// In the channel and message lists dragging or the crown scrolls, a crown
// press or tap picks, and swiping right goes back.

import { createWidget, widget, prop, align, text_style, event } from '@zos/ui'
import {
  onKey, offKey, onDigitalCrown, offDigitalCrown, onGesture, offGesture, KEY_EVENT_CLICK,
  GESTURE_UP, GESTURE_DOWN, GESTURE_LEFT, GESTURE_RIGHT
} from '@zos/interaction'
import { setPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { Vibrator } from '@zos/sensor'
import { acquire, release } from '../lib/session.js'
import { formatFreq } from '../lib/protocol.js'
import { Wheel, WHEEL_PAGE } from './ui/wheel.js'
import { VolumeHud, MessageBanner, MessageView, AboutView, clockTime } from './ui/overlays.js'

const COLOR = {
  bg: 0x000000,
  rowActive: 0x1d4ed8,
  rowIdle: 0x1c1c1e,
  rowOff: 0x0b0b0c,
  card: 0x2c2c2e,
  text: 0xffffff,
  textDim: 0x8e8e93,
  textOff: 0x48484a,
  pending: 0xffd60a,
  accent: 0xff9f0a,
  tx: 0xff3b30,
  rx: 0x30d158,
  status: 0xaeaeb2
}

// Key codes the Balance 2 actually sends (measured on hardware): crown
// rotation is a CLICK on 40 (clockwise) or 38 (counter-clockwise), and a
// crown press is 13 (PRESS, RELEASE, then CLICK).
const KEY_CROWN_CW = 40
const KEY_CROWN_CCW = 38
const KEY_CROWN_PRESS = 13

// Crown degrees per step (onDigitalCrown only). The callback reports larger
// values for faster turns, so accumulate and step once per threshold.
const CROWN_STEP_DEG = 12
const LONG_PRESS_MS = 700
const DOUBLE_TAP_MS = 400
const SWIPE_PX = 50 // horizontal travel that makes a touch a swipe
const TAP_SLOP_PX = 24 // more travel than this and it isn't a tap
const SWIPE_GRACE_MS = 800 // a swipe gesture this soon after a band touch ends belongs to it

const ROWS = { A: 92, B: 252 }
const ROW_H = 136

Page({
  onInit() {
    this.session = acquire()
    this.crownAccum = 0
    this.mode = 'main' // 'main' | 'picker' | 'inbox' | 'message'
    this.touch = null
    this.lastTap = null
    try {
      this.vibrator = new Vibrator()
    } catch (e) {
      this.vibrator = null
    }
    setPageBrightTime({ brightTime: 2147483000 })
    pauseDropWristScreenOff({ duration: 0 })
  },

  build() {
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: 480, h: 480, color: COLOR.bg })

    this.ring = createWidget(widget.ARC, {
      x: 4, y: 4, w: 472, h: 472, start_angle: 0, end_angle: 360, line_width: 10, color: COLOR.tx
    })
    this.ring.setProperty(prop.VISIBLE, false)

    this.statusText = createWidget(widget.TEXT, {
      x: 90, y: 36, w: 300, h: 40, text: '', text_size: 24, color: COLOR.status,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })

    this.statusText.addEventListener(event.CLICK_UP, () => {
      if (this.mode === 'main') this.openAbout()
    })

    this.rows = {}
    for (const vfo of ['A', 'B']) this.rows[vfo] = this.buildRow(vfo, ROWS[vfo])

    this.dualText = createWidget(widget.TEXT, {
      x: 100, y: 228, w: 280, h: 24, text: '', text_size: 18, color: COLOR.textDim,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })

    this.msgPill = createWidget(widget.FILL_RECT, {
      x: 165, y: 402, w: 150, h: 38, radius: 19, color: COLOR.card
    })
    this.msgText = createWidget(widget.TEXT, {
      x: 165, y: 402, w: 150, h: 38, text: '', text_size: 20, color: COLOR.text,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })
    for (const w of [this.msgPill, this.msgText]) {
      w.addEventListener(event.CLICK_UP, () => {
        if (this.mode === 'main' && this.session.inbox.items.length) this.openInbox(0)
      })
    }

    // Overlays last so they draw on top.
    this.volumeHud = new VolumeHud(COLOR)
    this.banner = new MessageBanner(COLOR, (item) => this.openMessage(item, 'main'))
    this.wheel = new Wheel(COLOR)
    this.messageView = new MessageView(COLOR, () => this.closeMessage())
    this.aboutView = new AboutView(COLOR, () => this.closeAbout())

    this.unsubscribe = this.session.radio.onChange(() => this.render())
    this.unsubscribeInbox = this.session.inbox.onChange((added) => this.onInboxChange(added))
    this.bindInputs()
    this.render()
  },

  buildRow(vfo, top) {
    const bg = createWidget(widget.FILL_RECT, {
      x: 50, y: top, w: 380, h: ROW_H, radius: 28, color: COLOR.rowIdle
    })
    const label = createWidget(widget.TEXT, {
      x: 66, y: top + 10, w: 40, h: 40, text: vfo, text_size: 28, color: COLOR.textDim,
      align_h: align.LEFT, align_v: align.CENTER_V
    })
    const name = createWidget(widget.TEXT, {
      x: 100, y: top + 12, w: 280, h: 60, text: '', text_size: 44, color: COLOR.text,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })
    const freq = createWidget(widget.TEXT, {
      x: 70, y: top + 74, w: 340, h: 48, text: '', text_size: 36, color: COLOR.textDim,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })
    // Text widgets sit on top of the background and take their own touches,
    // so every widget in the row gets the same handlers.
    for (const w of [bg, label, name, freq]) this.bindRowTouch(w, vfo)
    return { bg, label, name, freq }
  },

  // ---- band touches: tap, double-tap, long-press, swipe ----

  bindRowTouch(w, vfo) {
    w.addEventListener(event.CLICK_DOWN, (info) => {
      if (this.mode !== 'main') return
      this.touch = {
        vfo,
        x: info ? info.x : null,
        y: info ? info.y : null,
        open: true,
        handled: false,
        at: Date.now()
      }
      this.longFired = false
      this.cancelLongPress()
      this.longTimer = setTimeout(() => {
        this.longTimer = null
        if (!this.touch || this.touch.handled) return
        this.longFired = true
        this.lastTap = null
        this.session.radio.toggleDualWatch()
      }, LONG_PRESS_MS)
    })
    w.addEventListener(event.CLICK_UP, (info) => {
      this.cancelLongPress()
      const t = this.touch
      if (this.mode !== 'main' || !t || !t.open) return
      t.open = false
      t.at = Date.now()
      if (this.longFired || t.handled) return
      if (info && t.x !== null && info.x !== undefined) {
        const dx = info.x - t.x
        const dy = info.y - t.y
        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
          this.onBandSwipe(t, dx < 0 ? 1 : -1)
          return
        }
        if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) return
      }
      this.onBandTap(vfo)
    })
  },

  cancelLongPress() {
    if (this.longTimer) clearTimeout(this.longTimer)
    this.longTimer = null
  },

  // Swipe left = next channel, swipe right = previous, on the band swiped.
  onBandSwipe(t, dir) {
    t.handled = true
    t.at = Date.now()
    this.cancelLongPress()
    this.lastTap = null
    const radio = this.session.radio
    if (!radio.settings) return
    if (t.vfo === 'B' && !radio.dualWatch) {
      this.flashStatus('Dual watch is off')
      return
    }
    if (radio.scanning) this.flashStatus('Scan stopped')
    radio.stepChannel(dir, t.vfo)
  },

  onBandTap(vfo) {
    const now = Date.now()
    const radio = this.session.radio
    if (this.lastTap && this.lastTap.vfo === vfo && now - this.lastTap.at < DOUBLE_TAP_MS) {
      this.lastTap = null
      if (this.hintTimer) clearTimeout(this.hintTimer)
      this.hintTimer = null
      this.openPicker(vfo)
      return
    }
    this.lastTap = { vfo, at: now }
    if (radio.dualWatch) {
      radio.selectVfo(vfo)
    } else if (vfo === 'B') {
      // Wait out a possible second tap before showing the hint.
      if (this.hintTimer) clearTimeout(this.hintTimer)
      this.hintTimer = setTimeout(() => {
        this.hintTimer = null
        this.flashStatus('Long-press for dual watch')
      }, DOUBLE_TAP_MS)
    }
  },

  // ---- channel picker ----

  openPicker(vfo) {
    const radio = this.session.radio
    if (!radio.settings || !radio.info) return
    if (vfo === 'B' && !radio.dualWatch) {
      this.flashStatus('Dual watch is off')
      return
    }
    const ids = radio.channelList()
    if (!ids.length) return
    const current = radio.channelFor(vfo)
    const items = ids.map((id) => {
      const ch = radio.channelInfo(id)
      return {
        id,
        title: (ch && ch.name) || 'CH ' + (id + 1),
        sub: ch ? formatFreq(ch.rxFreq) + (ch.txDisable ? ' · RX only' : '') : '',
        accent: id === current
      }
    })
    this.mode = 'picker'
    this.banner.hide()
    this.wheel.open({
      header: 'Band ' + vfo,
      items,
      index: Math.max(0, ids.indexOf(current)),
      onPick: (i) => {
        this.wheel.hide()
        this.mode = 'main'
        if (radio.scanning) this.flashStatus('Scan stopped')
        radio.setChannel(vfo, items[i].id)
        this.render()
      },
      onClose: () => {
        this.mode = 'main'
        this.render()
      }
    })
  },

  // ---- messages ----

  onInboxChange(added) {
    this.render()
    if (!added) return
    if (this.vibrator) {
      try {
        this.vibrator.start()
      } catch (e) {}
    }
    if (this.mode === 'main') this.banner.show(added)
  },

  openInbox(index) {
    const inbox = this.session.inbox
    if (!inbox.items.length) {
      this.mode = 'main'
      this.render()
      return
    }
    const items = inbox.items.map((m) => ({
      title: m.from,
      sub: clockTime(m.t) + '  ' + m.text,
      accent: !m.read,
      message: m
    }))
    items.push({ title: 'Clear all', sub: '' })
    this.mode = 'inbox'
    this.banner.hide()
    this.wheel.open({
      header: inbox.unread ? inbox.unread + ' unread' : 'Messages',
      items,
      index,
      onPick: (i) => {
        const item = items[i]
        this.wheel.hide()
        if (item.message) {
          this.inboxIndex = i
          this.openMessage(item.message, 'inbox')
        } else {
          inbox.clear()
          this.mode = 'main'
          this.render()
        }
      },
      onClose: () => {
        this.mode = 'main'
        this.render()
      }
    })
  },

  openMessage(item, from) {
    this.messageFrom = from
    this.mode = 'message'
    this.banner.hide()
    this.messageView.show(item)
    this.session.inbox.markRead(item.id)
  },

  openAbout() {
    this.mode = 'about'
    this.banner.hide()
    this.aboutView.show()
  },

  closeAbout() {
    this.aboutView.hide()
    this.mode = 'main'
    this.render()
  },

  closeMessage() {
    this.messageView.hide()
    if (this.messageFrom === 'inbox') this.openInbox(this.inboxIndex || 0)
    else {
      this.mode = 'main'
      this.render()
    }
  },

  // ---- crown and gestures ----

  bindInputs() {
    onKey({
      callback: (key, ev) => {
        if (key === KEY_CROWN_CW || key === KEY_CROWN_CCW) {
          // Each crown detent arrives as a key click.
          if (ev === KEY_EVENT_CLICK) this.onCrownTurn(key === KEY_CROWN_CW ? 1 : -1)
          return true
        }
        if (key !== KEY_CROWN_PRESS) return false
        if (ev === KEY_EVENT_CLICK) this.onCrownPress()
        return true // swallow the press so the crown doesn't leave the app
      }
    })
    // Not seen on the Balance 2 (its crown sends keys 38/40), kept for
    // watches that report rotation the documented way.
    onDigitalCrown({
      callback: (key, degree) => {
        // positive degree = counter-clockwise; clockwise turns up
        this.crownAccum += -degree
        const steps = Math.trunc(this.crownAccum / CROWN_STEP_DEG)
        if (steps) {
          this.crownAccum -= steps * CROWN_STEP_DEG
          this.onCrownTurn(steps)
        }
      }
    })
    onGesture({ callback: (ev) => this.onGesture(ev) })
  },

  // Clockwise = louder, or further down a list.
  onCrownTurn(steps) {
    if (this.mode === 'picker' || this.mode === 'inbox') {
      this.wheel.move(steps)
      return
    }
    if (this.mode === 'about') {
      this.aboutView.move(steps)
      return
    }
    if (this.mode === 'message') return
    const radio = this.session.radio
    if (radio.stepVolume(steps)) this.volumeHud.show(radio.volume)
    else this.flashStatus(radio.connected ? 'Reading volume…' : 'No radio')
  },

  onCrownPress() {
    if (this.mode === 'picker' || this.mode === 'inbox') {
      this.wheel.pickCurrent()
      return
    }
    if (this.mode === 'message') {
      this.closeMessage()
      return
    }
    if (this.mode === 'about') {
      this.aboutView.next()
      return
    }
    const radio = this.session.radio
    this.flashStatus(radio.scanning ? 'Stopping scan…' : 'Scan…')
    radio.toggleScan()
  },

  // Returning true keeps the system from acting on the gesture (swipe right
  // would otherwise leave the app).
  onGesture(ev) {
    if (this.mode === 'picker' || this.mode === 'inbox') {
      // Dragging the list scrolls it; the system's swipe only counts when no
      // drag reached the list.
      const dragged = this.wheel.dragging()
      if (ev === GESTURE_UP && !dragged) this.wheel.move(WHEEL_PAGE)
      else if (ev === GESTURE_DOWN && !dragged) this.wheel.move(-WHEEL_PAGE)
      else if (ev === GESTURE_RIGHT) this.wheel.close()
      return true
    }
    if (this.mode === 'message') {
      if (ev === GESTURE_RIGHT) this.closeMessage()
      return true
    }
    if (this.mode === 'about') {
      if (ev === GESTURE_RIGHT) this.closeAbout()
      return true
    }
    if (ev !== GESTURE_LEFT && ev !== GESTURE_RIGHT) return false
    // Sideways swipes never leave the app (the lower button does that). One
    // that starts on a band changes its channel. The system may report the
    // touch-up before the gesture, and without coordinates it looked like a
    // tap, so a band touch that just ended still counts.
    const t = this.touch
    if (!t || t.handled) return true
    const recent = Date.now() - t.at < SWIPE_GRACE_MS
    if (t.open || (recent && !this.longFired)) {
      t.open = false
      this.onBandSwipe(t, ev === GESTURE_LEFT ? 1 : -1)
    }
    return true
  },

  // ---- drawing ----

  flashStatus(msg) {
    this.flash = msg
    if (this.flashTimer) clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => {
      this.flash = null
      this.render()
    }, 1500)
    this.render()
  },

  statusLine() {
    const { radio, link } = this.session
    if (radio.transmitting) return { text: 'TRANSMITTING', color: COLOR.tx }
    if (this.flash) return { text: this.flash, color: COLOR.status }
    switch (link.state) {
      case 'scanning': return { text: 'Searching for radio…', color: COLOR.status }
      case 'connecting': return { text: 'Connecting…', color: COLOR.status }
      case 'retrying': return { text: 'No radio, retrying…', color: COLOR.status }
      case 'idle': return { text: 'Stopped', color: COLOR.status }
    }
    if (!radio.info || !radio.settings) return { text: 'Reading radio…', color: COLOR.status }
    return { text: radio.name, color: COLOR.status }
  },

  renderRow(vfo) {
    const radio = this.session.radio
    const r = this.rows[vfo]
    const enabled = vfo === 'A' || radio.dualWatch
    const active = radio.settings && enabled && radio.activeVfo === vfo
    const id = radio.channelFor(vfo)
    const ch = radio.channelInfo(id)
    let name = '—'
    let freq = ''
    if (id !== null) {
      name = (ch && ch.name) || 'CH ' + (id + 1)
      freq = ch ? formatFreq(ch.rxFreq) + (ch.txDisable ? ' · RX only' : '') : ''
    }
    if (!enabled) {
      name = ''
      freq = 'Dual watch off'
    }
    const pending = radio.pending[vfo] !== null
    r.bg.setProperty(prop.COLOR, active ? COLOR.rowActive : enabled ? COLOR.rowIdle : COLOR.rowOff)
    r.label.setProperty(prop.COLOR, enabled ? (active ? COLOR.text : COLOR.textDim) : COLOR.textOff)
    r.name.setProperty(prop.TEXT, name)
    r.name.setProperty(prop.COLOR, COLOR.text)
    r.freq.setProperty(prop.TEXT, freq)
    r.freq.setProperty(prop.COLOR, !enabled ? COLOR.textOff : pending ? COLOR.pending : active ? COLOR.text : COLOR.textDim)
  },

  renderBottom() {
    const { inbox } = this.session
    const total = inbox.items.length
    const unread = inbox.unread
    const show = total > 0
    this.msgPill.setProperty(prop.VISIBLE, show)
    this.msgText.setProperty(prop.VISIBLE, show)
    if (!show) return
    this.msgPill.setProperty(prop.COLOR, unread ? COLOR.accent : COLOR.card)
    this.msgText.setProperty(prop.COLOR, unread ? COLOR.bg : COLOR.text)
    this.msgText.setProperty(prop.TEXT, unread ? unread + ' NEW MSG' : total + ' MSG')
  },

  render() {
    if (!this.rows) return
    const radio = this.session.radio
    const s = this.statusLine()
    this.statusText.setProperty(prop.TEXT, s.text)
    this.statusText.setProperty(prop.COLOR, s.color)
    this.renderRow('A')
    this.renderRow('B')
    const modes = []
    if (radio.settings && radio.dualWatch) modes.push('DUAL WATCH')
    if (radio.settings && radio.scanning) modes.push('SCAN')
    this.dualText.setProperty(prop.TEXT, modes.join(' · '))
    this.dualText.setProperty(prop.COLOR, radio.scanning ? COLOR.pending : COLOR.textDim)
    this.renderBottom()
    this.volumeHud.update(radio.volume)

    if (radio.transmitting) {
      this.ring.setProperty(prop.COLOR, COLOR.tx)
      this.ring.setProperty(prop.VISIBLE, true)
    } else if (radio.receiving) {
      this.ring.setProperty(prop.COLOR, COLOR.rx)
      this.ring.setProperty(prop.VISIBLE, true)
    } else {
      this.ring.setProperty(prop.VISIBLE, false)
    }
  },

  onDestroy() {
    if (this.unsubscribe) this.unsubscribe()
    if (this.unsubscribeInbox) this.unsubscribeInbox()
    this.cancelLongPress()
    for (const k of ['flashTimer', 'hintTimer']) if (this[k]) clearTimeout(this[k])
    if (this.volumeHud) this.volumeHud.destroy()
    if (this.banner) this.banner.destroy()
    offKey()
    offDigitalCrown()
    offGesture()
    resetDropWristScreenOff()
    release()
  }
})
