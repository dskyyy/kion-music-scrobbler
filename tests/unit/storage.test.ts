import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addBlockedArtist,
  blockedArtistsItem,
  clearQueue,
  dequeueCount,
  enqueueTracks,
  isArtistBlocked,
  normalizeArtistName,
  queueItem,
  removeBlockedArtist,
} from '../../utils/storage'
import type { QueuedTrack } from '../../utils/types'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('wxt/utils/storage', () => {
  return {
    storage: {
      defineItem: (key: string, options: { defaultValue: unknown }) => {
        if (!store.has(key)) {
          store.set(key, options.defaultValue)
        }
        return {
          getValue: async () => store.get(key),
          setValue: async (value: unknown) => {
            store.set(key, value)
          },
        }
      },
    },
  }
})

function track(artist: string, index: number): QueuedTrack {
  return { artist, track: `track ${index}`, timestamp: 1700000000 + index }
}

beforeEach(() => {
  store.clear()
})

describe('normalizeArtistName', () => {
  it('trims, lowercases and collapses whitespace', () => {
    expect(normalizeArtistName('  WildWAYS   X  ')).toBe('wildways x')
  })

  it('handles cyrillic', () => {
    expect(normalizeArtistName('  КИОН  Мьюзик ')).toBe('кион мьюзик')
  })

  it('returns null for non-strings and blanks', () => {
    expect(normalizeArtistName(42)).toBeNull()
    expect(normalizeArtistName(null)).toBeNull()
    expect(normalizeArtistName(undefined)).toBeNull()
    expect(normalizeArtistName('')).toBeNull()
    expect(normalizeArtistName('   ')).toBeNull()
  })
})

describe('isArtistBlocked', () => {
  it('matches exact names case-insensitively', () => {
    expect(isArtistBlocked('Wildways', ['wildways'])).toBe(true)
  })

  it('matches collaborations containing a blocked name', () => {
    expect(isArtistBlocked('Wildways, TRITIA', ['Wildways'])).toBe(true)
  })

  it('does not match clean artists', () => {
    expect(isArtistBlocked('TRITIA', ['Wildways'])).toBe(false)
  })

  it('never matches empty entries', () => {
    expect(isArtistBlocked('Wildways', ['', '   '])).toBe(false)
  })

  it('falls back to exact match for single-char entries', () => {
    expect(isArtistBlocked('Xenomorph', ['x'])).toBe(false)
    expect(isArtistBlocked('X', ['x'])).toBe(true)
  })

  it('treats entries as substrings, not whole words', () => {
    expect(isArtistBlocked('AIR', ['AI'])).toBe(true)
    expect(isArtistBlocked('AIR', ['AID'])).toBe(false)
  })

  it('returns false for empty or non-string artists', () => {
    expect(isArtistBlocked('', ['Wildways'])).toBe(false)
    expect(isArtistBlocked(null, ['Wildways'])).toBe(false)
  })
})

describe('addBlockedArtist', () => {
  it('adds a trimmed name', async () => {
    await expect(addBlockedArtist('  Wildways  ')).resolves.toEqual(['Wildways'])
  })

  it('ignores normalized duplicates', async () => {
    await addBlockedArtist('Wildways')
    await expect(addBlockedArtist(' wildways ')).resolves.toEqual(['Wildways'])
  })

  it('ignores empty names', async () => {
    await expect(addBlockedArtist('   ')).resolves.toEqual([])
  })

  it('truncates names longer than 256 chars', async () => {
    const next = await addBlockedArtist('x'.repeat(300))
    expect(next).toHaveLength(1)
    expect(next[0]).toHaveLength(256)
  })

  it('respects the 500-entry cap', async () => {
    const full = Array.from({ length: 500 }, (_, i) => `artist ${i}`)
    await blockedArtistsItem.setValue(full)
    await expect(addBlockedArtist('one more')).resolves.toHaveLength(500)
  })
})

describe('removeBlockedArtist', () => {
  it('removes by normalized comparison', async () => {
    await addBlockedArtist('Wildways')
    await expect(removeBlockedArtist(' WILDWAYS ')).resolves.toEqual([])
  })

  it('leaves the list untouched when nothing matches', async () => {
    await addBlockedArtist('Wildways')
    await expect(removeBlockedArtist('TRITIA')).resolves.toEqual(['Wildways'])
  })
})

describe('offline queue', () => {
  it('appends tracks and filters out empty ones', async () => {
    const merged = await enqueueTracks([
      track('a', 1),
      { artist: '', track: 'nope', timestamp: 1 },
      track('b', 2),
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0].artist).toBe('a')
  })

  it('caps the queue at 1000, dropping the oldest', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => track('a', i))
    const merged = await enqueueTracks(items)
    expect(merged).toHaveLength(1000)
    expect(merged[0].track).toBe('track 1')
  })

  it('dequeues the first N tracks', async () => {
    await enqueueTracks([track('a', 1), track('b', 2), track('c', 3)])
    const rest = await dequeueCount(2)
    expect(rest.map((t) => t.artist)).toEqual(['c'])
    await expect(queueItem.getValue()).resolves.toHaveLength(1)
  })

  it('clears the queue', async () => {
    await enqueueTracks([track('a', 1)])
    await clearQueue()
    await expect(queueItem.getValue()).resolves.toEqual([])
  })
})
