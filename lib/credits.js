// Text for the About page. Pure data, so a test can check it matches NOTICE.
//
// Copyright 2026 Clint Wilson (KO4LTW). Licensed under the Apache License, Version 2.0
// (see LICENSE and NOTICE).

export const APP_VERSION = '0.2.0'

// Where the source and full license texts live. Leave empty until the
// project is published; the About page then shows only the license URLs.
export const SOURCE_URL = 'github.com/cwils1689/ht-remote'

const LICENSE_URL = 'apache.org/licenses/LICENSE-2.0'

// One entry per About page: { title, body }.
export function aboutPages() {
  const source = SOURCE_URL ? ['Source and licenses:', SOURCE_URL] : []
  return [
    {
      title: 'HT Remote ' + APP_VERSION,
      body: [
        'By Clint Wilson, KO4LTW',
        'Unofficial remote for the Vero VR-N76 and other Benshi radios.',
        'Cannot transmit. No ham license needed to use it.',
        'Not affiliated with or endorsed by Vero, HTCommander, Zepp or Amazfit.'
      ]
    },
    {
      title: 'Based on HTCommander',
      body: [
        'Radio protocol code adapted from HTCommander by Ylianst.',
        'github.com/Ylianst/HTCommander',
        'Apache License 2.0'
      ]
    },
    {
      title: 'Also thanks to',
      body: [
        'benlink by Kyle Husmann (Apache 2.0), a protocol reference.',
        'github.com/khusmann/benlink',
        'easy-ble by Silver, Zepp Health (MIT), the Bluetooth library.'
      ]
    },
    {
      title: 'License',
      body: [
        'HT Remote is licensed under the Apache License 2.0.',
        'Full text: ' + LICENSE_URL
      ].concat(source)
    }
  ]
}
