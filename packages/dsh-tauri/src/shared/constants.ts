export const PLUGIN_ID = 'dsh-tauri'

/**
 * 宿主归档集合推送流：宿主侧监听存储域变更后即时下发，窗口侧据此判断自己看的会话
 * 是否已被归档（归档集合没有专属宿主事件，见 `host/service/archive.ts`）。
 */
export const ARCHIVE_STREAM_PATH = '/api/tauri/desktop/archive/events'
