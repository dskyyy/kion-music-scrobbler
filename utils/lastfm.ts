import md5 from 'blueimp-md5'

import type { QueuedTrack } from './types'

const API_URL = 'https://ws.audioscrobbler.com/2.0/'
const AUTH_URL = 'https://www.last.fm/api/auth/'

/** Last.fm API error codes handled explicitly. See https://www.last.fm/api/errorcodes */
export const LASTFM_TOKEN_INVALID = 4
export const LASTFM_INVALID_SESSION = 9
export const LASTFM_SERVICE_OFFLINE = 11
export const LASTFM_TOKEN_UNAUTHORIZED = 14
export const LASTFM_TOKEN_EXPIRED = 15
export const LASTFM_TEMPORARY_ERROR = 16
export const LASTFM_RATE_LIMITED = 29

export class LastfmError extends Error {
  code: number | 'network'
  /** True for service offline / temporary errors -> must be queued and retried. */
  retryable: boolean
  /** True for invalid session key -> user must re-auth. */
  needAuth: boolean

  constructor(code: number | 'network', message: string) {
    super(message)
    this.code = code
    this.retryable =
      code === 'network' ||
      code === LASTFM_SERVICE_OFFLINE ||
      code === LASTFM_TEMPORARY_ERROR ||
      code === LASTFM_RATE_LIMITED
    this.needAuth = code === LASTFM_INVALID_SESSION
  }
}

type Params = Record<string, string>

/**
 * Last.fm api_sig: md5 of sorted key-value pairs + secret.
 * `format` is excluded from the signature (added afterwards).
 */
export function sign(params: Params, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'format')
    .sort()
  const base = keys.map((k) => `${k}${params[k]}`).join('') + secret
  return md5(base)
}

interface JsonError {
  error?: number
  message?: string
}

async function post(
  method: string,
  fields: Params,
  apiKey: string,
  secret: string,
  sessionKey?: string,
): Promise<unknown> {
  const params: Params = { ...fields, method, api_key: apiKey }
  if (sessionKey) {
    params.sk = sessionKey
  }
  params.api_sig = sign(params, secret)

  const body = new URLSearchParams({ ...params, format: 'json' })

  let res: Response
  try {
    res = await fetch(API_URL, { method: 'POST', body })
  } catch (e) {
    if (e instanceof Error) {
      throw new LastfmError('network', e.message)
    } else {
      throw new LastfmError('network', 'network error')
    }
  }

  let json: JsonError & Record<string, unknown>
  try {
    json = (await res.json()) as typeof json
  } catch {
    if (!res.ok) {
      throw new LastfmError('network', `HTTP ${res.status}`)
    }
    return {}
  }

  if (typeof json.error !== 'undefined' && json.error !== 0) {
    throw new LastfmError(json.error as number, (json.message as string) ?? 'last.fm error')
  }
  return json
}

export function authPageUrl(apiKey: string, token: string): string {
  return `${AUTH_URL}?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`
}

export async function getToken(apiKey: string, secret: string): Promise<string> {
  const json = (await post('auth.getToken', {}, apiKey, secret)) as { token?: string }
  if (!json.token) {
    throw new Error('No token in auth.getToken response')
  }
  return json.token
}

export async function getSession(
  apiKey: string,
  secret: string,
  token: string,
): Promise<{ key: string; name: string }> {
  const json = (await post('auth.getSession', { token }, apiKey, secret)) as {
    session?: { key: string; name: string }
  }
  if (!json.session?.key) {
    throw new Error('No session in auth.getSession response')
  }
  return { key: json.session.key, name: json.session.name }
}

export interface NowPlayingInput {
  artist: string
  track: string
  album?: string
  duration?: number
}

export async function updateNowPlaying(
  apiKey: string,
  secret: string,
  sessionKey: string,
  input: NowPlayingInput,
): Promise<void> {
  const fields: Params = { artist: input.artist, track: input.track }
  if (input.album) {
    fields.album = input.album
  }
  if (input.duration && input.duration > 0) {
    fields.duration = String(Math.round(input.duration))
  }
  await post('track.updateNowPlaying', fields, apiKey, secret, sessionKey)
}

export interface ScrobbleResult {
  accepted: number
  ignored: number
}

function parseScrobbleResult(json: unknown): ScrobbleResult {
  const attr = (json as { scrobbles?: { '@attr'?: { accepted?: string; ignored?: string } } })
    ?.scrobbles?.['@attr']
  return { accepted: Number(attr?.accepted ?? 1), ignored: Number(attr?.ignored ?? 0) }
}

async function sendScrobbleFields(
  apiKey: string,
  secret: string,
  sessionKey: string,
  fields: Params,
): Promise<ScrobbleResult> {
  const json = await post('track.scrobble', fields, apiKey, secret, sessionKey)
  const result = parseScrobbleResult(json)
  if (result.accepted === 0 && result.ignored > 0) {
    // Not an error for retry purposes — Last.fm filtered it permanently.
    throw new LastfmError(0, `Last.fm ignored the scrobble (filtered)`)
  }
  return result
}

/** Single scrobble with plain (non-indexed) params. */
export async function scrobbleOne(
  apiKey: string,
  secret: string,
  sessionKey: string,
  item: QueuedTrack,
): Promise<ScrobbleResult> {
  const fields: Params = {
    artist: item.artist,
    track: item.track,
    timestamp: String(item.timestamp),
  }
  if (item.album) {
    fields.album = item.album
  }
  if (item.duration && item.duration > 0) {
    fields.duration = String(Math.round(item.duration))
  }
  return sendScrobbleFields(apiKey, secret, sessionKey, fields)
}

/** Batch up to 50 scrobbles per request (Last.fm limit), indexed params. */
export async function scrobbleBatch(
  apiKey: string,
  secret: string,
  sessionKey: string,
  items: QueuedTrack[],
): Promise<ScrobbleResult> {
  const batch = items.slice(0, 50)
  const fields: Params = {}
  batch.forEach((t, i) => {
    fields[`artist[${i}]`] = t.artist
    fields[`track[${i}]`] = t.track
    fields[`timestamp[${i}]`] = String(t.timestamp)
    if (t.album) {
      fields[`album[${i}]`] = t.album
    }
    if (t.duration && t.duration > 0) {
      fields[`duration[${i}]`] = String(Math.round(t.duration))
    }
  })
  return sendScrobbleFields(apiKey, secret, sessionKey, fields)
}
