import { doThing } from '../src/index'

describe('doThing input handling', () => {
  test('does not throw and returns default when input is undefined and defaultValue provided', () => {
    expect(() => doThing(undefined as any, 'fallback')).not.toThrow()
    expect(doThing(undefined as any, 'fallback')).toBe('fallback')
  })

  test('does not throw and returns empty string when input is an object without foo', () => {
    const result = doThing({} as any)
    expect(result).toBe('')
  })
})
