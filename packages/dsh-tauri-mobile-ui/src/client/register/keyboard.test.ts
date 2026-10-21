// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycleController } from '../../../../dsh-tauri/src/client/controller'
import { registerMobileKeyboard } from './keyboard'

const device = vi.hoisted(() => ({ mobile: true }))
vi.mock('dsh-tauri/client', () => ({
  detectMobileDevice: () => device.mobile,
  defineRegister: (setup: (...args: unknown[]) => void) => setup,
}))

let controller: ReturnType<typeof createLifecycleController>
let editor: HTMLElement
let viewport: FakeViewport
const labels: Record<string, string> = { 'input.send': '发送消息', 'input.send.queue': '排队发送', 'input.send.steer': '插话发送' }

class FakeViewport extends EventTarget {
  height = window.innerHeight
  scale = 1
}

function touch(type: string, x: number, y: number, target: Element = document.querySelector('[data-conversation-scroll]')!) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: x, clientY: y }] })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  device.mobile = true
  document.body.innerHTML = '<div data-conversation-scroll><p>Message</p><div data-composer-seat><textarea></textarea><button aria-label="发送消息"><svg></svg></button></div></div><input id="setting">'
  editor = document.querySelector('textarea')!
  editor.focus()
  viewport = new FakeViewport()
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  controller = createLifecycleController()
  const register = registerMobileKeyboard as unknown as (controller: unknown, ctx: unknown) => void
  register(controller, { locale: { bind: () => (key: string) => labels[key] ?? key } })
})

afterEach(() => {
  controller.dispose()
  Reflect.deleteProperty(window, 'visualViewport')
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('mobile composer keyboard dismissal', () => {
  it.each(['发送消息', '排队发送', '插话发送'])('blurs the editor after the %s click handler without preventing submission', (label) => {
    const button = document.querySelector('button')!
    button.setAttribute('aria-label', label)
    const submit = vi.fn(() => expect(document.activeElement).toBe(editor))
    button.addEventListener('click', submit)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    button.querySelector('svg')!.dispatchEvent(event)
    expect(submit).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(editor)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves disabled sends, stop actions and desktop input focused', () => {
    const button = document.querySelector('button')!
    button.disabled = true
    button.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.activeElement).toBe(editor)
    button.disabled = false
    button.setAttribute('aria-label', '停止')
    button.click()
    expect(document.activeElement).toBe(editor)
    button.setAttribute('aria-label', '发送消息')
    device.mobile = false
    button.click()
    expect(document.activeElement).toBe(editor)
  })

  it('dismisses on a vertical transcript swipe without consuming native scroll', () => {
    touch('touchstart', 100, 100)
    touch('touchmove', 101, 106)
    expect(document.activeElement).toBe(editor)
    expect(touch('touchmove', 102, 130).defaultPrevented).toBe(false)
    expect(document.activeElement).not.toBe(editor)
  })

  it('preserves focus for taps, horizontal gestures, programmatic scrolling and composer gestures', () => {
    touch('touchstart', 100, 100)
    touch('touchmove', 130, 102)
    touch('touchend', 130, 102)
    document.querySelector('[data-conversation-scroll]')!.dispatchEvent(new Event('scroll'))
    touch('touchstart', 100, 100, editor)
    touch('touchmove', 100, 140, editor)
    expect(document.activeElement).toBe(editor)
  })

  it('does not dismiss unrelated settings inputs or retain listeners after unload', () => {
    const setting = document.querySelector<HTMLInputElement>('#setting')!
    setting.focus()
    touch('touchstart', 100, 100)
    touch('touchmove', 100, 130)
    expect(document.activeElement).toBe(setting)
    editor.focus()
    controller.dispose()
    document.querySelector<HTMLButtonElement>('button')!.click()
    touch('touchstart', 100, 100)
    touch('touchmove', 100, 130)
    expect(document.activeElement).toBe(editor)
  })
})

describe('mobile keyboard viewport fit', () => {
  const reserved = () => document.documentElement.style.getPropertyValue('--dsh-mobile-viewport-height')

  it('reserves the visible height while a text field is focused and releases it afterwards', () => {
    viewport.height = 420
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('420px')
    viewport.height = window.innerHeight
    editor.blur()
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('')
  })

  it('ignores a shrunken viewport without a focused text field', () => {
    editor.blur()
    viewport.height = 420
    viewport.dispatchEvent(new Event('resize'))
    expect(reserved()).toBe('')
  })

  it('follows the keyboard height the iOS app reports', () => {
    const report = (height: number) => window.dispatchEvent(new CustomEvent('dsh-mobile-keyboard', { detail: { height } }))
    report(300)
    expect(reserved()).toBe(`${window.innerHeight - 300}px`)
    report(0)
    expect(reserved()).toBe('')
  })

  it('drops the reservation when the plugin unloads', () => {
    window.dispatchEvent(new CustomEvent('dsh-mobile-keyboard', { detail: { height: 300 } }))
    controller.dispose()
    expect(reserved()).toBe('')
  })
})
