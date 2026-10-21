import { describe, expect, it } from 'vitest'
import { readLocale, readSource } from './setup/read-source'

const coreSource = readSource('src/ui/config/core.tsx')
const layoutSource = readSource('src/layout/index.tsx')
const debugSource = readSource('src/ui/config/debug.tsx')

describe('核心换版沿用当前档案', () => {
  for (const [name, source] of [['core', coreSource], ['layout', layoutSource], ['debug', debugSource]] as const) {
    it(`${name} 不再拦截换版或自动切换档案`, () => {
      expect(source).not.toContain('useCoreProfileSwitch')
      expect(source).not.toContain('guardCoreUpgrade')
      expect(source).not.toContain('create_profile')
      expect(source).not.toContain('set_active_profile')
    })
  }

  it('手动切换保留普通确认，激活成功后仍重启服务', () => {
    expect(coreSource).toContain('core.switch_confirm_title')
    const activate = coreSource.indexOf('await runBusy(core.id, () => activate.mutateAsync(core.id))')
    expect(activate).toBeGreaterThan(-1)
    expect(coreSource.indexOf('await store.harness.restart()', activate)).toBeGreaterThan(activate)
  })

  for (const [name, source] of [['layout', layoutSource], ['debug', debugSource]] as const) {
    it(`${name} 更新入口直接执行核心更新`, () => {
      expect(source).toContain('store.harnessUpdater.showToast(() => store.harnessUpdater.handleUpdate())')
    })
  }

  for (const locale of ['zh-CN', 'en-US']) {
    it(`${locale} 移除过时的破坏性更改文案`, () => {
      expect(Object.keys(readLocale(locale)).filter(key => key.startsWith('core.breaking'))).toEqual([])
    })
  }
})
