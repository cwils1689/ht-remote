// One radio connection shared by every page. Pages are bundled separately,
// so the instance lives on the App's globalData rather than in module scope.

import { LocalStorage } from '@zos/storage'
import { Radio } from './radio.js'
import { RadioLink } from './link.js'
import { Inbox } from './inbox.js'
import { parseAx25, parseAprsMessage, isForMe, formatCall } from './aprs.js'

const LOG_LINES = 60
const KEEPALIVE_MS = 10000
const MAX_SILENT_MS = 25000

function createSession() {
  const store = new LocalStorage()
  const logs = []
  const log = (msg) => {
    console.log(msg)
    logs.push(msg)
    if (logs.length > LOG_LINES) logs.shift()
  }

  const cacheKey = () => 'channels:' + (store.getItem('mac', '') || 'none')
  const radio = new Radio({
    send: (bytes) => link.send(bytes),
    log,
    cache: {
      load: () => store.getItem(cacheKey(), {}),
      save: (obj) => store.setItem(cacheKey(), obj)
    }
  })

  const inbox = new Inbox({
    load: () => store.getItem('aprs:inbox', []),
    save: (items) => store.setItem('aprs:inbox', items)
  })

  // Every packet the radio decodes; keep the APRS messages meant for us.
  radio.onPacket((bytes) => {
    const ax = parseAx25(bytes)
    if (!ax) return
    const msg = parseAprsMessage(formatCall(ax.src), ax.info)
    if (!msg) return
    const me = radio.callsign ? formatCall(radio.callsign) : null
    if (!isForMe(msg, me)) return
    if (inbox.add(msg)) log('aprs: message from ' + msg.from + ' to ' + msg.to)
  })

  const link = new RadioLink({
    mac: store.getItem('mac', '') || null,
    log,
    onFrame: (f) => radio.handleFrame(f),
    onUp: (mac) => {
      if (store.getItem('mac', '') !== mac) {
        store.setItem('mac', mac)
        radio.channels = store.getItem(cacheKey(), {})
      }
      log('link up ' + mac)
      radio.btName = link.devName || null
      radio.linkUp()
    },
    onDown: () => {
      log('link down')
      radio.linkDown()
    },
    onState: () => radio.emit()
  })

  return {
    radio,
    link,
    inbox,
    logs,
    log,
    store,
    users: 0
  }
}

export function getSession() {
  const g = getApp()._options.globalData
  if (!g.session) g.session = createSession()
  return g.session
}

// The page calls acquire() on init and release() on destroy, and the link
// runs while it is alive. Teardown waits a moment and is skipped if the page
// is rebuilt and acquires again in the meantime.
export function acquire() {
  const s = getSession()
  s.users++
  if (s.link.stopped) s.link.start()
  if (!s.keepalive) {
    // Poll status so a dead link shows up as silence, then let the link
    // decide whether to reconnect.
    s.keepalive = setInterval(() => {
      if (s.link.state === 'up') s.radio.poll()
      s.link.checkAlive(MAX_SILENT_MS)
    }, KEEPALIVE_MS)
  }
  return s
}

export function release() {
  const s = getSession()
  if (--s.users > 0) return
  s.users = 0
  setTimeout(() => {
    if (s.users > 0) return
    if (s.keepalive) clearInterval(s.keepalive)
    s.keepalive = null
    s.radio.shutdown()
    s.link.stop()
    s.radio.linkDown()
  }, 400)
}
