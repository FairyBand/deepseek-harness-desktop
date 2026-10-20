import type { HostContext } from '../../../../types'
import { getServerContext } from 'dsh-h3/utils'
import { defineEventHandler, EventStream } from 'h3'
import { watchArchive } from '../../../../service/archive'

const SSE_KEEPALIVE_COMMENT = 'keepalive'
const SSE_KEEPALIVE_MS = 25_000

/**
 * GET `ARCHIVE_STREAM_PATH` — 归档集合 SSE 流。
 *
 * 数据帧 `data: {"archivedSessionIds":[…]}\n\n`，接入即发当前快照；心跳注释帧
 * `: keepalive\n\n` 防止空闲断连。窗口侧的 `EventSource` 只认数据帧。
 */
export default defineEventHandler((event) => {
  const stream = new EventStream(event)
  // 接入即刷一帧注释：Node 的 writeHead 不会单独把响应头写出去，先让客户端确认连接就绪。
  void stream.pushComment(SSE_KEEPALIVE_COMMENT)

  const ctx = getServerContext<HostContext>(event)
  const detach = watchArchive(ctx, (archived) => {
    void stream.push({ data: JSON.stringify({ archivedSessionIds: archived }) })
  })
  const keepalive = setInterval(() => {
    void stream.pushComment(SSE_KEEPALIVE_COMMENT)
  }, SSE_KEEPALIVE_MS)

  stream.onClosed(() => {
    clearInterval(keepalive)
    detach()
  })
  return stream
})
