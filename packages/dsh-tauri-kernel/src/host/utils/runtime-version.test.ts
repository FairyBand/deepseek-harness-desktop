import type { PlatformLoader } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { runtimeVersion } from './runtime-version'

function loader(value: (id: string) => unknown, unwrap: PlatformLoader['unwrapExports'] = exports => exports): PlatformLoader {
  return { import: vi.fn(async (id: string) => value(id)), unwrapExports: unwrap }
}

describe('host runtime version probe', () => {
  it('reads the official runtime version through the loader', async () => {
    const runtime = vi.fn(() => '0.2.1-rc.1')
    expect(await runtimeVersion(loader(() => ({ getDshRuntimeVersion: runtime })))).toBe('0.2.1-rc.1')
    expect(runtime).toHaveBeenCalledOnce()
  })

  it('accepts a loader whose module namespace needs unwrapping', async () => {
    expect(await runtimeVersion(loader(() => ({ default: {} }), () => ({ getDshRuntimeVersion: () => '0.2.1-rc.1' })))).toBe('0.2.1-rc.1')
  })

  it.each([
    ['a missing export', () => ({})],
    ['a failed import', () => { throw new Error('runtime package not installed') }],
    ['a non-string version', () => ({ getDshRuntimeVersion: () => 2 })],
    ['an empty version', () => ({ getDshRuntimeVersion: () => '  ' })],
  ])('reports no runtime version for %s', async (_label, value) => {
    expect(await runtimeVersion(loader(value as (id: string) => unknown))).toBeNull()
  })
})
