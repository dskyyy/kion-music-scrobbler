import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanText,
  sanitizeMeta,
  sanitizeTimes,
  sanitizeTimestamp,
  trackKey,
} from '../../utils/validation'

const FIXED_NOW_MS = new Date('2026-10-08T12:00:00Z').getTime()
const FIXED_NOW = Math.floor(FIXED_NOW_MS / 1000)
const DAY = 24 * 3600

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW_MS)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('trackKey', () => {
  it('lowercases both sides', () => {
    expect(trackKey('WildWAYS', 'Song')).toBe('wildways|song')
  })

  it('distinguishes different tracks', () => {
    expect(trackKey('a', 'b')).not.toBe(trackKey('a', 'c'))
  })
})

describe('cleanText', () => {
  it('trims surrounding whitespace', () => {
    expect(cleanText('  Wildways  ')).toBe('Wildways')
  })

  it('strips control characters', () => {
    const dirty = `a${String.fromCharCode(0)}b${String.fromCharCode(31)}c${String.fromCharCode(127)}`
    expect(cleanText(dirty)).toBe('abc')
  })

  it('returns null for non-strings and blanks', () => {
    expect(cleanText(42)).toBeNull()
    expect(cleanText(null)).toBeNull()
    expect(cleanText('')).toBeNull()
    expect(cleanText('   ')).toBeNull()
  })

  it('truncates to 256 chars', () => {
    expect(cleanText('x'.repeat(300))).toHaveLength(256)
  })
})

describe('sanitizeMeta', () => {
  it('accepts a valid pair', () => {
    expect(sanitizeMeta('a', 't')).toEqual({ artist: 'a', track: 't' })
  })

  it('keeps a valid album', () => {
    expect(sanitizeMeta('a', 't', 'al')).toEqual({ artist: 'a', track: 't', album: 'al' })
  })

  it('drops a blank album', () => {
    expect(sanitizeMeta('a', 't', '   ')).toEqual({ artist: 'a', track: 't' })
  })

  it('rejects missing artist or track', () => {
    expect(sanitizeMeta('', 't')).toBeNull()
    expect(sanitizeMeta('a', '')).toBeNull()
    expect(sanitizeMeta(42, 't')).toBeNull()
  })
})

describe('sanitizeTimes', () => {
  it('accepts a valid pair', () => {
    expect(sanitizeTimes(10, 200)).toEqual({ currentTime: 10, duration: 200 })
  })

  it('accepts boundary values', () => {
    expect(sanitizeTimes(43200, 43200)).toEqual({ currentTime: 43200, duration: 43200 })
  })

  it('rejects non-finite numbers', () => {
    expect(sanitizeTimes(Number.NaN, 200)).toBeNull()
    expect(sanitizeTimes(10, Number.POSITIVE_INFINITY)).toBeNull()
    expect(sanitizeTimes('10', 200)).toBeNull()
  })

  it('rejects bad durations', () => {
    expect(sanitizeTimes(0, 0)).toBeNull()
    expect(sanitizeTimes(0, -5)).toBeNull()
    expect(sanitizeTimes(0, 43201)).toBeNull()
  })

  it('rejects currentTime outside [0, duration]', () => {
    expect(sanitizeTimes(-1, 200)).toBeNull()
    expect(sanitizeTimes(201, 200)).toBeNull()
  })
})

describe('sanitizeTimestamp', () => {
  it('keeps current timestamps and floors fractions', () => {
    expect(sanitizeTimestamp(FIXED_NOW)).toBe(FIXED_NOW)
    expect(sanitizeTimestamp(FIXED_NOW + 0.9)).toBe(FIXED_NOW)
  })

  it('clamps far-future timestamps to now', () => {
    expect(sanitizeTimestamp(FIXED_NOW + 3600)).toBe(FIXED_NOW)
  })

  it('keeps near-future timestamps within the grace period', () => {
    expect(sanitizeTimestamp(FIXED_NOW + 30)).toBe(FIXED_NOW + 30)
  })

  it('rejects timestamps older than 30 days', () => {
    expect(sanitizeTimestamp(FIXED_NOW - 31 * DAY)).toBeNull()
  })

  it('keeps the exact 30-day boundary', () => {
    expect(sanitizeTimestamp(FIXED_NOW - 30 * DAY)).toBe(FIXED_NOW - 30 * DAY)
  })

  it('rejects non-finite input', () => {
    expect(sanitizeTimestamp(Number.NaN)).toBeNull()
    expect(sanitizeTimestamp('x')).toBeNull()
    expect(sanitizeTimestamp(undefined)).toBeNull()
  })
})
