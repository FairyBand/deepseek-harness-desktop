import type { HostContext } from '../types'

/**
 * 存储域变更广播：官方把归档集合的变化以 `domain/changed` 发出（会话右栏、归档面板
 * 都靠它刷新），本仓库的宿主类型面没有引入该事件声明，在此收窄一次。
 */
interface DomainChangeSource {
  on: (name: 'domain/changed', listener: () => void) => () => void
}

/**
 * 宿主侧兜底轮询：`domain/changed` 在插件热重载后可能不再送达既有连接，靠这条
 * 兜底保证已打开的窗口仍能收到归档变化（集合未变不会重复推送）。
 */
const ARCHIVE_POLL_MS = 1_000

/**
 * 订阅归档集合：接入即先行推送当前快照（晚连上的窗口也要立刻知道现状），此后集合
 * 变化时再推（事件 + 轮询双通道，去重后只推一次）。
 * @param ctx - 宿主上下文（读注册表的权威归档集合）。
 * @param sink - 每次集合变化收到一份完整归档 id 列表。
 * @returns 取消订阅。
 */
export function watchArchive(ctx: HostContext, sink: (archived: readonly string[]) => void): () => void {
  let delivered = ''
  const push = (): void => {
    const archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    const next = archived.join('\n')
    if (next === delivered)
      return
    delivered = next
    sink(archived)
  }
  push()
  const poll = setInterval(push, ARCHIVE_POLL_MS)
  const detach = (ctx as unknown as DomainChangeSource).on('domain/changed', push)
  return () => {
    clearInterval(poll)
    detach()
  }
}
