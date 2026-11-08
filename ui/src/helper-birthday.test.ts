import { afterEach, expect, it, vi } from 'vitest'
import { getUfvk, parseUfvkAnswer } from './helper'
void getUfvk
afterEach(() => vi.restoreAllMocks())
it('a scan floor that is not a height is no floor', () => {
  for (const bad of [-1, 1.5, Infinity, '7']) expect(parseUfvkAnswer({ ufvk: 'k', birthday: bad })?.birthday).toBeUndefined()
  expect(parseUfvkAnswer({ ufvk: 'k', birthday: 0 })?.birthday).toBe(0)
})
