import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
  plugins: [WxtVitest()],
})
