import { socketManager, type ConnectionInfo, type ServerRoomItem, SocketError, SocketErrorType } from './socketManager'
/**
 * 轻量函数式 Socket 封装（无 Vue）
 * 提供房间加入、连接信息、事件订阅与基本操作的简洁接口。
 */

/** 加入房间 */
export function joinRoom(room: string, userId?: string): Promise<void> {
  if (!room?.trim()) {
    throw new SocketError(SocketErrorType.ROOM_JOIN_FAILED, '房间名不能为空')
  }
  return socketManager.joinRoom(room, userId)
}

/** 获取已加入的房间列表 */
export function getJoinedRooms(): string[] {
  return socketManager.getJoinedRooms()
}

/** 建立连接 */
export function connect(): Promise<void> {
  return socketManager.connect()
}

/** 断开连接 */
export function disconnect(): void {
  return socketManager.disconnect()
}

/** 获取服务器房间列表 */
export function getRooms(): Promise<ServerRoomItem[]> {
  return socketManager.getRooms()
}

/** 获取连接信息快照 */
export function getConnectionInfo(): ConnectionInfo {
  return socketManager.getConnectionInfo()
}

/** 订阅事件 */
export function on(event: string, callback: (...args: unknown[]) => void): () => void {
  socketManager.on(event, callback)
  return () => socketManager.off(event, callback)
}

/** 取消事件订阅 */
export function off(event: string, callback?: (...args: unknown[]) => void): void {
  socketManager.off(event, callback)
}

/** 发送自定义事件 */
export function emit(event: string, data?: unknown): void {
  socketManager.emit(event, data)
}
