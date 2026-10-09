/**
 * 统一的错误类型定义。
 * 库内所有可预期的失败都抛出 {@link SocketError}，便于调用方按类型分支处理。
 */

/** Socket 错误分类（常量对象 + 字面量联合，可被运行时直接擦除类型） */
export const SocketErrorType = {
  /** 建立连接失败（握手失败、网络不可达等） */
  CONNECTION_FAILED: "CONNECTION_FAILED",
  /** 连接过程中被主动取消（例如调用了 disconnect） */
  CONNECTION_CANCELLED: "CONNECTION_CANCELLED",
  /** 当前未连接，无法执行需要连接态的操作 */
  NOT_CONNECTED: "NOT_CONNECTED",
  /** 加入房间失败（参数非法、服务端拒绝、超时） */
  ROOM_JOIN_FAILED: "ROOM_JOIN_FAILED",
  /** 离开房间失败（参数非法、未加入房间、服务端拒绝、超时） */
  ROOM_LEAVE_FAILED: "ROOM_LEAVE_FAILED",
  /** 发送消息失败（参数非法、服务端拒绝、超时） */
  MESSAGE_SEND_FAILED: "MESSAGE_SEND_FAILED",
  /** 获取房间列表失败 */
  ROOMS_FETCH_FAILED: "ROOMS_FETCH_FAILED",
  /** 请求在规定时间内未得到服务端应答 */
  TIMEOUT: "TIMEOUT",
} as const;

export type SocketErrorType =
  (typeof SocketErrorType)[keyof typeof SocketErrorType];

/**
 * 统一的 Socket 错误对象。
 *
 * @example
 * ```ts
 * try {
 *   await socket.sendMessage("room-1", "hello");
 * } catch (error) {
 *   if (error instanceof SocketError) {
 *     console.error(error.type, error.message, error.cause);
 *   }
 * }
 * ```
 */
export class SocketError extends Error {
  /** 错误分类，可用于程序化分支判断 */
  readonly type: SocketErrorType;

  constructor(
    type: SocketErrorType,
    message: string,
    /** 触发该错误的原始错误（如有） */
    cause?: unknown,
  ) {
    super(message);
    this.name = "SocketError";
    this.type = type;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** 判断任意值是否为 {@link SocketError} */
export function isSocketError(value: unknown): value is SocketError {
  return value instanceof SocketError;
}
