const MAX_TEXT_LEN = 256
export const MAX_DURATION_SEC = 12 * 3600
const MAX_TRACK_AGE_SEC = 30 * 24 * 3600

export function trackKey(artist: string, track: string): string {
  return `${artist.toLowerCase()}|${track.toLowerCase()}`
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const cleaned = value
    .trim()
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      if (code <= 31 || code === 127) {
        return false
      }
      return true
    })
    .join('')
  if (!cleaned) {
    return null
  }
  if (cleaned.length > MAX_TEXT_LEN) {
    return cleaned.slice(0, MAX_TEXT_LEN)
  }
  return cleaned
}

export function sanitizeMeta(
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

export function sanitizeTimes(
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

export function sanitizeTimestamp(ts: unknown): number | null {
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
