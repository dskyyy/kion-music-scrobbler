import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// Single codebase -> chrome-mv3 + firefox-mv2 (WXT default for Firefox)
export default defineConfig({
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser }) => {
    const manifest = {
      name: 'KION Music Scrobbler',
      description: 'Scrobbles music.mts.ru to Last.fm',
      permissions: ['storage', 'alarms'],
      host_permissions: ['https://ws.audioscrobbler.com/*'],
      action: {
        default_icon: {
          16: 'icon-16.png',
          32: 'icon-32.png',
          48: 'icon-48.png',
          128: 'icon-128.png',
        },
      },
      icons: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
    }
    if (browser === 'firefox') {
      // Firefox-only: add-on id + data consent disclosure.
      // The core feature transmits website content (track/artist) to Last.fm.
      // MV2 uses browser_action; WXT converts `action` but drops icons,
      // so declare them explicitly.
      Object.assign(manifest, {
        browser_specific_settings: {
          gecko: {
            id: 'kion-music-scrobbler@local',
            data_collection_permissions: { required: ['websiteContent'] },
          },
        },
        browser_action: {
          default_icon: {
            16: 'icon-16.png',
            32: 'icon-32.png',
            48: 'icon-48.png',
            128: 'icon-128.png',
          },
        },
      })
    }
    return manifest
  },
})
