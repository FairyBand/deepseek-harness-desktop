import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripJsonc } from '../scripts/bundle-metadata.mjs'

const manifest = JSON.parse(stripJsonc(
  readFileSync(new URL('../src-tauri/resources/manifest.jsonc', import.meta.url), 'utf8'),
)) as { plugins: { 'preset': { id: string }[], 'built-in': { id: string }[], 'depercated': string[] } }

const presets = manifest.plugins.preset

describe('community plugin presets', () => {
  it('removes DSH Bridge from install presets without marking existing installs for removal', () => {
    expect(presets.map(plugin => plugin.id)).not.toContain('@wenbin_wb/dsh-bridge')
    expect(manifest.plugins['built-in'].map(plugin => plugin.id)).not.toContain('@wenbin_wb/dsh-bridge')
    expect(manifest.plugins.depercated).not.toContain('@wenbin_wb/dsh-bridge')
  })

  it('keeps DSH IM optional without the recommended badge', () => {
    expect(presets.filter(plugin => plugin.id === '@xmanrui/dsh-im')).toMatchObject([
      { spec: '@xmanrui/dsh-im', recommended: false, checked: false },
    ])
  })

  it('recommends Office Kit without preselecting it immediately before DSH Market', () => {
    expect(presets.filter(plugin => plugin.id === 'dsh-office-kit')).toEqual([
      {
        id: 'dsh-office-kit',
        spec: 'dsh-office-kit',
        name: 'DSH Office Kit',
        description: 'Office documents, PDF, presentations, and spreadsheets for DeepSeek Harness',
        repo: 'https://github.com/hairyf/dsh-office-kit',
        recommended: true,
        checked: false,
        version: 'latest',
      },
    ])
    const ids = presets.map(plugin => plugin.id)
    expect(ids[ids.indexOf('dsh-office-kit') + 1]).toBe('dshmarket')
  })

  it('recommends DSH OPS without preselecting it immediately before DSH GenUI', () => {
    expect(presets.filter(plugin => plugin.id === 'dsh-ops')).toMatchObject([
      {
        spec: 'dsh-ops',
        name: 'DSH OPS',
        repo: 'https://github.com/T-Auto/dsh-ops',
        recommended: true,
        checked: false,
        version: 'latest',
      },
    ])
    const ids = presets.map(plugin => plugin.id)
    expect(ids[ids.indexOf('dsh-ops') + 1]).toBe('@changfenhuang/dsh-genui')
  })

  it.each([
    ['@changfenhuang/dsh-genui', /^交互式界面插件/],
    ['dsh-context', /^一站式 DeepSeek Harness 上下文可视化插件/],
    ['billion-context', /^基本稳定可用。上下文压缩插件/],
  ])('%s leads its description with Chinese', (id, prefix) => {
    expect(presets.filter(plugin => plugin.id === id)).toMatchObject([
      { description: expect.stringMatching(prefix) },
    ])
  })

  it('keeps DSH Market unselected and ordered after Billion Context', () => {
    const ids = presets.map(plugin => plugin.id)
    expect(ids.indexOf('dshmarket')).toBeGreaterThan(ids.indexOf('billion-context'))
    expect(presets.filter(plugin => plugin.id === 'dshmarket')).toMatchObject([
      { spec: 'dshmarket', recommended: false, checked: false },
    ])
  })

  it.each([
    {
      id: '@changfenhuang/dsh-genui',
      spec: '@changfenhuang/dsh-genui',
      name: 'DSH GenUI',
      description: '交互式界面插件，通过 dsh-ui 代码块在助手回复中直接呈现布局、图表、绘图、表单、测验、Mermaid 和 3D 场景，并将交互事件回传模型。内含宿主插件、浏览器渲染器和 genui 技能。 ｜ GenUI for DeepSeek Harness: interactive UI components rendered inline in assistant replies via the dsh-ui fence — layout, charts, plots, forms, quizzes, mermaid, 3D scenes, and an action event loop back to the model. Ships the fence-teaching host plugin, the browser renderer (client half), and the genui skill.',
      repo: 'https://github.com/omdsh-dev/dsh-genui',
      recommended: false,
      checked: false,
      version: 'latest',
    },
    {
      id: 'dsh-context',
      spec: 'dsh-context',
      name: 'DSH Context',
      description: '一站式 DeepSeek Harness 上下文可视化插件，Context 面板及浏览器和侧边栏与 Context 命令，透视上下文组成、演进、压缩、剪枝等事件与动作。 ｜ The best DeepSeek Harness plugin for context insight and management, with context dashboard / browser / sidebar and context command, for context statistics, composition, breakdown, evolution details, understanding how the context is made of, and how it evolves.',
      repo: 'https://github.com/bowenliang123/dsh-context',
      recommended: false,
      checked: false,
      version: 'latest',
    },
  ])('lists $id once as an optional preset with its Chinese-first bilingual description', (expected) => {
    expect(presets.filter(plugin => plugin.id === expected.id)).toEqual([expected])
  })
})
