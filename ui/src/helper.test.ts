import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  helperConfigured,
  helperHealth,
  registerVault,
  getVault,
  HELPER_BASE,
} from './helper'

// These tests run with VITE_HELPER_BASE unset (the default), so HELPER_BASE is ''. That is the
// local-first contract: with no hosted helper configured, `/net` stays a pure device-to-device
// ceremony - every helper call must degrade to null WITHOUT ever touching the network.

afterEach(() => {
  vi.restoreAllMocks()
})

describe('local-first degradation (no VITE_HELPER_BASE)', () => {
  it('reports no helper configured', () => {
    expect(HELPER_BASE).toBe('')
    expect(helperConfigured()).toBe(false)
  })

  it('never calls fetch and resolves everything to null', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await helperHealth()).toBeNull()
    expect(await registerVault('deadbeef', 'v')).toBeNull()
    expect(await getVault('deadbeef')).toBeNull()
    // The whole point: no network egress when the helper is not configured.
    expect(spy).not.toHaveBeenCalled()
  })
})
