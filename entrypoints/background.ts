import { browser } from 'wxt/browser'

import {
  LASTFM_TOKEN_EXPIRED,
  LASTFM_TOKEN_INVALID,
  LASTFM_TOKEN_UNAUTHORIZED,
  LastfmError,
  authPageUrl,
  getSession,
  getToken,
  scrobbleBatch,
  scrobbleOne,
  updateNowPlaying,
} from '../utils/lastfm'
import {
  apiKeyItem,
  apiSecretItem,
  authErrorItem,
  clearQueue,
  debugItem,
  dequeueCount,
  enqueueTracks,
  pendingAuthItem,
  queueItem,
  sessionKeyItem,
  statusItem,
  thresholdItem,
  usernameItem,
} from '../utils/storage'
import { RETRY_MINUTES } from '../utils/types'
import type { ContentMessage, DebugInfo, PopupMessage, QueuedTrack } from '../utils/types'

const RETRY_ALARM = 'kion-retry'
const AUTH_ALARM = 'kion-auth-poll'
const AUTH_INTERVAL_MIN = 0.5
/** Last.fm auth tokens expire — stop polling after this. */
const AUTH_TIMEOUT_MS = 55 * 60 * 1000

interface Current {
  key: string
  artist: string
  track: string
  album?: string
  duration?: number
  startTime: number
  scrobbled: boolean
}

let current: Current | null = null
let lastScrobbledKey = ''
let lastScrobbledAt = 0
let lastDebugAt = 0
let progressInFlight = false
let flushInFlight = false

function shortTime(): string {
  return new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Dev-only log. Stripped from production builds by the minifier. */
function debugLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log('[kion]', ...args)
  }
}

/**
 * Merge progress/attempt info for popup diagnostics (dev builds only —
 * no storage writes in production).
 */
async function mergeDebug(patch: Partial<DebugInfo>): Promise<void> {
  if (!import.meta.env.DEV) {
    return
  }
  const cur = (await debugItem.getValue()) ?? {
    artist: '',
    track: '',
    pct: 0,
    at: 0,
    lastResult: '',
    lastResultAt: 0,
  }
  await debugItem.setValue({ ...cur, ...patch })
}

async function noteResult(text: string): Promise<void> {
  await mergeDebug({ lastResult: text, lastResultAt: Math.floor(Date.now() / 1000) })
}

const ONLINE_ICON = {
  16: 'icon-16.png',
  32: 'icon-32.png',
  48: 'icon-48.png',
  128: 'icon-128.png',
}
const OFFLINE_ICON = {
  16: 'icon-offline-16.png',
  32: 'icon-offline-32.png',
  48: 'icon-offline-48.png',
  128: 'icon-offline-128.png',
}

function trackKey(artist: string, track: string): string {
  return `${artist.toLowerCase()}|${track.toLowerCase()}`
}

async function setOnline(): Promise<void> {
  try {
    await browser.action.setIcon({ path: ONLINE_ICON })
    await browser.action.setBadgeText({ text: '' })
    await statusItem.setValue('ok')
  } catch {
    // ignore (e.g. during startup)
  }
}

async function setOffline(reason: 'offline' | 'needAuth'): Promise<void> {
  try {
    await browser.action.setIcon({ path: OFFLINE_ICON })
    let badgeText = '!'
    if (reason === 'needAuth') {
      badgeText = '?'
    }
    await browser.action.setBadgeText({ text: badgeText })
    await browser.action.setBadgeBackgroundColor({ color: '#eab308' })
    await statusItem.setValue(reason)
  } catch {
    // ignore
  }
}

async function refreshIcon(): Promise<void> {
  const queue = (await queueItem.getValue()) ?? []
  const status = await statusItem.getValue()
  if (queue.length > 0 || status === 'offline' || status === 'needAuth') {
    if (status === 'needAuth') {
      await setOffline('needAuth')
    } else {
      await setOffline('offline')
    }
  } else {
    await setOnline()
  }
}

async function ensureRetryAlarm(): Promise<void> {
  const queue = (await queueItem.getValue()) ?? []
  if (queue.length === 0) {
    await browser.alarms.clear(RETRY_ALARM).catch(() => {})
    return
  }
  await browser.alarms.create(RETRY_ALARM, {
    delayInMinutes: RETRY_MINUTES,
    periodInMinutes: RETRY_MINUTES,
  })
}

async function credentials(): Promise<{ apiKey: string; secret: string; sk: string } | null> {
  const [apiKey, secret, sk] = await Promise.all([
    apiKeyItem.getValue(),
    apiSecretItem.getValue(),
    sessionKeyItem.getValue(),
  ])
  if (!apiKey || !secret || !sk) {
    return null
  }
  return { apiKey, secret, sk }
}

async function handleRetryable(items: QueuedTrack[]): Promise<void> {
  await enqueueTracks(items)
  await setOffline('offline')
  await ensureRetryAlarm()
}

async function attemptScrobble(item: QueuedTrack): Promise<void> {
  const creds = await credentials()
  if (!creds) {
    // Nothing to send with — keep in queue, mark auth needed.
    await enqueueTracks([item])
    await setOffline('needAuth')
    await noteResult('queued (need login)')
    return
  }
  try {
    await scrobbleOne(creds.apiKey, creds.secret, creds.sk, item)
    debugLog('scrobbled', item.artist, '—', item.track)
    await noteResult(`sent ${shortTime()}`)
    await refreshIcon()
  } catch (e) {
    if (e instanceof LastfmError && e.needAuth) {
      await enqueueTracks([item])
      await setOffline('needAuth')
      await noteResult('queued (need login)')
      return
    }
    if (e instanceof LastfmError && e.retryable) {
      await handleRetryable([item])
      await noteResult('queued (offline)')
      return
    }
    // Malformed/filtered — drop, do not poison the queue. Now visible via debug.
    let reason = 'unknown error'
    if (e instanceof Error) {
      reason = e.message
    }
    debugLog('scrobble dropped:', reason)
    await noteResult(`dropped: ${reason}`)
  }
}

/** Send oldest-first in batches of 50 (Last.fm limit). Module-private, runs via messages. */
async function flushQueue(): Promise<{ sent: number; left: number }> {
  // Alarm, manual sync and post-scrobble flush can overlap.
  // The flag is set synchronously, so a batch is never sent twice.
  if (flushInFlight) {
    const busyLeft = ((await queueItem.getValue()) ?? []).length
    return { sent: 0, left: busyLeft }
  }
  flushInFlight = true
  try {
    const creds = await credentials()
    if (!creds) {
      await setOffline('needAuth')
      return { sent: 0, left: ((await queueItem.getValue()) ?? []).length }
    }
    let sent = 0
    for (;;) {
      const queue = (await queueItem.getValue()) ?? []
      if (queue.length === 0) {
        break
      }
      const batch = queue.slice(0, 50)
      try {
        await scrobbleBatch(creds.apiKey, creds.secret, creds.sk, batch)
        await noteResult(`sent ${batch.length} ${shortTime()}`)
      } catch (e) {
        if (e instanceof LastfmError && e.needAuth) {
          await setOffline('needAuth')
          await noteResult('stopped (need login)')
          break
        }
        if (e instanceof LastfmError && e.retryable) {
          await setOffline('offline')
          await noteResult('stopped (offline)')
          break
        }
        // Bad batch (e.g. filtered timestamps) — drop it to avoid blocking.
        let reason = 'unknown error'
        if (e instanceof Error) {
          reason = e.message
        }
        debugLog('batch dropped:', reason)
        await noteResult(`dropped batch: ${reason}`)
        await dequeueCount(batch.length)
        continue
      }
      await dequeueCount(batch.length)
      sent += batch.length
    }
    await ensureRetryAlarm()
    await refreshIcon()
    return { sent, left: ((await queueItem.getValue()) ?? []).length }
  } finally {
    flushInFlight = false
  }
}

async function onNowPlaying(
  artist: string,
  track: string,
  album?: string,
  duration?: number,
): Promise<void> {
  const key = trackKey(artist, track)
  const now = Math.floor(Date.now() / 1000)
  // Same track re-announced (SPA re-render) — ignore.
  if (current?.key === key) {
    return
  }
  // Same track restarted right after scrobble (repeat) — allow only after cooldown.
  if (key === lastScrobbledKey && now - lastScrobbledAt < 60) {
    return
  }

  current = {
    key,
    artist,
    track,
    album,
    duration,
    startTime: now,
    scrobbled: false,
  }

  const creds = await credentials()
  if (!creds) {
    return
  }
  try {
    await updateNowPlaying(creds.apiKey, creds.secret, creds.sk, {
      artist,
      track,
      album,
      duration,
    })
  } catch {
    // Now Playing failures are never retried (per Last.fm docs).
  }
}

async function onProgress(
  artist: string,
  track: string,
  album: string | undefined,
  currentTime: number,
  duration: number,
): Promise<void> {
  // PROGRESS arrives ~1/sec and handlers overlap across awaits.
  // The flag is set synchronously, so a second tick can never double-scrobble.
  // Skipping is safe: progress is level-triggered, the next tick re-evaluates.
  if (progressInFlight) {
    return
  }
  progressInFlight = true
  try {
    if (!artist || !track || !duration || duration <= 0) {
      return
    }
    const key = trackKey(artist, track)
    if (!current || current.key !== key) {
      // Missed NOW_PLAYING (e.g. SW was asleep) — reconstruct.
      await onNowPlaying(artist, track, album, duration)
      if (!current || current.key !== key) {
        return
      }
    } else if (duration > 0) {
      current.duration = duration
    }
    if (current.scrobbled) {
      return
    }
    // Last.fm rule: tracks shorter than 30s are never scrobbled.
    if (duration < 30) {
      return
    }

    const threshold = (await thresholdItem.getValue()) ?? 50
    const pct = (currentTime / duration) * 100
    const nowMs = Date.now()
    if (nowMs - lastDebugAt > 5000 || pct >= threshold) {
      lastDebugAt = nowMs
      await mergeDebug({ artist, track, pct: Math.round(pct), at: Math.floor(nowMs / 1000) })
    }
    if (pct < threshold) {
      return
    }
    debugLog('threshold reached', artist, '—', track, `${Math.round(pct)}%`)

    current.scrobbled = true
    lastScrobbledKey = key
    lastScrobbledAt = Math.floor(Date.now() / 1000)

    const item: QueuedTrack = {
      artist,
      track,
      album: current.album,
      timestamp: current.startTime,
      duration: Math.round(duration),
    }

    const pending = (await queueItem.getValue()) ?? []
    if (pending.length > 0) {
      // Order matters: cached scrobbles go first.
      await enqueueTracks([item])
      await flushQueue()
    } else {
      await attemptScrobble(item)
    }
  } finally {
    progressInFlight = false
  }
}

async function clearAuthPoll(): Promise<void> {
  await browser.alarms.clear(AUTH_ALARM).catch(() => {})
  await pendingAuthItem.setValue(null)
}

async function abortAuth(message: string): Promise<void> {
  await clearAuthPoll()
  await authErrorItem.setValue(message)
  await refreshIcon()
}

async function cancelAuth(): Promise<void> {
  await clearAuthPoll()
  await authErrorItem.setValue('')
  await refreshIcon()
}

/** Starts browser auth: issues a token, opens the approval page, polls in background. */
async function startAuth(): Promise<void> {
  const [apiKey, secret] = await Promise.all([apiKeyItem.getValue(), apiSecretItem.getValue()])
  if (!apiKey || !secret) {
    await authErrorItem.setValue('Введите API key и Shared secret (last.fm/api/account).')
    return
  }
  const prev = await pendingAuthItem.getValue()
  if (prev?.tabId != null) {
    await browser.tabs.remove(prev.tabId).catch(() => {})
  }
  await clearAuthPoll()
  await authErrorItem.setValue('')
  let token: string
  try {
    token = await getToken(apiKey, secret)
  } catch (e) {
    if (e instanceof Error) {
      await authErrorItem.setValue(e.message)
    } else {
      await authErrorItem.setValue('Не удалось получить токен')
    }
    return
  }
  let tabId: number | undefined
  try {
    const tab = await browser.tabs.create({ url: authPageUrl(apiKey, token), active: true })
    tabId = tab.id
  } catch {
    tabId = undefined
  }
  await pendingAuthItem.setValue({ token, tabId, startedAt: Date.now() })
  await browser.alarms.create(AUTH_ALARM, {
    delayInMinutes: AUTH_INTERVAL_MIN,
    periodInMinutes: AUTH_INTERVAL_MIN,
  })
}

/**
 * Single getSession attempt. Returns true when auth completed (or aborted),
 * false when still waiting for user approval.
 */
async function tryCompleteAuth(): Promise<boolean> {
  const pending = await pendingAuthItem.getValue()
  if (!pending) {
    return true
  }
  if (Date.now() - pending.startedAt > AUTH_TIMEOUT_MS) {
    await abortAuth('Время ожидания истекло. Нажмите «Войти через браузер» ещё раз.')
    return true
  }
  const [apiKey, secret] = await Promise.all([apiKeyItem.getValue(), apiSecretItem.getValue()])
  if (!apiKey || !secret) {
    await abortAuth('API key или Shared secret пропали. Введите их заново.')
    return true
  }
  try {
    const session = await getSession(apiKey, secret, pending.token)
    await sessionKeyItem.setValue(session.key)
    await usernameItem.setValue(session.name)
    await clearAuthPoll()
    await authErrorItem.setValue('')
    await statusItem.setValue('ok')
    if (pending.tabId != null) {
      await browser.tabs.remove(pending.tabId).catch(() => {})
    }
    await refreshIcon()
    await flushQueue().catch(() => {})
    return true
  } catch (e) {
    if (e instanceof LastfmError && e.code === LASTFM_TOKEN_UNAUTHORIZED) {
      // not approved yet — keep waiting
      return false
    }
    if (
      e instanceof LastfmError &&
      (e.code === LASTFM_TOKEN_INVALID || e.code === LASTFM_TOKEN_EXPIRED)
    ) {
      await abortAuth('Токен недействителен. Нажмите «Войти через браузер» ещё раз.')
      return true
    }
    if (e instanceof LastfmError && e.retryable) {
      // transient network — keep waiting
      return false
    }
    if (e instanceof Error) {
      await abortAuth(e.message)
    } else {
      await abortAuth('Не удалось завершить вход')
    }
    return true
  }
}

async function resumeAuthPoll(): Promise<void> {
  const pending = await pendingAuthItem.getValue()
  if (!pending) {
    return
  }
  if (Date.now() - pending.startedAt > AUTH_TIMEOUT_MS) {
    await abortAuth('Время ожидания истекло. Нажмите «Войти через браузер» ещё раз.')
    return
  }
  await browser.alarms.create(AUTH_ALARM, {
    delayInMinutes: AUTH_INTERVAL_MIN,
    periodInMinutes: AUTH_INTERVAL_MIN,
  })
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: ContentMessage | PopupMessage) => {
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      return false
    }

    if (msg.type === 'NOW_PLAYING') {
      return onNowPlaying(msg.artist, msg.track, msg.album, msg.duration).then(() => false)
    }
    if (msg.type === 'PROGRESS') {
      return onProgress(msg.artist, msg.track, msg.album, msg.currentTime, msg.duration).then(
        () => false,
      )
    }
    if (msg.type === 'STOPPED') {
      current = null
      return false
    }
    if (msg.type === 'SYNC_NOW') {
      return flushQueue().then(() => false)
    }
    if (msg.type === 'CLEAR_QUEUE') {
      return clearQueue()
        .then(() => ensureRetryAlarm())
        .then(() => refreshIcon())
        .then(() => false)
    }
    if (msg.type === 'SETTINGS_CHANGED') {
      // Wake-up + icon resync (threshold applies on next PROGRESS automatically).
      return refreshIcon().then(() => false)
    }
    if (msg.type === 'AUTH_START') {
      return startAuth().then(() => false)
    }
    if (msg.type === 'AUTH_CHECK_NOW') {
      return tryCompleteAuth().then(() => false)
    }
    if (msg.type === 'AUTH_CANCEL') {
      return cancelAuth().then(() => false)
    }
    return false
  })

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) {
      void flushQueue()
    }
    if (alarm.name === AUTH_ALARM) {
      void tryCompleteAuth()
    }
  })

  // User closed the approval tab — stop polling silently.
  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const pending = await pendingAuthItem.getValue()
      if (pending?.tabId === tabId) {
        await cancelAuth()
      }
    })()
  })

  browser.runtime.onStartup.addListener(() => {
    void ensureRetryAlarm().then(() => refreshIcon())
    void resumeAuthPoll()
  })
  browser.runtime.onInstalled.addListener(() => {
    void ensureRetryAlarm().then(() => refreshIcon())
  })
})
