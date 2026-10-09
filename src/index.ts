/**
 * @vakao-ui/socket-system
 *
 * 基于 socket.io-client 的轻量、类型安全、无框架依赖的 Socket 库。
 *
 * 统一入口，所有能力都从一个 {@link SocketManager} 实例获得：
 *
 * @example
 * ```ts
 * import { createSocket } from "@vakao-ui/socket-system";
 *
 * const socket = createSocket({
 *   url: "https://socket.example.com",
 *   namespace: "/chat",
 *   auth: { token: "your-jwt-token" },
 * });
 *
 * const offMessage = socket.onMessage(message => console.log(message));
 *
 * await socket.connect();
 * await socket.joinRoom("room-1", "user-123");
 * await socket.sendMessage("room-1", "hello");
 *
 * offMessage();
 * await socket.leaveRoom("room-1");
 * socket.disconnect();
 * ```
 */

// 核心
export { SocketManager, createSocket } from "./SocketManager.ts";
export type { SocketManagerDependencies } from "./SocketManager.ts";

// 聊天门面
export { createChatSocket } from "./chat.ts";
export type {
  ChatMessage,
  ChatMessageStatus,
  ChatSocket,
  ChatSocketOptions,
} from "./chat.ts";

// 错误
export { SocketError, SocketErrorType, isSocketError } from "./errors.ts";

// 协议常量与事件类型
export { ClientCommand, SocketEvent } from "./events.ts";
export type { SocketListenerMap } from "./events.ts";

// 传输层扩展点
export { socketIoFactory, TransportEvent } from "./transport.ts";
export type { SocketFactory, SocketLike } from "./transport.ts";

// 数据类型与扩展点
export type {
  AckResponse,
  ConnectionInfo,
  EventListener,
  MessageData,
  RoomEventPayload,
  Scheduler,
  ServerRoomItem,
  SocketConfig,
  SocketStatus,
  TransportOptions,
} from "./types.ts";
