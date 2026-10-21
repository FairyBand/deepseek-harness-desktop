import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, detectMobileDevice } from 'dsh-tauri/client'

const COMPOSER = '[data-composer-seat], [data-slot="conversation.composer.bar"]'
const SCROLL = '[data-conversation-scroll], [data-slot="conversation.view"]'
const EDITABLE = 'textarea, input, [contenteditable="true"]'
const VIEWPORT_HEIGHT = '--dsh-mobile-viewport-height'
const NATIVE_KEYBOARD = 'dsh-mobile-keyboard'

export const registerMobileKeyboard = defineRegister<ClientContext>((controller, ctx) => {
  const t = ctx.locale.bind('conversation')
  const viewport = window.visualViewport
  let touch: { id: number, x: number, y: number } | undefined
  let nativeHeight = 0

  function dismissKeyboard() {
    const editor = document.activeElement
    if (detectMobileDevice() && editor instanceof HTMLElement && editor.closest(COMPOSER)
      && editor.matches(EDITABLE)) {
      editor.blur()
    }
  }

  function shrinkHeight() {
    if (nativeHeight > 0)
      return Math.max(0, window.innerHeight - nativeHeight)
    const editor = document.activeElement
    if (!(editor instanceof HTMLElement) || !editor.matches(EDITABLE) || !viewport || Math.abs(viewport.scale - 1) > 0.01)
      return 0
    return window.innerHeight - viewport.height >= 1 ? Math.floor(viewport.height) : 0
  }

  // keep:effect The keyboard overlays the WebView instead of shrinking it, so the page itself has to reserve the covered height or the composer stays behind it.
  function fitKeyboard() {
    const height = shrinkHeight()
    const style = document.documentElement.style
    if (height > 0)
      style.setProperty(VIEWPORT_HEIGHT, `${height}px`)
    else
      style.removeProperty(VIEWPORT_HEIGHT)
  }

  function onNativeKeyboard(event: Event) {
    const detail = (event as CustomEvent<{ height?: number }>).detail
    nativeHeight = Math.max(0, Math.round(detail?.height ?? 0))
    fitKeyboard()
  }

  window.addEventListener(NATIVE_KEYBOARD, onNativeKeyboard)
  viewport?.addEventListener('resize', fitKeyboard)
  controller.add(() => {
    window.removeEventListener(NATIVE_KEYBOARD, onNativeKeyboard)
    viewport?.removeEventListener('resize', fitKeyboard)
    document.documentElement.style.removeProperty(VIEWPORT_HEIGHT)
  })

  controller.listen('click', (event) => {
    if (!(event.target instanceof Element))
      return
    const button = event.target.closest<HTMLButtonElement>('button')
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || !button.closest(COMPOSER))
      return
    if ([t('input.send'), t('input.send.queue'), t('input.send.steer')].includes(button.getAttribute('aria-label') ?? ''))
      dismissKeyboard()
  })
  controller.listen('touchstart', (event) => {
    touch = undefined
    if (!detectMobileDevice() || event.touches.length !== 1 || !(event.target instanceof Element) || event.target.closest(COMPOSER) || !event.target.closest(SCROLL))
      return
    const point = event.touches[0]!
    touch = { id: point.identifier, x: point.clientX, y: point.clientY }
  }, { passive: true })
  controller.listen('touchmove', (event) => {
    if (!touch || event.touches.length !== 1)
      return
    const point = event.touches[0]!
    if (point.identifier !== touch.id)
      return
    const dy = Math.abs(point.clientY - touch.y)
    if (dy > 10 && dy > Math.abs(point.clientX - touch.x)) {
      dismissKeyboard()
      touch = undefined
    }
  }, { passive: true })
  function resetTouch() {
    touch = undefined
  }
  controller.listen('touchend', resetTouch, { passive: true })
  controller.listen('touchcancel', resetTouch, { passive: true })
})
