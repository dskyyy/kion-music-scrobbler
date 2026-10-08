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
  blockedArtistsItem,
  clearQueue,
  debugItem,
  dequeueCount,
  enqueueTracks,
  isArtistBlocked,
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
  lastCurrentTime?: number
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

/** Dev-only log with track names. Stripped from production builds by the minifier. */
function debugLog(...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log('[kion-music-scrobbler]', ...args)
  }
}

/**
 * Production worker log: codes/counters only, never track names.
 * Always kept in the bundle. PROGRESS ticks are never logged here.
 */
function logInfo(event: string, details?: unknown): void {
  if (details === undefined) {
    console.info('[kion-music-scrobbler]', event)
  } else {
    console.info('[kion-music-scrobbler]', event, details)
  }
}

function logWarn(event: string, details?: unknown): void {
  if (details === undefined) {
    console.warn('[kion-music-scrobbler]', event)
  } else {
    console.warn('[kion-music-scrobbler]', event, details)
  }
}

function logError(event: string, details?: unknown): void {
  if (details === undefined) {
    console.error('[kion-music-scrobbler]', event)
  } else {
    console.error('[kion-music-scrobbler]', event, details)
  }
}

let lastToolbarWarnAt = 0

function noteToolbarFailure(stage: string): void {
  const now = Date.now()
  if (now - lastToolbarWarnAt < 60000) {
    return
  }
  lastToolbarWarnAt = now
  logWarn('toolbar failed', stage)
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

const MAX_TEXT_LEN = 256
const MAX_DURATION_SEC = 12 * 3600
const MAX_TRACK_AGE_SEC = 30 * 24 * 3600

let lastInvalidWarnAt = 0

function noteInvalid(reason: string): void {
  const now = Date.now()
  if (now - lastInvalidWarnAt < 60000) {
    return
  }
  lastInvalidWarnAt = now
  logWarn('drop invalid input', reason)
}

let lastFilterLogAt = 0

/** Filter skip: logs the artist name, throttled to one line per minute. */
function noteFiltered(artist: string): void {
  const now = Date.now()
  if (now - lastFilterLogAt < 60000) {
    return
  }
  lastFilterLogAt = now
  logInfo(`${artist} skipped by filter`)
}

async function isBlockedArtist(artist: string): Promise<boolean> {
  const blocked = (await blockedArtistsItem.getValue()) ?? []
  if (blocked.length === 0) {
    return false
  }
  return isArtistBlocked(artist, blocked)
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const cleaned = value.trim().replace(/[\u0000-\u001F\u007F]/g, '')
  if (!cleaned) {
    return null
  }
  if (cleaned.length > MAX_TEXT_LEN) {
    return cleaned.slice(0, MAX_TEXT_LEN)
  }
  return cleaned
}

function sanitizeMeta(
  artist: unknown,
  track: unknown,
  album?: unknown,
): { artist: string; track: string; album?: string } | null {
  const a = cleanText(artist)
  const t = cleanText(track)
  if (!a || !t) {
    return null
  }
  if (album === undefined) {
    return { artist: a, track: t }
  }
  const al = cleanText(album)
  if (al) {
    return { artist: a, track: t, album: al }
  }
  return { artist: a, track: t }
}

function sanitizeTimes(
  currentTime: unknown,
  duration: unknown,
): { currentTime: number; duration: number } | null {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) {
    return null
  }
  const ct = currentTime as number
  const d = duration as number
  if (d <= 0 || d > MAX_DURATION_SEC) {
    return null
  }
  if (ct < 0 || ct > d) {
    return null
  }
  return { currentTime: ct, duration: d }
}

function sanitizeTimestamp(ts: unknown): number | null {
  if (!Number.isFinite(ts)) {
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  let value = Math.floor(ts as number)
  if (value > now + 60) {
    value = now
  }
  if (value < now - MAX_TRACK_AGE_SEC) {
    return null
  }
  return value
}

type ToolbarApi = typeof browser.action

function toolbar(): ToolbarApi {
  const withAction = browser as unknown as {
    action?: ToolbarApi
    browserAction?: ToolbarApi
  }
  if (withAction.action) {
    return withAction.action
  }
  return withAction.browserAction as ToolbarApi
}

function countSuffix(count: number): string {
  if (count > 99) {
    return '99+'
  }
  return String(count)
}

function badgeTextFor(count: number, reason: 'offline' | 'needAuth' | 'ok'): string {
  if (reason === 'ok') {
    return ''
  }
  if (reason === 'needAuth') {
    if (count > 0) {
      return `?${countSuffix(count)}`
    }
    return '?'
  }
  if (count > 0) {
    return countSuffix(count)
  }
  return '!'
}

async function setOnline(): Promise<void> {
  try {
    const api = toolbar()
    await api.setIcon({ path: ONLINE_ICON })
    await api.setBadgeText({ text: '' })
    await statusItem.setValue('ok')
  } catch {
    noteToolbarFailure('online')
  }
}

async function setOffline(reason: 'offline' | 'needAuth', queueCount = 0): Promise<void> {
  try {
    const api = toolbar()
    await api.setIcon({ path: OFFLINE_ICON })
    await api.setBadgeText({ text: badgeTextFor(queueCount, reason) })
    await api.setBadgeBackgroundColor({ color: '#eab308' })
    await statusItem.setValue(reason)
  } catch {
    noteToolbarFailure(reason)
  }
}

async function markOnlineIfDrained(): Promise<void> {
  const queue = (await queueItem.getValue()) ?? []
  if (queue.length === 0) {
    await setOnline()
  } else {
    await refreshIcon()
  }
}

async function refreshIcon(): Promise<void> {
  const queue = (await queueItem.getValue()) ?? []
  const count = queue.length
  const creds = await credentials()
  if (!creds) {
    await setOffline('needAuth', count)
    return
  }
  const status = await statusItem.getValue()
  if (count > 0 || status === 'offline' || status === 'needAuth') {
    if (status === 'needAuth') {
      await setOffline('needAuth', count)
    } else {
      await setOffline('offline', count)
    }
    return
  }
  await setOnline()
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

async function handleRetryable(items: QueuedTrack[]): Promise<QueuedTrack[]> {
  const queue = await enqueueTracks(items)
  await setOffline('offline', queue.length)
  await ensureRetryAlarm()
  return queue
}

async function attemptScrobble(item: QueuedTrack): Promise<void> {
  const creds = await credentials()
  if (!creds) {
    // Nothing to send with — keep in queue, mark auth needed.
    const queue = await enqueueTracks([item])
    await setOffline('needAuth', queue.length)
    logWarn('queued (need login)', { left: queue.length })
    await noteResult('queued (need login)')
    return
  }
  try {
    await scrobbleOne(creds.apiKey, creds.secret, creds.sk, item)
    debugLog('scrobbled', item.artist, '—', item.track)
    await noteResult(`sent ${shortTime()}`)
    await markOnlineIfDrained()
  } catch (e) {
    if (e instanceof LastfmError && e.needAuth) {
      const queue = await enqueueTracks([item])
      await setOffline('needAuth', queue.length)
      logWarn('queued (need login)', { left: queue.length })
      await noteResult('queued (need login)')
      return
    }
    if (e instanceof LastfmError && e.retryable) {
      const queue = await handleRetryable([item])
      logWarn('queued (offline)', { left: queue.length })
      await noteResult('queued (offline)')
      return
    }
    // Malformed/filtered — drop, do not poison the queue. Now visible via debug.
    let reason = 'unknown error'
    if (e instanceof Error) {
      reason = e.message
    }
    debugLog('scrobble dropped:', reason)
    logWarn('scrobble dropped', reason)
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
      const left = ((await queueItem.getValue()) ?? []).length
      await setOffline('needAuth', left)
      return { sent: 0, left }
    }
    let sent = 0
    let stoppedAuth = false
    let stoppedOffline = false
    for (;;) {
      const queue = (await queueItem.getValue()) ?? []
      if (queue.length === 0) {
        break
      }
      const batch = queue.slice(0, 50)
      try {
        const result = await scrobbleBatch(creds.apiKey, creds.secret, creds.sk, batch)
        sent += result.accepted
        await noteResult(`sent ${result.accepted} (ignored ${result.ignored}) ${shortTime()}`)
      } catch (e) {
        if (e instanceof LastfmError && e.needAuth) {
          stoppedAuth = true
          await noteResult('stopped (need login)')
          break
        }
        if (e instanceof LastfmError && e.retryable) {
          stoppedOffline = true
          await noteResult('stopped (offline)')
          break
        }
        // Bad batch (e.g. filtered timestamps) — drop it to avoid blocking.
        let reason = 'unknown error'
        if (e instanceof Error) {
          reason = e.message
        }
        debugLog('batch dropped:', reason)
        logWarn('batch dropped', reason)
        await noteResult(`dropped batch: ${reason}`)
        await dequeueCount(batch.length)
        continue
      }
      await dequeueCount(batch.length)
    }
    await ensureRetryAlarm()
    const left = ((await queueItem.getValue()) ?? []).length
    if (stoppedAuth) {
      await setOffline('needAuth', left)
      logWarn('flush stopped (need login)', { sent, left })
    } else if (stoppedOffline) {
      await setOffline('offline', left)
      logWarn('flush stopped (offline)', { sent, left })
    } else if (left === 0) {
      await setOnline()
      if (sent > 0) {
        logInfo('flush done', { sent, left })
      }
    } else {
      await refreshIcon()
      logInfo('flush done', { sent, left })
    }
    return { sent, left }
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
  const meta = sanitizeMeta(artist, track, album)
  if (!meta) {
    noteInvalid('bad meta')
    return
  }
  let cleanDuration: number | undefined
  if (duration !== undefined) {
    if (!Number.isFinite(duration)) {
      noteInvalid('bad duration')
      return
    }
    const d = duration as number
    if (d <= 0 || d > MAX_DURATION_SEC) {
      noteInvalid('bad duration')
      return
    }
    cleanDuration = d
  }
  const key = trackKey(meta.artist, meta.track)
  const now = Math.floor(Date.now() / 1000)
  // User blocklist: skip entirely, never send Now Playing.
  if (await isBlockedArtist(meta.artist)) {
    current = null
    debugLog('skipped by filter', meta.artist, '—', meta.track)
    noteFiltered(meta.artist)
    return
  }
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
    artist: meta.artist,
    track: meta.track,
    album: meta.album,
    duration: cleanDuration,
    startTime: now,
    scrobbled: false,
  }

  const creds = await credentials()
  if (!creds) {
    return
  }
  try {
    await updateNowPlaying(creds.apiKey, creds.secret, creds.sk, {
      artist: meta.artist,
      track: meta.track,
      album: meta.album,
      duration: cleanDuration,
    })
  } catch (e) {
    // Now Playing failures are never retried (per Last.fm docs).
    if (e instanceof LastfmError) {
      logWarn('now-playing failed', { code: e.code })
    } else {
      logWarn('now-playing failed', 'unknown')
    }
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
    const meta = sanitizeMeta(artist, track, album)
    const times = sanitizeTimes(currentTime, duration)
    if (!meta || !times) {
      noteInvalid('bad progress')
      return
    }
    const cleanTime = times.currentTime
    const cleanDuration = times.duration
    const key = trackKey(meta.artist, meta.track)
    if (await isBlockedArtist(meta.artist)) {
      debugLog('skipped by filter', meta.artist, '—', meta.track)
      noteFiltered(meta.artist)
      return
    }
    if (!current || current.key !== key) {
      // Missed NOW_PLAYING (e.g. SW was asleep) — reconstruct.
      await onNowPlaying(meta.artist, meta.track, meta.album, cleanDuration)
      if (!current || current.key !== key) {
        return
      }
      // Honest start: backdate by the already-played part.
      const nowSec = Math.floor(Date.now() / 1000)
      const backdated = nowSec - Math.floor(cleanTime)
      if (backdated >= 0) {
        current.startTime = backdated
      }
    } else if (cleanDuration > 0) {
      current.duration = cleanDuration
    }
    // Repeat-one without STOPPED: time rolled back — treat as a new pass.
    const prevTime = current.lastCurrentTime ?? cleanTime
    if (current.key === key && cleanTime < prevTime - 5) {
      const nowSec = Math.floor(Date.now() / 1000)
      const restarted = nowSec - Math.floor(cleanTime)
      if (restarted >= 0) {
        current.startTime = restarted
      }
      current.scrobbled = false
      lastScrobbledKey = ''
    }
    current.lastCurrentTime = cleanTime
    if (current.scrobbled) {
      return
    }
    // Last.fm rule: tracks shorter than 30s are never scrobbled.
    if (cleanDuration < 30) {
      return
    }

    let threshold = (await thresholdItem.getValue()) ?? 50
    if (threshold < 10) {
      threshold = 10
    }
    if (threshold > 100) {
      threshold = 100
    }
    const pct = (cleanTime / cleanDuration) * 100
    const nowMs = Date.now()
    if (nowMs - lastDebugAt > 5000 || pct >= threshold) {
      lastDebugAt = nowMs
      await mergeDebug({
        artist: meta.artist,
        track: meta.track,
        pct: Math.round(pct),
        at: Math.floor(nowMs / 1000),
      })
    }
    if (pct < threshold) {
      return
    }
    debugLog('threshold reached', meta.artist, '—', meta.track, `${Math.round(pct)}%`)

    current.scrobbled = true
    lastScrobbledKey = key
    lastScrobbledAt = Math.floor(Date.now() / 1000)

    const timestamp = sanitizeTimestamp(current.startTime)
    if (timestamp === null) {
      noteInvalid('stale timestamp')
      return
    }
    const item: QueuedTrack = {
      artist: meta.artist,
      track: meta.track,
      album: current.album,
      timestamp,
      duration: Math.round(cleanDuration),
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
    if (e instanceof LastfmError) {
      await authErrorItem.setValue(e.message)
      logError('auth token failed', { code: e.code })
    } else if (e instanceof Error) {
      await authErrorItem.setValue(e.message)
      logError('auth token failed', 'unknown')
    } else {
      await authErrorItem.setValue('Не удалось получить токен')
      logError('auth token failed', 'unknown')
    }
    return
  }
  let tabId: number | undefined
  try {
    const tab = await browser.tabs.create({ url: authPageUrl(apiKey, token), active: true })
    tabId = tab.id
  } catch {
    tabId = undefined
    logWarn('auth tab open failed')
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
      await browser.tabs.remove(pending.tabId).catch(() => {
        logWarn('auth tab close failed')
      })
    }
    await refreshIcon()
    logInfo('auth completed')
    await flushQueue().catch(() => {
      logWarn('flush after auth failed')
    })
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
      logWarn('auth aborted', { code: e.code })
      return true
    }
    if (e instanceof LastfmError && e.retryable) {
      // transient network — keep waiting
      return false
    }
    if (e instanceof LastfmError) {
      await abortAuth(e.message)
      logError('auth failed', { code: e.code })
    } else if (e instanceof Error) {
      await abortAuth(e.message)
      logError('auth failed', 'unknown')
    } else {
      await abortAuth('Не удалось завершить вход')
      logError('auth failed', 'unknown')
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
      if (typeof msg.artist !== 'string' || typeof msg.track !== 'string') {
        noteInvalid('bad message shape')
        return false
      }
      return onNowPlaying(msg.artist, msg.track, msg.album, msg.duration).then(() => false)
    }
    if (msg.type === 'PROGRESS') {
      if (
        typeof msg.artist !== 'string' ||
        typeof msg.track !== 'string' ||
        typeof msg.currentTime !== 'number' ||
        typeof msg.duration !== 'number'
      ) {
        noteInvalid('bad message shape')
        return false
      }
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
      void flushQueue().catch((e: unknown) => {
        if (e instanceof Error) {
          logWarn('alarm flush failed', e.message)
        } else {
          logWarn('alarm flush failed', 'unknown')
        }
      })
    }
    if (alarm.name === AUTH_ALARM) {
      void tryCompleteAuth().catch(() => {
        logWarn('auth poll failed')
      })
    }
  })

  // User closed the approval tab — stop polling silently.
  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const pending = await pendingAuthItem.getValue()
      if (pending?.tabId === tabId) {
        await cancelAuth()
      }
    })().catch(() => {
      logWarn('auth cancel on tab close failed')
    })
  })

  browser.runtime.onStartup.addListener(() => {
    logInfo('startup')
    void ensureRetryAlarm().then(() => refreshIcon())
    void flushQueue().catch(() => {
      logWarn('startup flush failed')
    })
    void resumeAuthPoll()
  })
  browser.runtime.onInstalled.addListener(() => {
    logInfo('installed')
    void ensureRetryAlarm().then(() => refreshIcon())
    void flushQueue().catch(() => {
      logWarn('startup flush failed')
    })
  })
})
