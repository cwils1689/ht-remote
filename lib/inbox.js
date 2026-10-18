// Received APRS messages, newest first, kept in local storage. Senders retry
// a message until it is acked, and the watch can't ack (no TX), so repeats
// of the same message are dropped here.

const MAX_ITEMS = 40
const REPEAT_WINDOW_MS = 2 * 60 * 60 * 1000

export class Inbox {
  // store: { load() -> [], save(items) }
  constructor(store) {
    this.store = store
    this.items = (store && store.load()) || []
    this.nextId = this.items.reduce((n, m) => Math.max(n, m.id + 1), 1)
    this.listeners = []
  }

  // fn(addedItem | null). Returns an unsubscribe function.
  onChange(fn) {
    this.listeners.push(fn)
    return () => (this.listeners = this.listeners.filter((f) => f !== fn))
  }

  emit(added) {
    for (const fn of this.listeners) fn(added || null)
  }

  save() {
    if (this.store) this.store.save(this.items)
  }

  isRepeat(msg, now) {
    return this.items.some(
      (m) =>
        m.from === msg.from &&
        now - m.t < REPEAT_WINDOW_MS &&
        (msg.msgId ? m.msgId === msg.msgId : m.text === msg.text)
    )
  }

  // Returns the stored item, or null for a repeat.
  add(msg, now = Date.now()) {
    if (this.isRepeat(msg, now)) return null
    const item = {
      id: this.nextId++,
      from: msg.from,
      to: msg.to,
      text: msg.text,
      msgId: msg.msgId || null,
      t: now,
      read: false
    }
    this.items.unshift(item)
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS
    this.save()
    this.emit(item)
    return item
  }

  get unread() {
    return this.items.filter((m) => !m.read).length
  }

  markRead(id) {
    const m = this.items.find((i) => i.id === id)
    if (!m || m.read) return
    m.read = true
    this.save()
    this.emit()
  }

  clear() {
    this.items = []
    this.save()
    this.emit()
  }
}
