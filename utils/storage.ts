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
