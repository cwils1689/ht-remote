// Full-screen pick list for the round screen: five rows, the middle one
// highlighted. Dragging up/down scrolls it (one row per DRAG_PX of travel)
// and tapping a row picks it. The page adds the crown: turns call move(),
// a press calls pickCurrent(). Used for the channel picker and the message
// list.

import { createWidget, widget, prop, align, text_style, event } from '@zos/ui'

const SLOTS = 5
const MID = 2
const PITCH = 78
const CENTER_Y = 240
export const WHEEL_PAGE = 3
const DRAG_PX = 55 // finger travel per row scrolled
const TAP_SLOP_PX = 20 // more travel than this and it isn't a tap
const DRAG_QUIET_MS = 500 // a system swipe this soon after a drag is that drag

export class Wheel {
  constructor(color) {
    this.color = color
    this.items = []
    this.index = 0
    this.isOpen = false
    this.widgets = []
    this.drag = null
    this.lastDragAt = 0

    // Takes the touches meant for the page underneath.
    this.backdrop = this.add(widget.FILL_RECT, { x: 0, y: 0, w: 480, h: 480, color: color.bg })
    this.bindTouch(this.backdrop, null)

    this.highlight = this.add(widget.FILL_RECT, {
      x: 46, y: CENTER_Y - 48, w: 388, h: 96, radius: 28, color: color.rowActive
    })
    this.header = this.add(widget.TEXT, {
      x: 140, y: 20, w: 200, h: 34, text: '', text_size: 22, color: color.textDim,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
    })

    this.slots = []
    for (let k = 0; k < SLOTS; k++) {
      const cy = CENTER_Y + (k - MID) * PITCH
      const mid = k === MID
      const title = this.add(widget.TEXT, {
        x: mid ? 70 : 80, y: mid ? cy - 44 : cy - 28, w: mid ? 340 : 320, h: mid ? 50 : 56,
        text: '', text_size: mid ? 36 : 28, color: mid ? color.text : color.textDim,
        align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
      })
      const sub = mid
        ? this.add(widget.TEXT, {
            x: 70, y: cy + 4, w: 340, h: 36, text: '', text_size: 24, color: color.text,
            align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.ELLIPSIS
          })
        : null
      for (const w of [title, sub]) if (w) this.bindTouch(w, k)
      this.slots.push({ title, sub })
    }
    this.bindTouch(this.highlight, MID)
    this.bindTouch(this.header, null)
    this.setVisible(false)
  }

  // k: the row this widget belongs to, or null for the background. A touch
  // that moves scrolls the list; one that doesn't picks the row it started on.
  bindTouch(w, k) {
    w.addEventListener(event.CLICK_DOWN, (info) => {
      if (!this.isOpen) return
      const y = info && info.y !== undefined ? info.y : null
      this.drag = { k, y, startIndex: this.index, moved: false }
    })
    w.addEventListener(event.MOVE, (info) => this.dragTo(info))
    w.addEventListener(event.CLICK_UP, (info) => {
      const d = this.drag
      this.drag = null
      if (!d || !this.isOpen) return
      this.dragTo(info, d)
      if (d.moved) {
        this.lastDragAt = Date.now()
        return
      }
      if (d.k !== null) this.tapSlot(d.k)
    })
  }

  // Scrolls relative to where the touch started, so MOVE events and the
  // final CLICK_UP agree however many of them arrive.
  dragTo(info, d = this.drag) {
    if (!d || d.y === null || !info || info.y === undefined) return
    const dy = info.y - d.y
    if (Math.abs(dy) > TAP_SLOP_PX) d.moved = true
    if (!d.moved) return
    this.lastDragAt = Date.now()
    this.setIndex(d.startIndex + Math.round(-dy / DRAG_PX))
  }

  // True while a drag is scrolling the list, or just after one: the page
  // then ignores the system's swipe gesture for the same movement.
  dragging() {
    return (this.drag && this.drag.moved) || Date.now() - this.lastDragAt < DRAG_QUIET_MS
  }

  add(type, opts) {
    const w = createWidget(type, opts)
    this.widgets.push(w)
    return w
  }

  setVisible(v) {
    for (const w of this.widgets) w.setProperty(prop.VISIBLE, v)
  }

  // items: [{ title, sub, accent }]; onPick(index); onClose()
  open({ header, items, index, onPick, onClose }) {
    this.items = items
    this.index = Math.max(0, Math.min(items.length - 1, index || 0))
    this.onPick = onPick
    this.onClose = onClose
    this.isOpen = true
    this.header.setProperty(prop.TEXT, header || '')
    this.setVisible(true)
    this.render()
  }

  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.drag = null
    this.setVisible(false)
    if (this.onClose) this.onClose()
  }

  // Hide without calling onClose (the page is switching views itself).
  hide() {
    this.isOpen = false
    this.drag = null
    this.setVisible(false)
  }

  move(delta) {
    this.setIndex(this.index + delta)
  }

  setIndex(i) {
    if (!this.isOpen || !this.items.length) return
    const next = Math.max(0, Math.min(this.items.length - 1, i))
    if (next === this.index) return
    this.index = next
    this.render()
  }

  pickCurrent() {
    if (this.isOpen && this.items.length && this.onPick) this.onPick(this.index)
  }

  tapSlot(k) {
    const i = this.index + k - MID
    if (!this.isOpen || i < 0 || i >= this.items.length) return
    this.index = i
    if (this.onPick) this.onPick(i)
  }

  render() {
    for (let k = 0; k < SLOTS; k++) {
      const item = this.items[this.index + k - MID]
      const s = this.slots[k]
      const mid = k === MID
      s.title.setProperty(prop.TEXT, item ? item.title : '')
      const plain = mid ? this.color.text : this.color.textDim
      s.title.setProperty(prop.COLOR, item && item.accent ? this.color.accent : plain)
      if (s.sub) s.sub.setProperty(prop.TEXT, item && item.sub ? item.sub : '')
    }
  }
}
