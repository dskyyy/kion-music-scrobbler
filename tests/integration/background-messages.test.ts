import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

import background from '../../entrypoints/background'
import {
  apiKeyItem,
  apiSecretItem,
  blockedArtistsItem,
  queueItem,
  sessionKeyItem,
  usernameItem,
} from '../../utils/storage'
import type { ContentMessage, PopupMessage } from '../../utils/types'

const fetchMock = vi.fn()

async function send(message: ContentMessage | PopupMessage): Promise<void> {
  await fakeBrowser.runtime.onMessage.trigger(message, {})
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function logIn(): Promise<void> {
  await apiKeyItem.setValue('key')
  await apiSecretItem.setValue('secret')
  await sessionKeyItem.setValue('sk')
  await usernameItem.setValue('user')
}

function lastBody(): URLSearchParams {
  const calls = fetchMock.mock.calls
  const options = calls[calls.length - 1][1] as { body: URLSearchParams }
  return options.body
}

beforeEach(() => {
  fakeBrowser.reset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)
  background.main()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('background message wiring', () => {
  it('skips updateNowPlaying for blocked artists', async () => {
    await logIn()
    await blockedArtistsItem.setValue(['Wildways'])
    await send({ type: 'NOW_PLAYING', artist: 'Wildways, TRITIA', track: 'Song A' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends updateNowPlaying for clean artists when logged in', async () => {
    await logIn()
    await send({ type: 'NOW_PLAYING', artist: 'Clean Artist', track: 'Song B' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastBody().get('method')).toBe('track.updateNowPlaying')
    expect(lastBody().get('artist')).toBe('Clean Artist')
  })

  it('sends nothing without credentials', async () => {
    await send({ type: 'NOW_PLAYING', artist: 'Clean Artist', track: 'Song C' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops malformed messages', async () => {
    await logIn()
    const bad = { type: 'NOW_PLAYING', artist: 42, track: 'Song D' } as unknown as ContentMessage
    await send(bad)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores repeats but resumes after STOPPED', async () => {
    await logIn()
    const msg: ContentMessage = { type: 'NOW_PLAYING', artist: 'Repeat Band', track: 'Song E' }
    await send(msg)
    await send(msg)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await send({ type: 'STOPPED' })
    await send(msg)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips PROGRESS for blocked artists', async () => {
    await logIn()
    await blockedArtistsItem.setValue(['Wildways'])
    await send({
      type: 'PROGRESS',
      artist: 'Wildways',
      track: 'Song F',
      currentTime: 60,
      duration: 200,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prunes stale queue entries on sync without sending them', async () => {
    await logIn()
    const stale = Math.floor(Date.now() / 1000) - 8 * 24 * 3600
    await queueItem.setValue([{ artist: 'Old Band', track: 'Old Song', timestamp: stale }])
    await send({ type: 'SYNC_NOW' })
    await expect(queueItem.getValue()).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
