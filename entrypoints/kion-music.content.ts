import { browser } from 'wxt/browser'

import type { ContentMessage } from '../utils/types'

/**
 * Detects the playing track on music.mts.ru and reports it to background.
 * Battery-friendly: event-driven (audio events + debounced MutationObserver),
 * only a 5s safety poll while actually playing.
 *
 * Priority: MediaSession metadata -> data-testid DOM -> document.title.
 * Only stable data-testid hooks are used (CSS-module class hashes change
 * between site builds, so class selectors are forbidden).
 */

const TITLE_SELECTORS = [
  '[data-testid="player-track-title"]',
  '[data-testid="track-title"]',
  '[data-testid="player-title"]',
]

const ARTIST_SELECTORS = [
  '[data-testid="player-track-artist"]',
  '[data-testid="track-artist"]',
  '[data-testid="player-artist"]',
]

function textOf(selectors: string[]): string {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel)
      const text = el?.textContent?.trim()
      if (text) {
        return text
      }
    } catch {
      // invalid selector — skip
    }
  }
  return ''
}

function readMediaSession(): { artist: string; track: string; album?: string } | null {
  try {
    const md = navigator.mediaSession?.metadata
    if (md?.title && md?.artist) {
      return {
        artist: md.artist.trim(),
        track: md.title.trim(),
        album: md.album?.trim() || undefined,
      }
    }
  } catch {
    // MediaSession unavailable — fall through
  }
  return null
}

/** SEO boilerplate that is never a real artist/track (e.g. album page titles). */
const TITLE_BLOCKLIST = ['слушать', 'скачать', 'бесплатно']

function hasBoilerplate(s: string): boolean {
  const low = s.toLowerCase()
  return TITLE_BLOCKLIST.some((w) => low.includes(w))
}

/**
 * Last-resort fallback: "Artist — Track" in document.title.
 * Only dash separators (SEO templates like "X - слушать…" use a hyphen) plus
 * boilerplate rejection, so album/page titles never pass as tracks.
 * Real playback is still required (see the announceIfChanged gate) —
 * this is just the second line of defense.
 */
function readTitle(): { artist: string; track: string } | null {
  const raw = document.title?.trim() ?? ''
  if (!raw || hasBoilerplate(raw)) {
    return null
  }
  for (const sep of [' — ', ' – ']) {
    const idx = raw.indexOf(sep)
    if (idx > 0) {
      const left = raw.slice(0, idx).trim()
      let right = raw.slice(idx + sep.length).trim()
      // Strip site suffix like " | КИОН Музыка"
      right = right.split(' | ')[0].split(' — ')[0].trim()
      if (left && right && left.length < 120 && right.length < 120) {
        return { artist: left, track: right }
      }
    }
  }
  return null
}

function pickAudio(): HTMLAudioElement | null {
  const audios = [...document.querySelectorAll('audio')]
  if (audios.length === 0) {
    return null
  }
  // Prefer the playing one, else the one with real duration.
  const playing = audios.find((a) => !a.paused && !a.ended && a.readyState > 0)
  if (playing) {
    return playing
  }
  const withDuration = audios
    .filter((a) => Number.isFinite(a.duration) && a.duration > 0)
    .sort((a, b) => b.duration - a.duration)
  return withDuration[0] ?? audios[0]
}

/** Playing <audio> with usable duration, or null (WebAudio players, streams). */
function usableAudio(): HTMLAudioElement | null {
  const a = pickAudio()
  if (a && !a.paused && !a.ended && Number.isFinite(a.duration) && a.duration > 0) {
    return a
  }
  return null
}

const CLOCK_RE = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/

/** "mm:ss" or "h:mm:ss" → seconds. Null when not a clock reading. */
function parseClock(s: string): number | null {
  const m = CLOCK_RE.exec(s.trim())
  if (!m) {
    return null
  }
  let total = Number(m[2]) * 60 + Number(m[3])
  if (m[1]) {
    total += Number(m[1]) * 3600
  }
  if (Number.isFinite(total)) {
    return total
  }
  return null
}

function validTime(elapsed: number, total: number): boolean {
  return total > 30 && elapsed >= 0 && elapsed <= total
}

/**
 * Elapsed/total seconds of the player's time counter.
 * Only stable data-testid hooks are read (CSS-module class hashes change
 * between site builds, so class selectors are forbidden).
 */
function readDomTime(): { elapsed: number; total: number } | null {
  const elapsedEl = document.querySelector('[data-testid="player-current-time"]')
  const totalEl = document.querySelector('[data-testid="player-full-time"]')
  if (!elapsedEl || !totalEl) {
    return null
  }
  const elapsed = parseClock(elapsedEl.textContent ?? '')
  const total = parseClock(totalEl.textContent ?? '')
  if (elapsed != null && total != null && validTime(elapsed, total)) {
    return { elapsed, total }
  }
  return null
}

/**
 * Best-effort send. Returns false when the extension context is gone
 * (e.g. content script orphaned by extension reload/update).
 * NOTE: `browser.runtime.sendMessage` may throw *synchronously* in that case,
 * so `.catch()` alone is not enough — hence try/catch.
 */
function postMessage(msg: ContentMessage): boolean {
  try {
    ;(browser.runtime.sendMessage(msg) as Promise<unknown>).catch(() => {
      // Background asleep — safe to ignore.
    })
    return true
  } catch {
    return false
  }
}

/** False when our extension context was destroyed (reload/update). Never throws. */
function contextAlive(): boolean {
  try {
    return browser.runtime?.id != null
  } catch {
    return false
  }
}

export default defineContentScript({
  matches: ['*://music.mts.ru/*'],
  runAt: 'document_idle',
  main() {
    let lastKey = ''
    let lastProgressSent = 0
    let alive = true
    let metaTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let audioObserver: MutationObserver | null = null
    let metaObserver: MutationObserver | null = null

    /** Stop everything: orphaned script must not throw or waste battery. */
    const shutdown = (): void => {
      if (!alive) {
        return
      }
      alive = false
      if (metaTimer) {
        clearTimeout(metaTimer)
        metaTimer = null
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      try {
        audioObserver?.disconnect()
      } catch {
        // already gone
      }
      try {
        metaObserver?.disconnect()
      } catch {
        // already gone
      }
    }

    const send = (msg: ContentMessage): void => {
      if (!alive) {
        return
      }
      if (!contextAlive() || !postMessage(msg)) {
        shutdown()
      }
    }

    const currentMeta = (): { artist: string; track: string; album?: string } | null => {
      const ms = readMediaSession()
      if (ms) {
        return ms
      }
      const title = textOf(TITLE_SELECTORS)
      const artist = textOf(ARTIST_SELECTORS)
      if (title && artist) {
        return { artist, track: title }
      }
      return readTitle()
    }

    const mediaSessionPlaying = (): boolean => {
      try {
        return navigator.mediaSession?.playbackState === 'playing'
      } catch {
        return false
      }
    }

    const announceIfChanged = (): void => {
      if (!alive) {
        return
      }
      // Gate: never announce when nothing is playing (e.g. album pages —
      // their titles look like "Artist - Track" but nobody listens to them).
      // <audio> when present, MediaSession state otherwise (covers WebAudio players).
      const audio = pickAudio()
      let playing = mediaSessionPlaying()
      if (audio) {
        playing = !audio.paused && !audio.ended
      }
      if (!playing) {
        if (lastKey !== '') {
          lastKey = ''
          send({ type: 'STOPPED' })
        }
        return
      }
      const meta = currentMeta()
      let duration: number | undefined
      if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        duration = audio.duration
      }

      if (!meta) {
        if (lastKey !== '') {
          lastKey = ''
          send({ type: 'STOPPED' })
        }
        return
      }
      // Identity excludes duration: it resolves later (NaN at first) and must
      // not trigger a second NOW_PLAYING for the same track.
      const key = `${meta.artist}|${meta.track}`
      if (key !== lastKey) {
        lastKey = key
        send({
          type: 'NOW_PLAYING',
          artist: meta.artist,
          track: meta.track,
          album: meta.album,
          duration,
        })
      }
      reportEstimated(meta)
    }

    // Fallback progress when there is no usable <audio> (e.g. WebAudio players
    // with zero media elements): time comes from the player's own DOM counter.
    // DOM updates drive this via MutationObserver + the 5s poll.
    const reportEstimated = (meta: { artist: string; track: string; album?: string }): void => {
      if (!alive) {
        return
      }
      if (usableAudio()) {
        return // precise audio path covers it
      }
      const dom = readDomTime()
      if (!dom) {
        return // no duration to measure against — nothing honest to send
      }
      const now = Date.now()
      if (now - lastProgressSent < 1000) {
        return // throttle to ~1/sec
      }
      lastProgressSent = now

      send({
        type: 'PROGRESS',
        artist: meta.artist,
        track: meta.track,
        album: meta.album,
        currentTime: dom.elapsed,
        duration: dom.total,
      })
    }

    const reportProgress = (): void => {
      if (!alive) {
        return
      }
      const audio = pickAudio()
      if (!audio || audio.paused || audio.ended) {
        return
      }
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        return
      }
      const meta = currentMeta()
      if (!meta) {
        return
      }

      const now = Date.now()
      if (now - lastProgressSent < 1000) {
        return // throttle to ~1/sec
      }
      lastProgressSent = now

      send({
        type: 'PROGRESS',
        artist: meta.artist,
        track: meta.track,
        album: meta.album,
        currentTime: audio.currentTime,
        duration: audio.duration,
      })
    }

    // Audio events — main driver, no polling needed for progress.
    const hookAudio = (audio: HTMLAudioElement): void => {
      if (audio.dataset.kionHooked === '1') {
        return
      }
      audio.dataset.kionHooked = '1'
      audio.addEventListener('play', announceIfChanged)
      audio.addEventListener('playing', announceIfChanged)
      audio.addEventListener('timeupdate', reportProgress)
      audio.addEventListener('ended', () => {
        lastProgressSent = 0
        lastKey = ''
        send({ type: 'STOPPED' })
      })
    }

    // New <audio> nodes appear on SPA navigation.
    audioObserver = new MutationObserver(() => {
      if (!alive) {
        return
      }
      for (const a of document.querySelectorAll('audio')) {
        hookAudio(a as HTMLAudioElement)
      }
      scheduleMetaCheck()
    })

    const scheduleMetaCheck = (): void => {
      if (metaTimer) {
        return
      }
      metaTimer = setTimeout(() => {
        metaTimer = null
        announceIfChanged()
      }, 500)
    }

    metaObserver = new MutationObserver(scheduleMetaCheck)

    for (const a of document.querySelectorAll('audio')) {
      hookAudio(a as HTMLAudioElement)
    }
    audioObserver.observe(document.documentElement, { childList: true, subtree: true })
    metaObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    // Safety net: cheap 5s poll. announceIfChanged gates on real playback
    // itself, so this also drives audio-less (WebAudio) players.
    pollTimer = setInterval(() => {
      if (!alive) {
        return
      }
      if (!contextAlive()) {
        shutdown()
        return
      }
      announceIfChanged()
    }, 5000)

    announceIfChanged()
  },
})
