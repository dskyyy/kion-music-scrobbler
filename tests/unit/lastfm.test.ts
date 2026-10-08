import md5 from 'blueimp-md5'
import { describe, expect, it } from 'vitest'

import {
  LASTFM_INVALID_SESSION,
  LASTFM_SERVICE_OFFLINE,
  LASTFM_TEMPORARY_ERROR,
  LASTFM_TOKEN_INVALID,
  LastfmError,
  sign,
} from '../../utils/lastfm'

describe('sign', () => {
  it('hashes sorted key-value pairs plus secret', () => {
    expect(sign({ b: '2', a: '1' }, 's')).toBe(md5('a1b2s'))
  })

  it('is order-invariant', () => {
    expect(sign({ b: '2', a: '1' }, 's')).toBe(sign({ a: '1', b: '2' }, 's'))
  })

  it('excludes format from the signature', () => {
    expect(sign({ a: '1', format: 'json' }, 's')).toBe(md5('a1s'))
  })

  it('depends on the secret', () => {
    expect(sign({ a: '1' }, 'one')).not.toBe(sign({ a: '1' }, 'two'))
  })
})

describe('LastfmError', () => {
  it('marks network errors retryable', () => {
    const err = new LastfmError('network', 'down')
    expect(err.retryable).toBe(true)
    expect(err.needAuth).toBe(false)
  })

  it('marks service offline and temporary errors retryable', () => {
    expect(new LastfmError(LASTFM_SERVICE_OFFLINE, 'x').retryable).toBe(true)
    expect(new LastfmError(LASTFM_TEMPORARY_ERROR, 'x').retryable).toBe(true)
  })

  it('marks invalid sessions as needing auth', () => {
    const err = new LastfmError(LASTFM_INVALID_SESSION, 'x')
    expect(err.needAuth).toBe(true)
    expect(err.retryable).toBe(false)
  })

  it('keeps plain errors non-retryable', () => {
    const err = new LastfmError(LASTFM_TOKEN_INVALID, 'x')
    expect(err.code).toBe(LASTFM_TOKEN_INVALID)
    expect(err.retryable).toBe(false)
    expect(err.needAuth).toBe(false)
  })
})
