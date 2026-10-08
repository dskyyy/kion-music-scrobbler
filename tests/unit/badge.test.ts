import { describe, expect, it } from 'vitest'

import { badgeTextFor, countSuffix } from '../../utils/badge'

describe('countSuffix', () => {
  it('renders small counts as-is', () => {
    expect(countSuffix(0)).toBe('0')
    expect(countSuffix(5)).toBe('5')
    expect(countSuffix(99)).toBe('99')
  })

  it('caps large counts at 99+', () => {
    expect(countSuffix(100)).toBe('99+')
    expect(countSuffix(1000)).toBe('99+')
  })
})

describe('badgeTextFor', () => {
  it('clears the badge when online', () => {
    expect(badgeTextFor(0, 'ok')).toBe('')
    expect(badgeTextFor(7, 'ok')).toBe('')
  })

  it('marks auth problems with a question mark', () => {
    expect(badgeTextFor(0, 'needAuth')).toBe('?')
    expect(badgeTextFor(3, 'needAuth')).toBe('?3')
    expect(badgeTextFor(150, 'needAuth')).toBe('?99+')
  })

  it('marks offline mode with the queue size', () => {
    expect(badgeTextFor(0, 'offline')).toBe('!')
    expect(badgeTextFor(2, 'offline')).toBe('2')
    expect(badgeTextFor(200, 'offline')).toBe('99+')
  })
})
