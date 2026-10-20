import type { ClientContext, ParentMessage } from '../types'
import type { ClientAdapter, RegisterController } from './index'
import { listenParent } from '../service/listen-parent'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'
import { closeWhenArchived, isolateSidebarLayout, PRESENTATION_FULL_SIDEBAR, presentFullSidebar } from './sidebar-fullwindow'

/** 宿主 → iframe：新建会话命令。 */
const CMD_NEW_SESSION = 'dsh://session:new'

/** 宿主 → iframe：打开文件夹命令。 */
const CMD_ADD_WORKSPACE = 'dsh://workspace:add'

/** 壳层建窗时注入的跳转信息全局名（与 `src-tauri/src/desktop/window.rs` 逐字一致）。 */
const NAVIGATION_GLOBAL = '__DSH_NAVIGATION__'

/** 同一 webview 已消费过的跳转目标：脚本在 iframe 重载时会再次注入，不能重复切回旧会话。 */
const NAVIGATION_CONSUMED_KEY = '__DSH_NAVIGATION_CONSUMED__'

const NAVIGATION_POLL_MS = 500
const NAVIGATION_TIMEOUT_MS = 30_000

interface InjectedNavigation {
  sessionId?: unknown
  presentation?: unknown
}

function injectedSessionConsumed(sessionId: string): boolean {
  try {
    return window.sessionStorage.getItem(NAVIGATION_CONSUMED_KEY) === sessionId
  }
  catch {
    return false
  }
}

function markInjectedSessionConsumed(sessionId: string): void {
  try {
    window.sessionStorage.setItem(NAVIGATION_CONSUMED_KEY, sessionId)
  }
  catch {
    // 存储不可用时退化为「每个文档内只消费一次」，不阻断本次打开。
  }
}

/**
 * 取走壳层注入的跳转载荷（每次文档只取一次）。
 * @returns 会话 id、窗口形态与「会话已打开过」；格式不对的字段各自丢弃。
 */
function takeInjectedNavigation(): { sessionId?: string, presentation?: string, consumed: boolean } {
  const host = window as unknown as Record<string, unknown>
  const payload = host[NAVIGATION_GLOBAL] as InjectedNavigation | undefined
  if (payload === undefined)
    return { consumed: false }
  delete host[NAVIGATION_GLOBAL]
  if (typeof payload !== 'object' || payload === null)
    return { consumed: false }
  const presentation = payload.presentation === PRESENTATION_FULL_SIDEBAR ? PRESENTATION_FULL_SIDEBAR : undefined
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '')
    return { presentation, consumed: false }
  return { sessionId, presentation, consumed: injectedSessionConsumed(sessionId) }
}

function consumeInjectedSession(controller: RegisterController, adapter: ClientAdapter, sessionId: string): void {
  let settled = false
  let cancelPoll = () => {}
  let cancelTimeout = () => {}

  function settle(error?: unknown): void {
    if (settled)
      return
    settled = true
    cancelPoll()
    cancelTimeout()
    if (error !== undefined)
      reportPluginError(error)
  }

  function open(): void {
    if (settled)
      return
    const list = adapter.sessionList()
    if (list === undefined || !list.ids.includes(sessionId) || !adapter.has('navigation.openSession'))
      return
    settle()
    void (async () => {
      const outcome = adapter.openSession(sessionId)
      if (outcome.status !== 'opened')
        throw new Error(outcome.reason)
      await outcome.value
      markInjectedSessionConsumed(sessionId)
    })().catch((error: unknown) => reportPluginError(error))
  }

  cancelPoll = controller.interval(open, NAVIGATION_POLL_MS)
  cancelTimeout = controller.timeout(
    () => settle(`dsh-tauri: session ${sessionId} was not opened (missing from the list or no openSession capability)`),
    NAVIGATION_TIMEOUT_MS,
  )
  open()
}

export const navigationFeature = defineRegister<ClientContext>((controller, _ctx, adapter) => {
  controller.add(listenParent<ParentMessage>((data) => {
    if (data.type === CMD_NEW_SESSION) {
      // 目录选择器不可用 / 建工作区被拒等失败上报宿主插件面板，不影响后续命令。
      void adapter.startSession().catch((error: unknown) => reportPluginError(error))
      return
    }
    if (data.type === CMD_ADD_WORKSPACE)
      void adapter.addWorkspace({ openSession: true }).catch((error: unknown) => reportPluginError(error))
  }, [CMD_NEW_SESSION, CMD_ADD_WORKSPACE]))

  const { sessionId, presentation, consumed } = takeInjectedNavigation()
  console.warn('[dsh-tauri] navigation: injected', { sessionId, presentation, consumed })
  if (presentation === PRESENTATION_FULL_SIDEBAR) {
    // 先把本窗口的右栏布局从共享存储里隔离出来，否则两个窗口会互相覆盖形态。
    if (sessionId !== undefined) {
      isolateSidebarLayout(sessionId)
      closeWhenArchived(controller, sessionId)
    }
    // 形态先就位：它自带看门狗，会话没打开（例如主窗口中途关闭）也会自己揭开，不会留白屏。
    presentFullSidebar(controller)
  }
  if (sessionId !== undefined && !consumed)
    consumeInjectedSession(controller, adapter, sessionId)
})
