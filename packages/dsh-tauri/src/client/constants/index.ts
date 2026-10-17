export { PLUGIN_ID } from '../../shared/constants'

export const MOBILE_POINTER_QUERIES = ['(hover: none)', '(any-pointer: coarse)', '(any-hover: none)'] as const

/**
 * issue #1128：官方布局在 1024px 以上走桌面，触屏笔记本同样命中三条指针查询；
 * 移动布局必须叠加同一门槛，否则桌面布局会被移动表的 `!important` 隐藏规则掏空。
 */
export const MOBILE_BREAKPOINT = 1024

export const MOBILE_MEDIA_QUERIES = [
  ...MOBILE_POINTER_QUERIES,
  `(max-width: ${MOBILE_BREAKPOINT - 1}px)`,
] as const

/**
 * 官方「新建会话」按钮：适配层的 DOM 退级目标，同时是侧边栏 UI 微调的居中目标。
 *
 * 与官方 aria-label 逐字一致（中英双语各一条）；绝不用生成的 CSS module 哈希。
 */
export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
