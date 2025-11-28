import { socketManager, type ConnectionInfo } from './socketManager'
/**
 * 聊天 Socket 工具：连接状态监控与消息监听
 * 返回一组轻量方法以便于在任意环境中集成使用。
 */

/** 消息状态 */
export type ChatMessageStatus = 'sending' | 'sent' | 'failed'

/** 标准化聊天消息 */
export interface ChatMessage {
  id: string
  room: string
  sender?: string
  content: string
  ts: number
  self?: boolean
  status?: ChatMessageStatus
}

/**
 * 创建聊天 Socket 工具集
 * @returns { getState, onMessage, onStateChange, connect, disconnect }
 */
export function createChatSocket() {
  /** 获取当前连接状态快照 */
  function getState(): ConnectionInfo {
    return socketManager.getConnectionInfo()
  }

  /**
   * 监听消息事件并输出标准化消息对象
   * @returns 取消订阅函数
   */
  function onMessage(callback: (msg: ChatMessage) => void): () => void {
    const handler = (...args: unknown[]) => {
      const data = args[0] as Record<string, unknown>
      if (!data?.room || !data?.content) return
      const message: ChatMessage = {
        id: (data.id as string) || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        room: data.room as string,
        sender: data.sender as string,
        content: String(data.content),
        ts: (data.ts as number) || Date.now(),
        self: false,
        status: 'sent',
      }
      callback(message)
    }
    socketManager.on('message', handler)
    return () => socketManager.off('message', handler)
  }

  /**
   * 监听连接状态变化（connect/disconnect/reconnect/connect_error）
   * @returns 取消订阅函数
   */
  function onStateChange(callback: (info: ConnectionInfo) => void): () => void {
    const handler = () => callback(socketManager.getConnectionInfo())
    socketManager.on('connect', handler)
    socketManager.on('disconnect', handler)
    socketManager.on('reconnect', handler)
    socketManager.on('connect_error', handler)
    return () => {
      socketManager.off('connect', handler)
      socketManager.off('disconnect', handler)
      socketManager.off('reconnect', handler)
      socketManager.off('connect_error', handler)
    }
  }

  /** 建立连接 */
  function connect(): Promise<void> {
    return socketManager.connect()
  }

  /** 断开连接 */
  function disconnect(): void {
    socketManager.disconnect()
  }

  return { getState, onMessage, onStateChange, connect, disconnect }
}
