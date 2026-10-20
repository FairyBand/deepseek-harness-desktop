import type { PointerEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

/** WKWebView 的 macOS UA 稳定包含 Macintosh，用于切换平台原生窗口 chrome。 */
export const IS_MACOS = navigator.userAgent.includes('Macintosh')

/** macOS 原生全屏时收起整条壳层导航栏。 */
export function useMacOSFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    if (!IS_MACOS)
      return

    const appWindow = getCurrentWindow()
    let mounted = true
    let unlisten: (() => void) | undefined

    async function syncFullscreen() {
      try {
        const fullscreen = await appWindow.isFullscreen()
        if (mounted)
          setIsFullscreen(fullscreen)
      }
      catch (error) {
        console.error('[Navbar] failed to sync fullscreen state:', error)
      }
    }

    async function setupListener() {
      try {
        await syncFullscreen()
        const stopListening = await appWindow.onResized(() => {
          void syncFullscreen()
        })
        if (mounted)
          unlisten = stopListening
        else
          stopListening()
      }
      catch (error) {
        console.error('[Navbar] failed to listen for fullscreen state:', error)
      }
    }

    void setupListener()
    return () => {
      mounted = false
      unlisten?.()
    }
  }, [])

  return isFullscreen
}

export function useMaximized() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let mounted = true
    let unlisten: (() => void) | undefined

    async function syncMaximized() {
      try {
        const maximized = await appWindow.isMaximized()
        if (mounted)
          setIsMaximized(maximized)
      }
      catch (error) {
        console.error('[Navbar] failed to sync maximized state:', error)
      }
    }

    async function setupListener() {
      try {
        await syncMaximized()
        const stopListening = await appWindow.onResized(() => {
          void syncMaximized()
        })
        if (mounted)
          unlisten = stopListening
        else
          stopListening()
      }
      catch (error) {
        console.error('[Navbar] failed to listen for maximized state:', error)
      }
    }

    void setupListener()
    return () => {
      mounted = false
      unlisten?.()
    }
  }, [])

  return isMaximized
}

/** 拖拽区指针处理：`data-tauri-drag-region` 原生只认鼠标，触摸/笔输入要手动进入系统拖拽。 */
export function onDragRegionPointerDown(event: PointerEvent<HTMLDivElement>) {
  if (event.pointerType === 'mouse')
    return
  event.preventDefault()
  void getCurrentWindow().startDragging()
}
