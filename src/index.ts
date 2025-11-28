import { socketManager } from "./socketManager";
/**
 * 顶层简洁 API 暴露
 * 提供连接、断开、消息发送与消息监听接口。
 */

/** 建立 Socket 连接 */
export function connect(): Promise<void> {
  return socketManager.connect();
}

/** 断开 Socket 连接 */
export function disconnect(): void {
  return socketManager.disconnect();
}

/**
 * 发送文本消息
 * @param roomId 目标房间ID
 * @param content 文本内容
 */
export function sendMessage(roomId: string, content: string): Promise<void> {
  return socketManager.sendMessage(roomId, content);
}

/**
 * 监听服务端消息事件（标准化消息结构）
 * @returns 取消订阅函数
 */
export function onMessage(callback: (...args: unknown[]) => void): () => void {
  socketManager.on("message", callback);
  return () => socketManager.off("message", callback);
}

/** 错误与类型导出 */
export { SocketError, SocketErrorType, SocketManager } from "./socketManager";
export type {
  ConnectionInfo,
  EventCallback,
  MessageData,
  RoomResponse,
  SocketConfig,
  ServerRoomItem,
} from "./socketManager";
