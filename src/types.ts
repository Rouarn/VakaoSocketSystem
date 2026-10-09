/**
 * 公共数据类型定义。
 */

/** 连接状态 */
export type SocketStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** 创建 Socket 管理器时的配置项 */
export interface SocketConfig {
  /** 服务端地址，例如 `https://socket.example.com` */
  url: string;
  /** 命名空间路径，例如 `/chat`，默认无命名空间 */
  namespace?: string;
  /** 认证信息，会通过 socket.io 的 `auth` 与 `query` 传递 */
  auth?: {
    token?: string;
  };
  /**
   * 当前用户 ID。加入房间时若未单独传入 userId，则使用该值；
   * 均未提供时自动生成并在管理器生命周期内复用。
   */
  userId?: string;
  /** 是否开启自动重连，默认 `true` */
  reconnection?: boolean;
  /** 最大重连次数，默认 `5` */
  reconnectionAttempts?: number;
  /** 重连初始间隔（毫秒），默认 `1000` */
  reconnectionDelay?: number;
  /** 连接与各类应答的超时时间（毫秒），默认 `20000` */
  timeout?: number;
  /** 底层传输方式，默认 `["websocket"]` */
  transports?: string[];
}

/** 连接信息快照（不可变对象，每次获取都是拷贝） */
export interface ConnectionInfo {
  status: SocketStatus;
  /** 当前 socket 分配到的连接 ID */
  socketId?: string;
  /** 最近一次重连尝试序号（首次连接为 0） */
  reconnectCount: number;
  /** 最近一次连接成功的时间戳（毫秒） */
  lastConnectedAt?: number;
  /** 最近一次错误描述或断开原因 */
  lastError?: string;
}

/** 服务端通用应答结构 */
export interface AckResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/** 标准化消息结构（发送与接收统一） */
export interface MessageData {
  /** 消息唯一 ID（发送时自动生成） */
  id?: string;
  /** 目标房间 ID */
  room: string;
  /** 文本内容 */
  content: string;
  /** 时间戳（毫秒） */
  ts: number;
  /** 发送者用户 ID */
  sender?: string;
}

/** 服务端房间条目 */
export interface ServerRoomItem {
  id: string;
  name: string;
  type: string;
  members: number;
}

/** 房间事件负载 */
export interface RoomEventPayload {
  roomId: string;
  userId: string;
}

/** 通用事件回调 */
export type EventListener = (...args: unknown[]) => void;

/**
 * 计时器抽象。
 * 默认实现基于全局 `setTimeout/clearTimeout`；
 * 测试时可注入虚拟时钟，从而即时、确定性地验证超时逻辑。
 */
export interface Scheduler {
  setTimeout(handler: () => void, timeout?: number): unknown;
  clearTimeout(handle?: unknown): void;
}

/** 传输层创建所需的归一化选项 */
export interface TransportOptions {
  auth?: {
    token?: string;
  };
  reconnection: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  timeout: number;
  transports?: string[];
}
