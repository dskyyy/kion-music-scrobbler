import { storage } from 'wxt/utils/storage'

import { DEFAULT_THRESHOLD, MAX_QUEUE } from './types'
import type { ConnStatus, DebugInfo, PendingAuth, QueuedTrack } from './types'

export const thresholdItem = storage.defineItem<number>('local:threshold', {
  defaultValue: DEFAULT_THRESHOLD,
})

export const apiKeyItem = storage.defineItem<string>('local:apiKey', { defaultValue: '' })
export const apiSecretItem = storage.defineItem<string>('local:apiSecret', {
  defaultValue: '',
})
export const sessionKeyItem = storage.defineItem<string>('local:sessionKey', {
  defaultValue: '',
})
export const usernameItem = storage.defineItem<string>('local:username', { defaultValue: '' })
export const queueItem = storage.defineItem<QueuedTrack[]>('local:queue', {
  defaultValue: [],
})
export const statusItem = storage.defineItem<ConnStatus>('local:connStatus', {
  defaultValue: 'idle',
})
/** In-progress browser auth (token issued, approval pending on last.fm). */
export const pendingAuthItem = storage.defineItem<PendingAuth | null>('local:pendingAuth', {
  defaultValue: null,
})
/** Last auth failure text shown in the popup. Empty = no error. */
export const authErrorItem = storage.defineItem<string>('local:authError', {
  defaultValue: '',
})
/** Last scrobble progress/attempt for popup diagnostics. */
export const debugItem = storage.defineItem<DebugInfo | null>('local:debug', {
  defaultValue: null,
})
/** Artist names the user does not want scrobbled. Raw strings for display. */
export const blockedArtistsItem = storage.defineItem<string[]>('local:blockedArtists', {
  defaultValue: [],
})

/** Append tracks to the offline queue, FIFO cap 1000 (drop oldest). */
export async function enqueueTracks(items: QueuedTrack[]): Promise<QueuedTrack[]> {
  const current = (await queueItem.getValue()) ?? []
  const merged = [...current, ...items].filter((t) => t.artist && t.track)
  const capped = merged.slice(-MAX_QUEUE)
  await queueItem.setValue(capped)
  return capped
}

/** Remove first `count` tracks after successful batch sync. */
export async function dequeueCount(count: number): Promise<QueuedTrack[]> {
  const current = (await queueItem.getValue()) ?? []
  const rest = current.slice(count)
  await queueItem.setValue(rest)
  return rest
}

export async function clearQueue(): Promise<void> {
  await queueItem.setValue([])
}

const MAX_BLOCKED_NAME_LEN = 256
const MAX_BLOCKED_COUNT = 500

/**
 * Single normalization for both sides of the blocklist comparison:
 * trim, lowercase, collapse inner whitespace. Null when empty.
 */
export function normalizeArtistName(name: unknown): string | null {
  if (typeof name !== 'string') {
    return null
  }
  const collapsed = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!collapsed) {
    return null
  }
  return collapsed
}

/**
 * Blocklist match: the normalized artist string contains a normalized entry.
 * Both sides share normalizeArtistName. Empty entries never match.
 * Entries shorter than 2 chars fall back to exact match (an "x" must not
 * block every artist containing that letter).
 */
export function isArtistBlocked(artist: unknown, blocked: string[]): boolean {
  const normalized = normalizeArtistName(artist)
  if (!normalized) {
    return false
  }
  for (const entry of blocked) {
    const needle = normalizeArtistName(entry)
    if (!needle) {
      continue
    }
    if (needle === normalized) {
      return true
    }
    if (needle.length >= 2 && normalized.includes(needle)) {
      return true
    }
  }
  return false
}

/** Add an artist to the blocklist. Duplicates/empty/over-cap are ignored. */
export async function addBlockedArtist(name: string): Promise<string[]> {
  const normalized = normalizeArtistName(name)
  if (!normalized) {
    return (await blockedArtistsItem.getValue()) ?? []
  }
  const current = (await blockedArtistsItem.getValue()) ?? []
  for (const entry of current) {
    if (normalizeArtistName(entry) === normalized) {
      return current
    }
  }
  if (current.length >= MAX_BLOCKED_COUNT) {
    return current
  }
  let raw = name.trim()
  if (raw.length > MAX_BLOCKED_NAME_LEN) {
    raw = raw.slice(0, MAX_BLOCKED_NAME_LEN)
  }
  const next = [...current, raw]
  await blockedArtistsItem.setValue(next)
  return next
}

/** Remove an artist from the blocklist (normalized comparison). */
export async function removeBlockedArtist(name: string): Promise<string[]> {
  const normalized = normalizeArtistName(name)
  if (!normalized) {
    return (await blockedArtistsItem.getValue()) ?? []
  }
  const current = (await blockedArtistsItem.getValue()) ?? []
  const next = current.filter((entry) => normalizeArtistName(entry) !== normalized)
  if (next.length !== current.length) {
    await blockedArtistsItem.setValue(next)
  }
  return next
}
