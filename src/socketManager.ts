import { io, type Socket } from "socket.io-client";
/**
 * 核心 Socket 管理器（纯 TypeScript）
 * 提供连接管理、房间管理、消息通信与事件订阅，具备自动重连与完善错误处理。
 */

/** 连接状态 */
type ChatSocketStatus = "connected" | "connecting" | "disconnected" | "error";

/** Socket 初始化配置 */
interface SocketConfig {
  url: string;
  namespace?: string;
  autoConnect?: boolean;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  timeout?: number;
  transports?: string[];
  auth?: {
    token?: string;
  };
}

/** 连接信息快照 */
interface ConnectionInfo {
  status: ChatSocketStatus;
  socketId?: string;
  reconnectCount: number;
  lastConnectedAt?: number;
  lastError?: string;
}

/** 服务端通用响应结构 */
interface RoomResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/** 标准化消息结构 */
interface MessageData {
  id?: string;
  room: string;
  content: string;
  ts: number;
  sender?: string;
}

/** 服务端房间条目 */
interface ServerRoomItem {
  id: string;
  name: string;
  type: string;
  members: number;
}

/** 事件回调类型 */
type EventCallback = (...args: unknown[]) => void;

/** 错误类型枚举 */
enum SocketErrorType {
  CONNECTION_FAILED = "CONNECTION_FAILED",
  NOT_CONNECTED = "NOT_CONNECTED",
  ROOM_JOIN_FAILED = "ROOM_JOIN_FAILED",
  ROOM_LEAVE_FAILED = "ROOM_LEAVE_FAILED",
  MESSAGE_SEND_FAILED = "MESSAGE_SEND_FAILED",
  TIMEOUT = "TIMEOUT",
}

/** 统一的 Socket 错误对象 */
class SocketError extends Error {
  constructor(
    public type: SocketErrorType,
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = "SocketError";
  }
}

/**
 * Socket 管理器
 * 用法：
 * - 可选设置认证令牌：setAuthToken(token)
 * - 建立/断开连接：connect()/disconnect()
 * - 房间管理：joinRoom(roomId), leaveRoom(roomId)
 * - 消息通信：sendMessage(roomId, content)
 * - 事件订阅：on(event, cb)/off(event, cb)
 */
class SocketManager {
  private socket: Socket | null = null;
  private config: SocketConfig;
  private info: ConnectionInfo = { status: "disconnected", reconnectCount: 0 };
  private listeners = new Map<string, Set<EventCallback>>();
  private joinedRooms = new Set<string>();
  private connectionPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentUserId: string | null = null;

  constructor(config?: Partial<SocketConfig>) {
    this.config = {
      url: "",
      namespace: "",
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 20000,
      transports: ["websocket"],
      ...config,
    };
  }
  /**
   * 设置认证令牌（可选）
   * @param token 认证 Token
   */
  setAuthToken(token?: string): void {
    this.config.auth = { token };
  }

  /** 建立 Socket 连接 */
  connect(): Promise<void> {
    // 如果已经在连接中，返回现有的Promise
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      if (this.socket?.connected) {
        this.info.status = "connected";
        this.connectionPromise = null;
        resolve();
        return;
      }

      try {
        const socketUrl = `${this.config.url}${this.config.namespace || ""}`;
        const token = this.config.auth?.token;
        const socketConfig = {
          ...this.config,
          auth: token ? { token } : undefined,
          query: token ? { token } : undefined,
        };

        this.socket = io(socketUrl, socketConfig);

        this.info.status = "connecting";
        this.setupSocketListeners();

        // 连接超时处理
        const timeoutId = setTimeout(() => {
          this.connectionPromise = null;
          reject(new SocketError(SocketErrorType.TIMEOUT, "连接超时"));
        }, this.config.timeout);

        this.socket.on("connect", () => {
          clearTimeout(timeoutId);
          this.info = {
            ...this.info,
            status: "connected",
            socketId: this.socket?.id,
            reconnectCount: 0,
            lastConnectedAt: Date.now(),
            lastError: undefined,
          };
          this.connectionPromise = null;
          resolve();
        });

        this.socket.on("connect_error", (err: Error | undefined) => {
          clearTimeout(timeoutId);
          this.info = {
            ...this.info,
            status: "error",
            lastError: err?.message,
          };
          this.connectionPromise = null;
          reject(
            new SocketError(
              SocketErrorType.CONNECTION_FAILED,
              err?.message ?? "",
              err
            )
          );
        });
      } catch (error) {
        this.connectionPromise = null;
        reject(
          new SocketError(
            SocketErrorType.CONNECTION_FAILED,
            "创建连接失败",
            error as Error
          )
        );
      }
    });

    return this.connectionPromise;
  }

  /** 绑定基础连接事件监听 */
  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on("disconnect", (reason: any) => {
      this.info = {
        ...this.info,
        status: "disconnected",
        socketId: undefined,
        lastError: reason,
      };
      this.joinedRooms.clear();
    });

    this.socket.on("reconnect_attempt", (attemptNumber: number) => {
      this.info.reconnectCount = attemptNumber;
    });

    this.socket.on("reconnect", () => {
      this.info = {
        ...this.info,
        status: "connected",
        lastConnectedAt: Date.now(),
        lastError: undefined,
      };
      this.clearReconnectTimer();
      this.rejoinRooms();
      this.rebindListeners();
    });

    this.socket.on("reconnect_failed", () => {
      this.info = {
        ...this.info,
        status: "error",
        lastError: "重连失败",
      };
    });
  }

  /** 清理重连计时器 */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 在重连后自动重新加入之前的房间 */
  private async rejoinRooms(): Promise<void> {
    const rooms = [...this.joinedRooms];
    this.joinedRooms.clear();

    for (const room of rooms) {
      try {
        await this.joinRoom(room);
      } catch {}
    }
  }

  /** 主动断开连接并重置状态 */
  disconnect(): void {
    this.connectionPromise = null;

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    this.joinedRooms.clear();
    this.info = { status: "disconnected", reconnectCount: 0 };
  }

  /** 获取当前连接信息（快照） */
  getConnectionInfo(): ConnectionInfo {
    return { ...this.info };
  }

  /** 当前是否处于连接状态 */
  isConnected(): boolean {
    return this.info.status === "connected" && this.socket?.connected === true;
  }

  /**
   * 加入房间
   * @param roomId 房间ID
   * @param userId 可选用户ID
   */
  async joinRoom(roomId: string, userId?: string): Promise<void> {
    if (!roomId?.trim()) {
      throw new SocketError(SocketErrorType.ROOM_JOIN_FAILED, "房间ID不能为空");
    }

    if (!this.isConnected()) {
      throw new SocketError(SocketErrorType.NOT_CONNECTED, "未连接到服务器");
    }

    // 生成默认的userId如果没有提供
    const finalUserId =
      userId || `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new SocketError(SocketErrorType.TIMEOUT, "加入房间超时"));
      }, this.config.timeout);

      const joinData = {
        roomId,
        userId: finalUserId,
      };

      this.socket!.emit("join-room", joinData, (res: RoomResponse) => {
        clearTimeout(timeoutId);
        if (res?.success) {
          this.joinedRooms.add(roomId);
          this.currentUserId = finalUserId;
          this.listeners
            .get("room_joined")
            ?.forEach(cb => cb({ roomId, userId: finalUserId }));
          resolve();
        } else {
          reject(
            new SocketError(
              SocketErrorType.ROOM_JOIN_FAILED,
              res?.error || "加入房间失败"
            )
          );
        }
      });
    });
  }

  /**
   * 离开房间
   * @param roomId 房间ID
   */
  async leaveRoom(roomId: string): Promise<void> {
    if (!roomId?.trim()) {
      throw new SocketError(
        SocketErrorType.ROOM_LEAVE_FAILED,
        "房间ID不能为空"
      );
    }

    if (!this.isConnected()) {
      throw new SocketError(SocketErrorType.NOT_CONNECTED, "未连接到服务器");
    }

    if (!this.currentUserId) {
      throw new SocketError(
        SocketErrorType.ROOM_LEAVE_FAILED,
        "用户ID不存在，请先加入房间"
      );
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new SocketError(SocketErrorType.TIMEOUT, "离开房间超时"));
      }, this.config.timeout);

      const leaveData = {
        roomId,
        userId: this.currentUserId!,
      };

      this.socket!.emit("leave-room", leaveData, (res: RoomResponse) => {
        clearTimeout(timeoutId);
        if (res?.success) {
          this.joinedRooms.delete(roomId);
          this.listeners.get("room_left")?.forEach(cb => cb({ roomId }));
          resolve();
        } else {
          reject(
            new SocketError(
              SocketErrorType.ROOM_LEAVE_FAILED,
              res?.error || "离开房间失败"
            )
          );
        }
      });
    });
  }

  /** 获取已加入的房间列表 */
  getJoinedRooms(): string[] {
    return [...this.joinedRooms];
  }

  /**
   * 发送消息
   * @param roomId 目标房间ID
   * @param content 文本内容
   */
  async sendMessage(roomId: string, content: string): Promise<void> {
    if (!roomId?.trim()) {
      throw new SocketError(
        SocketErrorType.MESSAGE_SEND_FAILED,
        "房间ID不能为空"
      );
    }

    if (!content?.trim()) {
      throw new SocketError(
        SocketErrorType.MESSAGE_SEND_FAILED,
        "消息内容不能为空"
      );
    }

    if (!this.isConnected()) {
      throw new SocketError(SocketErrorType.NOT_CONNECTED, "未连接到服务器");
    }

    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const messageData: MessageData = {
      id,
      room: roomId,
      content: content.trim(),
      ts: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new SocketError(SocketErrorType.TIMEOUT, "发送消息超时"));
      }, this.config.timeout);

      this.socket!.emit("send-message", messageData, (res: RoomResponse) => {
        clearTimeout(timeoutId);
        if (res?.success) {
          resolve();
        } else {
          reject(
            new SocketError(
              SocketErrorType.MESSAGE_SEND_FAILED,
              res?.error || "发送消息失败"
            )
          );
        }
      });
    });
  }

  /** 获取房间列表（服务器端提供） */
  async getRooms(): Promise<ServerRoomItem[]> {
    if (!this.isConnected()) {
      throw new SocketError(SocketErrorType.NOT_CONNECTED, "未连接到服务器");
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new SocketError(SocketErrorType.TIMEOUT, "获取房间列表超时"));
      }, this.config.timeout);

      this.socket!.emit("get-rooms", undefined, (res: RoomResponse) => {
        clearTimeout(timeoutId);
        if (
          res?.success &&
          res.data &&
          (res.data as Record<string, unknown>).rooms
        ) {
          const rooms = (res.data as { rooms: ServerRoomItem[] }).rooms;
          resolve(rooms);
        } else {
          reject(
            new SocketError(
              SocketErrorType.CONNECTION_FAILED,
              res?.error || "获取房间列表失败"
            )
          );
        }
      });
    });
  }

  /** 发送自定义事件（需连接状态） */
  emit(event: string, data?: unknown): void {
    if (!event) return;
    if (!this.isConnected()) return;
    this.socket!.emit(event, data);
  }

  /** 订阅事件 */
  on(event: string, cb: EventCallback): void {
    if (!event || typeof cb !== "function") return;

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);

    // 如果socket已连接，立即绑定事件
    if (this.socket) {
      this.socket.on(event, cb);
    }
  }

  /** 取消事件订阅 */
  off(event: string, cb?: EventCallback): void {
    if (!event) return;

    if (cb) {
      this.socket?.off(event, cb);
      this.listeners.get(event)?.delete(cb);

      // 如果该事件没有监听器了，删除整个事件
      if (this.listeners.get(event)?.size === 0) {
        this.listeners.delete(event);
      }
    } else {
      this.socket?.off(event);
      this.listeners.delete(event);
    }
  }

  /** 清理所有事件监听器 */
  clearAllListeners(): void {
    this.listeners.forEach((cbs, evt) => {
      cbs.forEach(cb => this.socket?.off(evt, cb));
    });
    this.listeners.clear();
  }

  /** 获取当前事件订阅列表 */
  getListenedEvents(): string[] {
    return Array.from(this.listeners.keys());
  }

  /** 重新绑定所有事件监听器（用于重连后） */
  private rebindListeners(): void {
    if (!this.socket) return;

    this.listeners.forEach((cbs, event) => {
      cbs.forEach(cb => {
        this.socket!.on(event, cb);
      });
    });
  }
}

export const socketManager = new SocketManager();

// 导出类型和错误类以便外部使用
export { SocketError, SocketErrorType, SocketManager };
export type {
  ConnectionInfo,
  EventCallback,
  MessageData,
  RoomResponse,
  SocketConfig,
  ServerRoomItem,
};
