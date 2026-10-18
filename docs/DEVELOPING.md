# Developing HT Remote

HT Remote is a Zepp OS mini app (JavaScript, Zepp OS API 3+) that talks to the
radio directly over Bluetooth LE.

## Build and run

Install the Zeus CLI (`npm install -g @zeppos/zeus-cli`), then:

```bash
npm install
npm test            # protocol, radio, APRS and inbox logic with a fake link
zeus preview        # scan the QR code from the Zepp app (developer mode)
zeus build          # writes a .zab to dist/
```

Preview and build need an `app.appId` that is registered to your own Zepp
developer account (`zeus login`, then create the app at console.zepp.com and
put its ID in `app.json`).

To run it you need a Benshi-type radio, paired as described in the
[README](../README.md#first-connection).

## Files

| Path | Role |
|---|---|
| `lib/protocol.js` | Command encoding and reply decoding, adapted from HTCommander |
| `lib/radio.js` | Connect sequence, channel table, per-band stepping and jumps, VFO select, dual watch, scan, volume, packet reassembly |
| `lib/aprs.js` | AX.25 UI frames and APRS message parsing (third-party unwrapping, acks and telemetry skipped) |
| `lib/inbox.js` | Stored APRS messages, repeat filtering, unread count |
| `lib/link.js` | BLE scan, connect, GATT profile and indications, keepalive, built on `@silver-zepp/easy-ble` |
| `lib/session.js` | The radio connection, keepalive, remembered radio, cached channel names, message inbox |
| `lib/credits.js` | Text of the About page |
| `page/index.js` | The main screen and its input handling |
| `page/ui/wheel.js` | The scrolling pick list used for channels and messages |
| `page/ui/overlays.js` | Volume pop-up, message banner, message view, About view |
| `store/` | Zepp store listing, privacy policy and screenshots (`store/screenshots/make-screenshots.ps1` redraws the drawn ones) |
| `test/protocol.test.mjs` | The tests |
| `LICENSE`, `NOTICE` | Apache-2.0 text and the third-party credits |

`lib/protocol.js`, `lib/radio.js` and `lib/aprs.js` have no Zepp imports, so
they run under Node for the tests.

## Protocol notes

Over BLE the radio takes the bare command with no GAIA wrapper:
`[group_hi, group_lo, cmd_hi, cmd_lo, payload...]`. Replies set bit 0x8000 in
the command and carry a status byte at [4] (0 = ok) and the payload from [5].
Event notifications (command 9) carry the notification type at [4].

What was learned from running this on a Balance 2 with a VR-N76 (October 2026):

1. **BLE control works.** The radio's custom 128-bit GATT UUIDs work with
   Zepp's BLE API. Writes fail with status -1 until the radio and watch are
   bonded through the radio's Pairing screen.
2. **Crown input.** A crown detent arrives as `onKey` key 40 (clockwise) or 38
   (counter-clockwise) with a CLICK event. A crown press is key 13 with
   PRESS/RELEASE. `onDigitalCrown` never fires, and the side button doesn't
   reach the app.
3. **Remote buttons (`doProgFunc`, command 66).** The payload is a 16-bit
   big-endian effect code. `[00 12]` toggles A/B and `[00 0c]` toggles scan.
4. **Model code.** A VR-N76 on current firmware reports 259, not 2. Unknown
   models fall back to the radio's Bluetooth name.
5. **Volume.** `GET_VOLUME` (22) replies `[status, level]` and `SET_VOLUME`
   (23) takes `[level]`, 0–15. It is polled with the keepalive, so a change made
   on the radio shows within 10 s.
6. **Touch gestures.** Returning true from `onGesture` for left and right swipes
   stops swipe-right from leaving the app, and band swipes change channel.
   Up and down swipes never reach `onGesture` usefully, so the pick list follows
   the finger itself from the widgets' touch coordinates
   (`CLICK_DOWN`, `MOVE`, `CLICK_UP`).

### Not yet confirmed on hardware

Taken from HTCommander and benlink and covered by the tests, but not yet tried
against a real radio:

- Received packets: TNC fragments in `dataRxd` events (type 2) or `RX_DATA`
  (command 57) frames, control byte at [5].
- Callsign: the `READ_BSS_SETTINGS` (33) reply, callsign at [45..50], SSID in
  the high nibble of [7].
- Other radios: the app finds a radio by its Bluetooth name
  (`RADIO_NAME_KEYWORDS` in `lib/protocol.js`). Only the VR-N76 has been tested,
  and the RT-660's name is a guess.
