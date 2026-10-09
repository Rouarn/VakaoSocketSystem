/**
 * 协议常量与事件类型映射。
 * 集中管理事件名，避免散落在代码中的魔法字符串。
 */

import type {
  ConnectionInfo,
  MessageData,
  RoomEventPayload,
} from "./types.ts";
import type { SocketError } from "./errors.ts";

/** 客户端 -> 服务端的命令事件名 */
export const ClientCommand = {
  JoinRoom: "join-room",
  LeaveRoom: "leave-room",
  SendMessage: "send-message",
  GetRooms: "get-rooms",
} as const;

/** 管理器对外抛出的生命周期事件名 */
export const SocketEvent = {
  /** 首次连接成功 */
  Connect: "connect",
  /** 连接断开（被动断开或主动断开） */
  Disconnect: "disconnect",
  /** 正在尝试自动重连，载荷为第几次尝试 */
  Reconnecting: "reconnecting",
  /** 断线后重新连接成功（房间恢复完成后触发） */
  Reconnected: "reconnected",
  /** 连接信息快照发生变化 */
  StateChange: "stateChange",
  /** 发生连接级错误（重连失败、房间恢复失败等） */
  Error: "error",
  /** 收到服务端广播的标准化消息 */
  Message: "message",
  /** 成功加入房间（含重连后的自动恢复） */
  RoomJoined: "roomJoined",
  /** 成功离开房间 */
  RoomLeft: "roomLeft",
} as const;

/**
 * 内置事件与其监听器参数的映射。
 * 已知事件可获得精确的参数类型推断，自定义服务端事件退化为通用参数。
 */
export interface SocketListenerMap {
  connect: [];
  disconnect: [reason?: string];
  reconnecting: [attempt: number];
  reconnected: [];
  stateChange: [info: ConnectionInfo];
  error: [error: SocketError];
  message: [message: MessageData];
  roomJoined: [payload: RoomEventPayload];
  roomLeft: [payload: Pick<RoomEventPayload, "roomId">];
}
