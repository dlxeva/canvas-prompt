import { describe, expect, it } from 'vitest'
import { detectLocale, resolveInitialLocale, saveLocalePreference } from './locale'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('locale defaults', () => {
  it('uses Chinese only when the primary host language is Chinese', () => {
    expect(detectLocale(['zh-CN', 'en-US'], 'en-US')).toBe('zh')
    expect(detectLocale(['en-US', 'zh-CN'], 'en-US')).toBe('en')
    expect(detectLocale(undefined, 'ja-JP')).toBe('en')
  })

  it('keeps an explicit user choice ahead of the host default', () => {
    const storage = memoryStorage()
    saveLocalePreference(storage, 'zh')
    expect(resolveInitialLocale(storage, ['en-US'], 'en-US')).toBe('zh')
  })

  it('migrates the legacy automatic Chinese value to the host default', () => {
    expect(resolveInitialLocale(memoryStorage({ 'canvas-prompt-locale': 'zh' }), ['en-US'], 'en-US')).toBe('en')
    expect(resolveInitialLocale(memoryStorage({ 'canvas-prompt-locale': 'en' }), ['zh-CN'], 'zh-CN')).toBe('en')
  })
})
