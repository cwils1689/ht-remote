// Smaller overlays for the main page: the volume pop-up the crown shows, the
// banner for a new APRS message, and the full message view.

import { createWidget, widget, prop, align, text_style, event } from '@zos/ui'
import { VOLUME_MAX } from '../../lib/protocol.js'
import { aboutPages } from '../../lib/credits.js'

const HUD_MS = 1500
const BANNER_MS = 8000
const BAR = { x: 130, y: 286, w: 220, h: 10 }

class Overlay {
  constructor() {
    this.widgets = []
    this.isOpen = false
  }

  add(type, opts) {
    const w = createWidget(type, opts)
    this.widgets.push(w)
    return w
  }

  setVisible(v) {
    this.isOpen = v
    for (const w of this.widgets) w.setProperty(prop.VISIBLE, v)
  }

  onTap(fn) {
    for (const w of this.widgets) w.addEventListener(event.CLICK_UP, fn)
  }
}

export function clockTime(t) {
  const d = new Date(t)
  const pad = (n) => (n < 10 ? '0' : '') + n
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export class VolumeHud extends Overlay {
  constructor(color) {
    super()
    this.add(widget.FILL_RECT, { x: 100, y: 168, w: 280, h: 144, radius: 32, color: color.card })
    this.label = this.add(widget.TEXT, {
      x: 100, y: 180, w: 280, h: 28, text: 'VOLUME', text_size: 22, color: color.textDim,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })
    this.value = this.add(widget.TEXT, {
      x: 100, y: 208, w: 280, h: 66, text: '', text_size: 56, color: color.text,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })
    this.add(widget.FILL_RECT, Object.assign({ radius: 5, color: color.textOff }, BAR))
    this.fill = this.add(widget.FILL_RECT, Object.assign({ radius: 5, color: color.rx }, BAR))
    this.setVisible(false)
  }

  show(level) {
    this.setVisible(true)
    this.update(level)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.setVisible(false)
    }, HUD_MS)
  }

  update(level) {
    if (!this.isOpen || level === null) return
    this.value.setProperty(prop.TEXT, String(level))
    this.label.setProperty(prop.TEXT, level === 0 ? 'MUTED' : 'VOLUME')
    const w = Math.round((BAR.w * level) / VOLUME_MAX)
    this.fill.setProperty(prop.VISIBLE, w > 0)
    if (w > 0) this.fill.setProperty(prop.MORE, Object.assign({}, BAR, { w }))
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer)
  }
}

export class MessageBanner extends Overlay {
  constructor(color, onOpen) {
    super()
    this.add(widget.FILL_RECT, { x: 80, y: 56, w: 320, h: 150, radius: 28, color: color.card })
    this.title = this.add(widget.TEXT, {
      x: 100, y: 68, w: 280, h: 30, text: '', text_size: 22, color: color.accent,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })
    this.body = this.add(widget.TEXT, {
      x: 100, y: 100, w: 280, h: 92, text: '', text_size: 28, color: color.text,
      align_h: align.CENTER_H, align_v: align.TOP, text_style: text_style.WRAP
    })
    this.onTap(() => {
      if (!this.isOpen) return
      this.hide()
      onOpen(this.item)
    })
    this.setVisible(false)
  }

  show(item) {
    this.item = item
    this.title.setProperty(prop.TEXT, 'MESSAGE · ' + item.from)
    this.body.setProperty(prop.TEXT, item.text)
    this.setVisible(true)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.hide(), BANNER_MS)
  }

  hide() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.setVisible(false)
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer)
  }
}

export class MessageView extends Overlay {
  constructor(color, onClose) {
    super()
    this.add(widget.FILL_RECT, { x: 0, y: 0, w: 480, h: 480, color: color.bg })
    this.from = this.add(widget.TEXT, {
      x: 90, y: 56, w: 300, h: 48, text: '', text_size: 36, color: color.accent,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })
    this.meta = this.add(widget.TEXT, {
      x: 80, y: 104, w: 320, h: 30, text: '', text_size: 22, color: color.textDim,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })
    this.body = this.add(widget.TEXT, {
      x: 60, y: 146, w: 360, h: 236, text: '', text_size: 30, color: color.text,
      align_h: align.CENTER_H, align_v: align.TOP, text_style: text_style.WRAP
    })
    this.add(widget.TEXT, {
      x: 140, y: 394, w: 200, h: 30, text: 'Tap to go back', text_size: 20, color: color.textOff,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })
    this.onTap(() => {
      if (this.isOpen) onClose()
    })
    this.setVisible(false)
  }

  show(item) {
    this.from.setProperty(prop.TEXT, item.from)
    this.meta.setProperty(prop.TEXT, 'to ' + item.to + ' · ' + clockTime(item.t))
    this.body.setProperty(prop.TEXT, item.text)
    this.setVisible(true)
  }

  hide() {
    this.setVisible(false)
  }
}

// Credits and license notices. Tap or turn the crown for the next page; drag
// up/down to move between them; swipe right to go back.
export class AboutView extends Overlay {
  constructor(color, onClose) {
    super()
    this.pages = aboutPages()
    this.index = 0
    this.add(widget.FILL_RECT, { x: 0, y: 0, w: 480, h: 480, color: color.bg })
    this.title = this.add(widget.TEXT, {
      x: 70, y: 70, w: 340, h: 56, text: '', text_size: 36, color: color.accent,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })
    this.body = this.add(widget.TEXT, {
      x: 60, y: 136, w: 360, h: 230, text: '', text_size: 28, color: color.text,
      align_h: align.CENTER_H, align_v: align.TOP, text_style: text_style.WRAP
    })
    this.count = this.add(widget.TEXT, {
      x: 140, y: 384, w: 200, h: 30, text: '', text_size: 22, color: color.textDim,
      align_h: align.CENTER_H, align_v: align.CENTER_V
    })
    this.touchY = null
    for (const w of this.widgets) {
      w.addEventListener(event.CLICK_DOWN, (info) => {
        this.touchY = info && info.y !== undefined ? info.y : null
      })
      w.addEventListener(event.CLICK_UP, (info) => {
        const y0 = this.touchY
        this.touchY = null
        if (!this.isOpen) return
        const dy = y0 === null || !info || info.y === undefined ? 0 : info.y - y0
        if (Math.abs(dy) >= 60) this.move(dy < 0 ? 1 : -1)
        else if (Math.abs(dy) < 20) this.next()
      })
    }
    this.setVisible(false)
  }

  show() {
    this.index = 0
    this.setVisible(true)
    this.render()
  }

  hide() {
    this.setVisible(false)
  }

  next() {
    this.index = (this.index + 1) % this.pages.length
    this.render()
  }

  move(delta) {
    const i = Math.max(0, Math.min(this.pages.length - 1, this.index + delta))
    if (i === this.index) return
    this.index = i
    this.render()
  }

  render() {
    const p = this.pages[this.index]
    this.title.setProperty(prop.TEXT, p.title)
    this.body.setProperty(prop.TEXT, p.body.join('\n\n'))
    this.count.setProperty(prop.TEXT, this.index + 1 + ' / ' + this.pages.length)
  }
}
