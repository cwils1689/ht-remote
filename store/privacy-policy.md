# HT Remote Privacy Policy

Effective date: 2026-10-18

HT Remote is a watch app by Clint Wilson (KO4LTW) that remotely controls a
handheld amateur radio over Bluetooth. This policy explains what the app does
with data. The short version: **everything stays on your watch. The app has no
accounts, no servers, no analytics and no internet access.**

## What the app uses

| Data | Why | Where it lives |
|---|---|---|
| The Bluetooth address and name of your radio | To reconnect to it without searching every time | Stored on your watch only |
| The radio's channel names and frequencies, and its settings (current channels, volume, dual watch, scan state, APRS callsign) | To show them on the watch and to change them when you ask | Channel names and frequencies are cached on your watch. Everything else is held in memory while the app is open and discarded when it closes. |
| APRS text messages the radio receives, with the sender's callsign, the addressee's callsign, the message text and the time | To show them as notifications and in the message list | Stored on your watch only, up to the latest 40 |

The app does not use your location, contacts, health data, microphone, camera
or account details. It never reads your phone's data.

## What leaves your watch

Nothing. The app talks only to your own radio over Bluetooth Low Energy. It
does not connect to the internet, and it does not send data to me, to the
makers of the radio, or to anyone else. Its Bluetooth connection is to your
radio only: it scans for radios by name and connects to the one it finds.

## APRS messages from other people

APRS messages are public radio transmissions. The app keeps the ones your
radio receives that are addressed to the callsign set in your radio (or, if
your radio has no callsign set, all messages between stations except
bulletins). These can contain other people's callsigns and whatever they chose
to send. They are stored only on your watch, are never uploaded, and are
shown only to you.

## Permissions

- **Bluetooth** (`device:os.ble`): to find and control your radio.
- **Local storage** (`device:os.local_storage`): to remember your radio, the
  channel cache and received messages on the watch.

## Your control over the data

- **Delete messages:** open the message list and choose "Clear all".
- **Delete everything:** uninstalling the app removes all of its stored data
  from the watch.
- **Forget your radio:** uninstalling the app also forgets the remembered
  radio. The radio's own pairing list is managed on the radio.

## Third parties

The app is built on the Zepp OS platform and distributed through the Zepp
store. Zepp Health and Amazfit's own apps and services have their own
policies, which I don't control. HT Remote itself includes an open-source
Bluetooth library (easy-ble); it runs on the watch and sends nothing anywhere.

## Children

The app doesn't collect personal information from anyone, including children.
Using the radio it controls may require an amateur radio licence in your
country if you transmit; this app cannot transmit.

## Changes

If this policy changes, the new version will be posted where this one is, with
a new effective date. Because the app collects nothing, I expect changes to be
rare.

## Contact

Clint Wilson (KO4LTW) — KO4LTW@protonmail.com
