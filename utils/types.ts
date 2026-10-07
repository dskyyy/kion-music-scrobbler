/** Track queued for scrobbling when Last.fm API is unavailable. */
export interface QueuedTrack {
  artist: string
  track: string
  album?: string
  /** Unix seconds, start of listening (Last.fm requires timestamp of scrobble). */
  timestamp: number
  duration?: number
}

export type ConnStatus = 'idle' | 'ok' | 'offline' | 'needAuth'

/** Messages from content-script (music.mts.ru) to background. */
export type ContentMessage =
  | {
      type: 'NOW_PLAYING'
      artist: string
      track: string
      album?: string
      duration?: number
    }
  | {
      type: 'PROGRESS'
      artist: string
      track: string
      album?: string
      currentTime: number
      duration: number
    }
  | { type: 'STOPPED' }

/** Messages from popup to background. */
export type PopupMessage =
  | { type: 'SYNC_NOW' }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'SETTINGS_CHANGED' }
  | { type: 'AUTH_START' }
  | { type: 'AUTH_CHECK_NOW' }
  | { type: 'AUTH_CANCEL' }

/** In-progress browser auth: token issued, waiting for user approval on last.fm. */
export interface PendingAuth {
  token: string
  tabId?: number
  startedAt: number
}

/** Last observed scrobble progress/attempt, shown in the popup for diagnostics. */
export interface DebugInfo {
  artist: string
  track: string
  /** Last seen playback percent (0-100). */
  pct: number
  /** Unix seconds of the last progress update. */
  at: number
  /** Human-readable last attempt outcome, e.g. "sent 14:32". Empty = none yet. */
  lastResult: string
  /** Unix seconds of the last attempt. 0 = none yet. */
  lastResultAt: number
}

export const MAX_QUEUE = 1000
export const DEFAULT_THRESHOLD = 50
export const RETRY_MINUTES = 5
