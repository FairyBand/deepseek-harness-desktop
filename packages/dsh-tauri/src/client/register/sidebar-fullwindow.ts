import type { RegisterController } from './index'
/**
 * register/sidebar-fullwindow.ts — 右栏「在新窗口全屏打开」：
 *
 * 官方没有对外暴露全屏命令，右栏 chrome 也没有插槽，只能落在界面上现成的那几枚控件上：
 * 在全屏按钮左侧注入一枚官方同款按钮，点击走宿主的 `create_app_window` 并带上
 * `presentation=full-sidebar`；带该标记的窗口启动后把右列展开、切进全屏，chrome 上只留
 * 内容（窗口形态由壳层的 `full-sidebar-navbar` 承载）。
 *
 * 用 DOM 注入而不是 React 组件：chrome 由官方包渲染且不接受外部插槽，`data-sidebar-right-*`
 * 稳定属性比生成的 CSS module 类名可靠。
 */
import { ARCHIVE_STREAM_PATH } from '../../shared/constants'
import { invoke } from '../service/invoke'
import { invokeParent } from '../service/invoke-parent'
import { reportPluginError } from '../utils/error'
import { defineRegister } from './index'

/** 注入按钮的标记属性（幂等判断用）。 */
const OPEN_WINDOW_ATTRIBUTE = 'data-dsh-tauri-open-window'

/** 全屏切换按钮：它的存在说明右栏已挂载，值是 `fullscreen` 表示还没全屏。 */
const FULLSCREEN_SELECTOR = '[data-sidebar-right-mode]'

/** 折叠态轨上的展开按钮。 */
const EXPAND_SELECTOR = '[data-sidebar-right-expand]'

/** 展开态 chrome 上的收起按钮。 */
const TOGGLE_SELECTOR = '[data-sidebar-right-toggle]'

/** 右栏根节点：携带本栏所属会话 id。 */
const SESSION_SELECTOR = '[data-sidebar-right-session]'

/** dockkit 的 tab 与其关闭按钮（关闭按钮带稳定属性，见官方 tab 渲染）。 */
const TAB_SELECTOR = '[data-dockkit-tab]'
const TAB_CLOSE_SELECTOR = '[data-dockkit-tab-close]'

/** 全屏形态窗口的根标记：隐藏 chrome 按钮，也是壳层判定窗口形态的依据。 */
export const FULL_SIDEBAR_ATTRIBUTE = 'data-dsh-tauri-full-sidebar'

/** 建窗载荷里的窗口形态（与 `src-tauri/src/desktop/window.rs` 逐字一致）。 */
export const PRESENTATION_FULL_SIDEBAR = 'full-sidebar'

/** 官方右栏布局的落盘前缀（`<前缀><sessionId>`）。 */
const LAYOUT_STORAGE_PREFIX = 'dsh.sidebar-right.v1.'

/** 布局已隔离的标记：每个文档只装一次。 */
const LAYOUT_ISOLATED_ATTRIBUTE = 'data-dsh-tauri-layout-isolated'

/**
 * 把右栏布局搬进本窗口的 sessionStorage。
 *
 * 官方按 Session 把布局存在共享的 localStorage 里，同一会话开两个窗口就会互相覆盖：
 * 主窗口收起右栏会把全屏窗口刷回普通布局，全屏窗口切全屏又会让主窗口刷新后变全屏。
 * 隔离后每个窗口各存各的，互不干扰。
 * @param sessionId - 本窗口要就位成全屏的那条会话。
 */
export function isolateSidebarLayout(sessionId: string): void {
  if (document.documentElement.hasAttribute(LAYOUT_ISOLATED_ATTRIBUTE))
    return
  let shared: Storage
  let own: Storage
  try {
    shared = window.localStorage
    own = window.sessionStorage
  }
  catch {
    return
  }
  document.documentElement.setAttribute(LAYOUT_ISOLATED_ATTRIBUTE, sessionId)
  const key = `${LAYOUT_STORAGE_PREFIX}${sessionId}`
  try {
    const saved = own.getItem(key) ?? shared.getItem(key)
    if (saved !== null) {
      const parsed = JSON.parse(saved) as { bySession?: Record<string, { layout?: { expanded?: boolean, mode?: string } }> }
      const layout = parsed.bySession?.[sessionId]?.layout
      if (layout !== undefined) {
        layout.expanded = true
        layout.mode = 'fullscreen'
        own.setItem(key, JSON.stringify(parsed))
      }
    }
  }
  catch (error) {
    reportPluginError(error)
  }
  const proto = Object.getPrototypeOf(own) as Storage | null
  if (proto === null || typeof proto.getItem !== 'function')
    return
  const { getItem, setItem, removeItem } = proto
  const routed = (target: string) => target.startsWith(LAYOUT_STORAGE_PREFIX)
  proto.getItem = function (target: string): string | null {
    return routed(target) ? getItem.call(own, target) : getItem.call(this, target)
  }
  proto.setItem = function (target: string, value: string): void {
    if (routed(target))
      setItem.call(own, target, value)
    else
      setItem.call(this, target, value)
  }
  proto.removeItem = function (target: string): void {
    if (routed(target))
      removeItem.call(own, target)
    else
      removeItem.call(this, target)
  }
}

/** 就位中：整页先藏起来，避免先看到普通布局再跳成全屏。 */
const FULL_SIDEBAR_PRESENTING = 'presenting'

const FULL_SIDEBAR_READY = 'ready'

const PRESENT_POLL_MS = 250
const PRESENT_MAX_TICKS = 32

/** 就位完成通知：壳层据此揭开内容区的遮罩。 */
const FULL_SIDEBAR_READY_MESSAGE = 'dsh://full-sidebar:ready'

/** 官方 tooltip 气泡的观感（同官方样式表，行内写死以免依赖模块化类名）。 */
const TOOLTIP_STYLE = 'position:fixed;z-index:100;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:nowrap;pointer-events:none;display:none'

const TOOLTIP_DELAY_MS = 300
const TOOLTIP_GAP = 6

/** 官方字形风格：16×16 描边图标。 */
const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5H13C13.2761 2.5 13.5 2.72386 13.5 3V6.5" stroke="currentColor"/><path d="M13.1 2.9L8.5 7.5" stroke="currentColor"/><path d="M12 9.5V13C12 13.2761 11.7761 13.5 11.5 13.5H3C2.72386 13.5 2.5 13.2761 2.5 13V3C2.5 2.72386 2.72386 2.5 3 2.5H6.5" stroke="currentColor"/></svg>'

/** 按钮文案跟随官方按钮的语言：官方全屏按钮只有中英两种。 */
function buttonLabel(mode: Element): string {
  return /[\u4E00-\u9FA5]/.test(mode.getAttribute('aria-label') ?? '')
    ? '在新窗口全屏打开'
    : 'Open full screen in new window'
}

function openWindow(button: HTMLElement): void {
  const sessionId = button.closest(SESSION_SELECTOR)?.getAttribute('data-sidebar-right-session')
  document.querySelector<HTMLElement>(TOGGLE_SELECTOR)?.click()
  void invoke('create_app_window', {
    sessionId: sessionId ?? undefined,
    presentation: PRESENTATION_FULL_SIDEBAR,
  }).catch((error: unknown) => reportPluginError(error))
}

function isFullSidebarDocument(): boolean {
  return document.documentElement.hasAttribute(FULL_SIDEBAR_ATTRIBUTE)
}

interface Tooltip {
  attach: (anchor: HTMLElement, text: string) => void
  hide: () => void
  dispose: () => void
}

/**
 * 官方 chrome 按钮的悬停提示：自带的气泡样式，而不是原生 `title`。
 * 状态留在特性闭包里，插件卸载时一起收走。
 * @returns 提示气泡的挂载、隐藏与销毁。
 */
function createTooltip(): Tooltip {
  let bubble: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const hide = () => {
    clearTimeout(timer)
    if (bubble !== null)
      bubble.style.display = 'none'
  }
  const show = (anchor: HTMLElement, text: string) => {
    bubble ??= document.createElement('div')
    bubble.setAttribute('role', 'tooltip')
    bubble.style.cssText = TOOLTIP_STYLE
    bubble.textContent = text
    document.body.append(bubble)
    const rect = anchor.getBoundingClientRect()
    bubble.style.display = 'block'
    const width = bubble.getBoundingClientRect().width
    bubble.style.top = `${rect.bottom + TOOLTIP_GAP}px`
    bubble.style.left = `${Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 4), window.innerWidth - width - 4)}px`
  }
  return {
    attach(anchor, text) {
      anchor.addEventListener('pointerenter', () => {
        clearTimeout(timer)
        timer = setTimeout(show, TOOLTIP_DELAY_MS, anchor, text)
      })
      anchor.addEventListener('pointerleave', hide)
    },
    hide,
    dispose() {
      hide()
      bubble?.remove()
      bubble = null
    },
  }
}

/** 用行内样式藏控件：插件样式表可能被宿主模块系统回收，行内样式不会。 */
function conceal(element: Element | null | undefined): void {
  if (element instanceof HTMLElement)
    element.style.setProperty('display', 'none', 'important')
}

/**
 * 全屏形态窗口的右栏只剩一个 tab：关掉它就是关掉整个面板，
 * 所以收掉关闭按钮，也不让它弹出右键菜单。
 */
function guardLastTab(): void {
  const single = isFullSidebarDocument() && document.querySelectorAll(TAB_SELECTOR).length <= 1
  document.querySelectorAll<HTMLElement>(TAB_CLOSE_SELECTOR).forEach((close) => {
    if (single)
      close.style.setProperty('display', 'none', 'important')
    else
      close.style.removeProperty('display')
  })
}

/** 把按钮插到全屏按钮左侧；右栏重渲染丢掉按钮时由观察者再次调用。 */
function place(tooltip: Tooltip): void {
  const mode = document.querySelector<HTMLElement>(FULLSCREEN_SELECTOR)
  const parent = mode?.parentElement
  if (mode == null || parent == null)
    return
  let button = document.querySelector<HTMLButtonElement>(`[${OPEN_WINDOW_ATTRIBUTE}]`)
  if (button === null) {
    const created = document.createElement('button')
    created.type = 'button'
    created.setAttribute(OPEN_WINDOW_ATTRIBUTE, '')
    const label = buttonLabel(mode)
    created.setAttribute('aria-label', label)
    // 直接沿用官方按钮的类名：尺寸与 hover 完全跟着官方样式表走。
    created.className = mode.className
    created.innerHTML = ICON
    created.addEventListener('click', () => {
      tooltip.hide()
      openWindow(created)
    })
    tooltip.attach(created, label)
    parent.insertBefore(created, mode)
    button = created
  }
  else if (mode.previousElementSibling !== button) {
    parent.insertBefore(button, mode)
  }
  if (isFullSidebarDocument()) {
    conceal(button)
    conceal(mode)
    conceal(document.querySelector(TOGGLE_SELECTOR))
  }
}

/**
 * 把本窗口就位成全屏右栏：标记形态 → 展开右列 → 切进全屏。
 *
 * 右列可能还没渲染（会话刚打开）或还没折叠可展开，所以逐帧推进而不是一次点完；
 * 轮询自带看门狗，会话始终没打开也会自己揭开，不留白屏。
 * @param controller - 生命周期控制器；窗口关闭或插件重载时停掉轮询。
 */
/**
 * 本窗口的会话被归档即关窗：官方会收回那条会话的右栏，窗口会掉回会话列表，
 * 与其留一个空壳不如随会话消失。
 * @param controller - 生命周期控制器（订阅随插件卸载关闭）。
 * @param sessionId - 本窗口承载的会话 id。
 */
export function closeWhenArchived(controller: RegisterController, sessionId: string): void {
  if (typeof EventSource === 'undefined') {
    console.warn('[dsh-tauri] archive-watch: no EventSource')
    return
  }
  const source = new EventSource(ARCHIVE_STREAM_PATH)
  console.warn('[dsh-tauri] archive-watch: subscribe', { sessionId, url: ARCHIVE_STREAM_PATH })
  let closing = false
  controller.add(() => source.close())
  source.addEventListener('open', () => console.warn('[dsh-tauri] archive-watch: open'))
  source.addEventListener('error', () => console.warn('[dsh-tauri] archive-watch: error', { readyState: source.readyState }))
  source.addEventListener('message', (event) => {
    if (closing)
      return
    const archived = archivedSessionIds(event.data)
    if (archived?.includes(sessionId) !== true)
      return
    closing = true
    source.close()
    console.warn('[dsh-tauri] archive-watch: closing archived window', { sessionId })
    invokeParent({ type: 'dsh://window:close' })
  })
}

/** 解析宿主帧 `{"archivedSessionIds":[…]}`；格式不对当作没收到。 */
function archivedSessionIds(data: unknown): string[] | undefined {
  if (typeof data !== 'string')
    return undefined
  try {
    const payload = JSON.parse(data) as { archivedSessionIds?: unknown }
    return Array.isArray(payload.archivedSessionIds) ? payload.archivedSessionIds.map(String) : undefined
  }
  catch {
    return undefined
  }
}

export function presentFullSidebar(controller: RegisterController): void {
  document.documentElement.setAttribute(FULL_SIDEBAR_ATTRIBUTE, FULL_SIDEBAR_PRESENTING)
  document.body?.style.setProperty('visibility', 'hidden', 'important')
  let ticks = 0
  let expandClicked = false
  const cancel = controller.interval(() => {
    ticks += 1
    const settle = () => {
      cancel()
      document.documentElement.setAttribute(FULL_SIDEBAR_ATTRIBUTE, FULL_SIDEBAR_READY)
      document.body?.style.removeProperty('visibility')
      console.warn('[dsh-tauri] present: ready', { ticks })
      invokeParent({ type: FULL_SIDEBAR_READY_MESSAGE })
    }
    if (ticks > PRESENT_MAX_TICKS) {
      settle()
      return
    }
    const mode = document.querySelector<HTMLElement>(FULLSCREEN_SELECTOR)
    if (mode == null) {
      const expand = document.querySelector<HTMLElement>(EXPAND_SELECTOR)
      if (!expandClicked && expand !== null) {
        expandClicked = true
        expand.click()
      }
      return
    }
    if (mode.getAttribute('data-sidebar-right-mode') === 'fullscreen') {
      mode.click()
      return
    }
    settle()
  }, PRESENT_POLL_MS)
}

/** tab 全关会把整个右栏收掉：全屏形态窗口里只留一个 tab 时掐掉右键菜单。 */
function blockLastTabMenu(event: MouseEvent): void {
  if (!isFullSidebarDocument() || document.querySelectorAll(TAB_SELECTOR).length > 1)
    return
  const target = event.target as Element | null
  if (typeof target?.closest !== 'function' || target.closest(TAB_SELECTOR) === null)
    return
  event.preventDefault()
  event.stopPropagation()
}

export const sidebarFullwindowFeature = defineRegister((controller) => {
  const tooltip = createTooltip()
  controller.add(() => tooltip.dispose())
  const inject = () => {
    try {
      place(tooltip)
      guardLastTab()
    }
    catch (error) {
      reportPluginError(error)
    }
  }
  document.addEventListener('contextmenu', blockLastTabMenu, true)
  controller.add(() => document.removeEventListener('contextmenu', blockLastTabMenu, true))
  controller.observe(document.body, inject)
  inject()
})
