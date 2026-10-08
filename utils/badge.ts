export function countSuffix(count: number): string {
  if (count > 99) {
    return '99+'
  }
  return String(count)
}

export function badgeTextFor(count: number, reason: 'offline' | 'needAuth' | 'ok'): string {
  if (reason === 'ok') {
    return ''
  }
  if (reason === 'needAuth') {
    if (count > 0) {
      return `?${countSuffix(count)}`
    }
    return '?'
  }
  if (count > 0) {
    return countSuffix(count)
  }
  return '!'
}
