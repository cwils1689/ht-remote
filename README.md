# HT Remote — VR-N76 on the Amazfit Balance 2

A Zepp OS mini app that controls a Vero VR-N76 directly over Bluetooth LE. No
phone or HTCommander is needed at runtime.

```
        ┌──────────────────────────┐
        │   VR-N76 · radio audio   │   status line
        │ ┌──────────────────────┐ │
        │ │ A     SIMPLEX        │ │   VFO A (blue = active)
        │ │      146.520         │ │
        │ └──────────────────────┘ │
        │    DUAL WATCH · SCAN     │
        │ ┌──────────────────────┐ │
        │ │ B     NOAA 1         │ │   VFO B
        │ │ 162.400 · RX only    │ │
        │ └──────────────────────┘ │
        │       [ 2 NEW MSG ]      │   APRS messages (when there are any)
        └──────────────────────────┘
   ring: red while transmitting, green while receiving
```

| Control | Does |
|---|---|
| Turn the crown | Radio volume, 0–15 (clockwise = louder). The level shows in a pop-up only while you adjust it. |
| Press the crown | Scan on/off (uses the radio's own scan list) |
| Swipe left / right on a band | Next / previous channel on that band. Empty channels are skipped. Swiping band A or B also selects it in dual watch. During a scan, stops the scan. |
| Tap a band | Select VFO A or B (dual watch only) |
| Double-tap a band | Channel list for that band: drag up/down or turn the crown to scroll, tap a channel (or press the crown) to jump to it, swipe right to cancel. The current channel is orange. |
| Long-press a band | Dual watch on/off |
| Tap the MSG pill | Received APRS messages, newest first (unread in orange). Tap one to read it; tap again or swipe right to go back. The last entry clears the list. |
| Tap the status line (top) | Credits and licenses. Tap, turn the crown or drag up/down for the next page; swipe right to go back. |
| Lower button | Leave the app. Swiping right no longer exits; sideways swipes off the bands do nothing. |

**APRS messages.** Messages the radio decodes show up as a banner with a
buzz while the app is open; tap the banner to read it. If the radio has an
APRS callsign set (Beacon settings), only messages to that callsign are kept,
whatever the SSID; without one, every station-to-station message is kept
except bulletins. Repeats of the same message (senders retry until acked)
are dropped. The watch can't transmit, so it doesn't ack: the sender will keep
retrying unless the radio acks on its own. Up to 40 messages are kept between
sessions.

**Radios.** Built for the Vero VR-N76, the only one it has been tested on. It
speaks the Benshi protocol, so it should also work with the BTech UV-PRO and
UV-50PRO, Radioddity GA-5WB and DB50-B Mini, Vero VR-N75, VR-N7500 and
VR-N7600, and Radtel RT-660. The app finds a radio by its Bluetooth name
(`RADIO_NAME_KEYWORDS` in `lib/protocol.js`); the RT-660's name is a guess.

**Talk and listen through the radio.** The watch can't carry the audio (see
Findings), so there is no PTT on the watch. To hear the radio on the watch,
use HTCommander on your phone with the watch's Bluetooth Speaker mode. The
radio only allows one control app at a time, so HT Remote can't connect
while HTCommander is.

---

## License and credits

HT Remote, by Clint Wilson (KO4LTW), is licensed under the Apache License 2.0
(`LICENSE`). It is
independent of, and not endorsed by, HTCommander, Vero, Zepp Health or Amazfit.

- The radio protocol code is adapted from
  [HTCommander](https://github.com/Ylianst/HTCommander) by Ylianst (Apache-2.0).
- [benlink](https://github.com/khusmann/benlink) by Kyle Husmann (Apache-2.0)
  was used as a protocol reference.
- `@silver-zepp/easy-ble` by Silver, Zepp Health (MIT) is bundled for
  Bluetooth.

`NOTICE` has the details and the MIT text. The same credits are in the app
(tap the status line), because the store package doesn't include these files.
The source is at https://github.com/cwils1689/ht-remote, and `SOURCE_URL` in
`lib/credits.js` puts that address on the About page. The privacy policy is
`store/privacy-policy.md`.

---

## Install

Same workflow as the Zepp Face project:

```bash
npm install
zeus preview
```

Then scan the QR code from the Zepp app (Profile → Balance 2 → Developer Mode →
scan icon). `zeus build` writes a `.zab` to `dist/`.

If `zeus preview` complains the project is unregistered, run `zeus login`, or
set `app.appId` in `app.json` to an ID from the Zepp developer console.

## First connection

The radio only accepts commands from a device it has bonded with:

1. On the radio, delete any old entry for the watch under **Connection →
   Paired Devices**.
2. Open **Connection → Pairing** on the radio and leave it on that screen.
3. Open HT Remote. Accept the pairing prompt on the watch (and on the radio if
   it asks).

After that, the app finds the radio by itself. If the radio is switched off
or walks out of range, the app notices within about 25 s and reconnects.

---

## Battery

The screen stays on while the app is open, so expect faster battery drain on
the watch.

---

## Files

| Path | Role |
|---|---|
| `lib/protocol.js` | Command encoding and reply decoding, ported from HTCommander (`gaia_protocol.dart`, `radio_models.dart`) |
| `lib/radio.js` | Connect sequence, channel table, per-band stepping and jumps, VFO select, dual watch, scan, volume, packet reassembly |
| `lib/aprs.js` | AX.25 UI frames and APRS message parsing (third-party unwrapping, acks and telemetry skipped) |
| `lib/inbox.js` | Stored APRS messages, repeat filtering, unread count |
| `lib/link.js` | BLE scan, connect, GATT profile and indications, keepalive, built on `@silver-zepp/easy-ble` |
| `lib/session.js` | The radio connection, keepalive, remembered radio, cached channel names, message inbox |
| `page/index.js` | The main screen and its input handling |
| `page/ui/wheel.js` | The scrolling pick list used for channels and messages |
| `page/ui/overlays.js` | Volume pop-up, message banner, message view |
| `lib/credits.js` | Text of the About page (credits and licenses) |
| `store/` | Draft Zepp store listing and privacy policy |
| `LICENSE`, `NOTICE` | Apache-2.0 text and the third-party credits (HTCommander, benlink, easy-ble) |
| `test/protocol.test.mjs` | `npm test`: protocol, radio, APRS and inbox logic with a fake link |

## Findings

All from testing on a Balance 2 with a VR-N76 (model code 259), October 2026.

1. **BLE control works.** The radio's custom 128-bit GATT UUIDs work with
   Zepp's BLE API. Writes fail with status -1 until the radio and watch are
   bonded through the radio's Pairing screen.
2. **Crown input.** A crown detent arrives as `onKey` key 40 (clockwise) or 38
   (counter-clockwise) with a CLICK event. A crown press is key 13 with
   PRESS/RELEASE. `onDigitalCrown` never fires, and the side button doesn't
   reach the app.
3. **Remote buttons (`doProgFunc`, cmd 66).** The payload is a 16-bit
   big-endian effect code. 1-byte payloads get status 5, `[00 12]` toggles
   A/B, and `[00 0d]` keys the transmitter.
4. **Remote PTT: press works, release doesn't.** Nothing tried releases it:
   - `[x 0d]` for x = 1–16, 0x80 and 0xff
   - `[00/01 04]` and `[00/01 0e]`
   - 3- and 4-byte forms of `[00 0d …]`
   - A/B and dual-watch toggles (which do take effect during TX), a settings
     rewrite, and sub-band PTT

   Only the radio's own PTT or TX time limit stops it, so the app has no PTT.
   The diagnostics page used to find all this was removed once testing was
   done. Afterwards the radio
   ignores further remote presses until it is power-cycled. HTCommander
   doesn't use this command for voice: it keys by streaming SBC audio over
   Classic RFCOMM, which Zepp OS can't do.
5. **Watch as the radio's audio headset: fails.** The radio lists the watch as
   paired, but the watch never accepts it as a calling device and plays
   nothing. Bluetooth Speaker mode only works with the watch's own phone.
6. **Model code.** A VR-N76 on current firmware reports 259, not 2.
   Unknown models fall back to the radio's Bluetooth name.
7. **Touch gestures (0.2.0).** Returning true from `onGesture` for left/right
   stops swipe-right from leaving the app, and band swipes change channel.
   Up/down swipes never scrolled the pick list through `onGesture`, so the
   list follows the finger itself from the widgets' touch coordinates
   (`CLICK_DOWN`/`MOVE`/`CLICK_UP`), which works.
8. **Volume (0.2.0).** `GET_VOLUME` (22) replies `[status, level]` and
   `SET_VOLUME` (23) takes `[level]`, 0–15. It's polled with the keepalive,
   so a change made on the radio shows within 10 s.

### Not yet confirmed on hardware (0.2.0)

Taken from HTCommander and benlink, covered by `npm test`, not yet tried on
the watch:

- Received packets: TNC fragments in `dataRxd` events (type 2) or `RX_DATA`
  (cmd 57) frames, control byte at [5]. HTCommander gets these without
  registering for them.
- Callsign: `READ_BSS_SETTINGS` (33) reply, callsign at [45..50], SSID in
  the high nibble of [7].
