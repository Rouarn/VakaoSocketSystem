/**
 * SocketManager —— 库的核心类。
 *
 * 职责：连接生命周期、自动重连与房间恢复、房间管理、标准化消息通信、
 * 类型安全的事件订阅，以及统一的错误处理。
 *
 * 设计原则：
 * - 实例化使用（推荐通过 {@link createSocket}），不持有任何全局单例；
 * - 传输层（{@link SocketFactory}）与计时器（{@link Scheduler}）均可注入，
 *   因此无需真实网络即可进行完整的单元测试与集成测试；
 * - 所有订阅方法均返回取消订阅函数。
 */

import { SocketError, SocketErrorType } from "./errors.ts";
import { ClientCommand, SocketEvent } from "./events.ts";
import type { SocketListenerMap } from "./events.ts";
import { EventEmitter } from "./emitter.ts";
import { defaultScheduler } from "./scheduler.ts";
import {
  socketIoFactory,
  TransportEvent,
  type SocketFactory,
  type SocketLike,
} from "./transport.ts";
import type {
  AckResponse,
  ConnectionInfo,
  EventListener,
  MessageData,
  RoomEventPayload,
  Scheduler,
  ServerRoomItem,
  SocketConfig,
  TransportOptions,
} from "./types.ts";

/** 可注入的依赖 */
export interface SocketManagerDependencies {
  /** 传输层工厂，默认使用 socket.io-client */
  transport?: SocketFactory;
  /** 计时器，默认使用宿主全局 setTimeout/clearTimeout */
  scheduler?: Scheduler;
}

interface ResolvedConfig {
  url: string;
  namespace: string;
  auth?: {
    token?: string;
  };
  userId?: string;
  reconnection: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  timeout: number;
  transports: string[];
}

/** 传输层的生命周期事件，不直接透传给业务监听器 */
const TRANSPORT_LIFECYCLE_EVENTS = new Set<string>([
  TransportEvent.Connect,
  TransportEvent.Disconnect,
  TransportEvent.ConnectError,
  TransportEvent.ReconnectAttempt,
]);

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export class SocketManager {
  #config: ResolvedConfig;
  readonly #factory: SocketFactory;
  readonly #scheduler: Scheduler;
  readonly #emitter = new EventEmitter();

  #socket: SocketLike | null = null;
  #state: ConnectionInfo = { status: "disconnected", reconnectCount: 0 };

  /** roomId -> userId；断线期间保留，用于重连后自动恢复 */
  #rooms = new Map<string, string>();
  /** 管理器生命周期内复用的当前用户 ID */
  #userId: string | undefined;

  #connectPromise: Promise<void> | null = null;
  #connectReject: ((error: SocketError) => void) | null = null;
  #hasConnected = false;

  /** 待应答请求的取消器：连接关闭时统一拒绝，避免 Promise 悬挂 */
  #pendingRequests = new Set<(error: SocketError) => void>();

  constructor(
    config: SocketConfig,
    dependencies: SocketManagerDependencies = {},
  ) {
    if (!config || typeof config.url !== "string" || !config.url.trim()) {
      throw new TypeError("SocketConfig.url 必须是非空字符串");
    }

    this.#config = {
      url: config.url.trim(),
      namespace: config.namespace ?? "",
      auth: config.auth,
      userId: config.userId,
      reconnection: config.reconnection ?? true,
      reconnectionAttempts: config.reconnectionAttempts ?? 5,
      reconnectionDelay: config.reconnectionDelay ?? 1000,
      timeout: config.timeout ?? 20000,
      transports: config.transports ?? ["websocket"],
    };

    this.#factory = dependencies.transport ?? socketIoFactory;
    this.#scheduler = dependencies.scheduler ?? defaultScheduler;
  }

  // ---------------------------------------------------------------- 连接管理

  /**
   * 建立连接。
   * - 已连接时立即 resolve；
   * - 连接进行中重复调用返回同一个 Promise（幂等）。
   */
  connect(): Promise<void> {
    if (this.#socket?.connected) {
      return Promise.resolve();
    }
    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    const socket = this.#factory(this.endpoint, this.transportOptions);
    this.#socket = socket;
    this.#hasConnected = false;
    this.bindTransport(socket);
    this.setState({
      status: "connecting",
      socketId: undefined,
      lastError: undefined,
    });

    this.#connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timerHandle: unknown;

      const finish = (): void => {
        this.#scheduler.clearTimeout(timerHandle);
        socket.off(TransportEvent.Connect, handleConnect);
        socket.off(TransportEvent.ConnectError, handleError);
        this.#connectReject = null;
        this.#connectPromise = null;
      };

      const handleConnect = (): void => {
        if (settled) return;
        settled = true;
        finish();
        resolve();
      };

      const handleError: EventListener = (...args: unknown[]): void => {
        if (settled) return;
        settled = true;
        finish();
        const error = args[0] as { message?: string } | undefined;
        this.destroySocket(socket);
        reject(
          new SocketError(
            SocketErrorType.CONNECTION_FAILED,
            error?.message ?? "连接失败",
            error,
          ),
        );
      };

      this.#connectReject = (error: SocketError): void => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      };

      timerHandle = this.#scheduler.setTimeout((): void => {
        if (settled) return;
        settled = true;
        finish();
        this.destroySocket(socket);
        this.setState({
          status: "error",
          socketId: undefined,
          lastError: "连接超时",
        });
        reject(new SocketError(SocketErrorType.TIMEOUT, "连接超时"));
      }, this.#config.timeout);

      socket.once(TransportEvent.Connect, handleConnect);
      socket.once(TransportEvent.ConnectError, handleError);
    });

    return this.#connectPromise;
  }

  /** 主动断开连接并清空所有会话状态（幂等） */
  disconnect(): void {
    const wasConnecting = this.#connectPromise !== null;
    const rejectConnect = this.#connectReject;
    const socket = this.#socket;

    this.#connectPromise = null;
    this.#connectReject = null;
    this.#socket = null;
    this.#hasConnected = false;

    if (socket) {
      this.destroySocket(socket);
    }

    if (!wasConnecting && !socket) {
      return;
    }

    this.#rooms.clear();
    this.#userId = undefined;
    this.setState({
      status: "disconnected",
      socketId: undefined,
      reconnectCount: 0,
      lastError: undefined,
    });
    this.#emitter.emit(SocketEvent.Disconnect, "client disconnect");

    if (wasConnecting && rejectConnect) {
      rejectConnect(
        new SocketError(
          SocketErrorType.CONNECTION_CANCELLED,
          "连接已被 disconnect() 取消",
        ),
      );
    }
  }

  /** 当前是否已连接 */
  isConnected(): boolean {
    return this.#socket?.connected === true;
  }

  /** 获取连接信息快照 */
  getState(): ConnectionInfo {
    return { ...this.#state };
  }

  /**
   * 设置/更新认证令牌。
   * 连接存活期间调用会作用于下一次重连握手；建议在首次连接前设置。
   */
  setAuthToken(token?: string): void {
    this.#config.auth = token ? { token } : undefined;
    this.#socket?.setAuth?.(this.#config.auth);
  }

  // ---------------------------------------------------------------- 房间管理

  /**
   * 加入房间，重连后会自动重新加入。
   * @param roomId 房间 ID
   * @param userId 用户 ID；不传时使用配置中的 userId 或自动生成并复用
   */
  async joinRoom(roomId: string, userId?: string): Promise<void> {
    const room = this.assertRoomId(roomId, SocketErrorType.ROOM_JOIN_FAILED);
    const uid = this.resolveUserId(userId);

    const response = await this.emitWithAck<AckResponse>(
      ClientCommand.JoinRoom,
      { roomId: room, userId: uid },
      SocketErrorType.ROOM_JOIN_FAILED,
      "加入房间超时",
    );

    if (!response?.success) {
      throw new SocketError(
        SocketErrorType.ROOM_JOIN_FAILED,
        response?.error || "加入房间失败",
      );
    }

    this.#rooms.set(room, uid);
    this.#emitter.emit(SocketEvent.RoomJoined, {
      roomId: room,
      userId: uid,
    } satisfies RoomEventPayload);
  }

  /**
   * 离开房间。
   * 只能离开当前已加入（含重连已恢复）的房间。
   */
  async leaveRoom(roomId: string): Promise<void> {
    const room = this.assertRoomId(roomId, SocketErrorType.ROOM_LEAVE_FAILED);
    const uid = this.#rooms.get(room);

    if (!uid) {
      throw new SocketError(
        SocketErrorType.ROOM_LEAVE_FAILED,
        "尚未加入该房间，无需离开",
      );
    }

    const response = await this.emitWithAck<AckResponse>(
      ClientCommand.LeaveRoom,
      { roomId: room, userId: uid },
      SocketErrorType.ROOM_LEAVE_FAILED,
      "离开房间超时",
    );

    if (!response?.success) {
      throw new SocketError(
        SocketErrorType.ROOM_LEAVE_FAILED,
        response?.error || "离开房间失败",
      );
    }

    this.#rooms.delete(room);
    this.#emitter.emit(SocketEvent.RoomLeft, { roomId: room });
  }

  /** 获取已成功加入的房间 ID 列表 */
  getJoinedRooms(): string[] {
    return [...this.#rooms.keys()];
  }

  /** 从服务端获取房间列表 */
  async getRooms(): Promise<ServerRoomItem[]> {
    const response = await this.emitWithAck<AckResponse>(
      ClientCommand.GetRooms,
      undefined,
      SocketErrorType.ROOMS_FETCH_FAILED,
      "获取房间列表超时",
    );

    const rooms = (response?.data as { rooms?: unknown } | undefined)?.rooms;

    if (!response?.success || !Array.isArray(rooms)) {
      throw new SocketError(
        SocketErrorType.ROOMS_FETCH_FAILED,
        response?.error || "获取房间列表失败",
      );
    }

    return rooms as ServerRoomItem[];
  }

  // ---------------------------------------------------------------- 消息通信

  /**
   * 发送标准化文本消息。
   * 自动填充消息 ID、时间戳与发送者 ID，内容会做首尾空白裁剪。
   */
  async sendMessage(roomId: string, content: string): Promise<void> {
    const room = this.assertRoomId(roomId, SocketErrorType.MESSAGE_SEND_FAILED);

    if (typeof content !== "string" || !content.trim()) {
      throw new SocketError(
        SocketErrorType.MESSAGE_SEND_FAILED,
        "消息内容不能为空",
      );
    }

    const message: MessageData = {
      id: generateId("msg"),
      room,
      content: content.trim(),
      ts: Date.now(),
      sender: this.#userId ?? this.#config.userId,
    };

    const response = await this.emitWithAck<AckResponse>(
      ClientCommand.SendMessage,
      message,
      SocketErrorType.MESSAGE_SEND_FAILED,
      "发送消息超时",
    );

    if (!response?.success) {
      throw new SocketError(
        SocketErrorType.MESSAGE_SEND_FAILED,
        response?.error || "发送消息失败",
      );
    }
  }

  /**
   * 发送自定义事件（无应答）。
   * 未连接或事件名为空时静默忽略，不抛异常。
   */
  emit(event: string, data?: unknown): void {
    if (!event || !this.#socket?.connected) return;
    this.#socket.emit(event, data);
  }

  // ---------------------------------------------------------------- 事件订阅

  /** 订阅内置事件（参数类型自动推断） */
  on<K extends keyof SocketListenerMap>(
    event: K,
    listener: (...args: SocketListenerMap[K]) => void,
  ): () => void;
  /** 订阅任意自定义服务端事件 */
  on(event: string, listener: EventListener): () => void;
  on(event: string, listener: EventListener): () => void {
    return this.#emitter.on(event, listener);
  }

  /** 订阅内置事件一次 */
  once<K extends keyof SocketListenerMap>(
    event: K,
    listener: (...args: SocketListenerMap[K]) => void,
  ): () => void;
  /** 订阅任意自定义事件一次 */
  once(event: string, listener: EventListener): () => void;
  once(event: string, listener: EventListener): () => void {
    return this.#emitter.once(event, listener);
  }

  /** 取消订阅；不传 listener 时移除该事件的全部监听器 */
  off(event: string, listener?: EventListener): void {
    this.#emitter.off(event, listener);
  }

  /** 移除全部事件监听器 */
  clearListeners(): void {
    this.#emitter.clear();
  }

  /** 监听服务端广播的标准化消息 */
  onMessage(listener: (message: MessageData) => void): () => void {
    return this.on(SocketEvent.Message, listener);
  }

  /** 监听连接信息变化 */
  onStateChange(listener: (info: ConnectionInfo) => void): () => void {
    return this.on(SocketEvent.StateChange, listener);
  }

  /** 监听连接级错误（重连失败、房间恢复失败等） */
  onError(listener: (error: SocketError) => void): () => void {
    return this.on(SocketEvent.Error, listener);
  }

  // ---------------------------------------------------------------- 内部实现

  /** 完整连接地址（url + namespace） */
  private get endpoint(): string {
    return `${this.#config.url.replace(/\/+$/, "")}${this.#config.namespace}`;
  }

  private get transportOptions(): TransportOptions {
    return {
      auth: this.#config.auth,
      reconnection: this.#config.reconnection,
      reconnectionAttempts: this.#config.reconnectionAttempts,
      reconnectionDelay: this.#config.reconnectionDelay,
      timeout: this.#config.timeout,
      transports: this.#config.transports,
    };
  }

  /** 更新连接状态并通知订阅者 */
  private setState(patch: Partial<ConnectionInfo>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emitter.emit(SocketEvent.StateChange, this.getState());
  }

  /** 绑定传输层生命周期事件与服务端事件透传 */
  private bindTransport(socket: SocketLike): void {
    socket.on(TransportEvent.Connect, () => {
      void this.handleConnect(socket);
    });
    socket.on(TransportEvent.Disconnect, (reason?: unknown) => {
      this.handleDisconnect(socket, reason);
    });
    socket.on(TransportEvent.ConnectError, (error?: unknown) => {
      this.handleConnectError(socket, error);
    });
    socket.on(TransportEvent.ReconnectAttempt, (attempt?: unknown) => {
      this.handleReconnectAttempt(attempt);
    });

    // 业务事件原样透传；生命周期事件由管理器统一语义化派发
    socket.onAny((event: string, ...args: unknown[]) => {
      if (!TRANSPORT_LIFECYCLE_EVENTS.has(event)) {
        this.#emitter.emit(event, ...args);
      }
    });
  }

  private async handleConnect(socket: SocketLike): Promise<void> {
    if (this.#socket !== socket) return;

    const isReconnect = this.#hasConnected;
    this.#hasConnected = true;
    this.setState({
      status: "connected",
      socketId: socket.id,
      lastConnectedAt: Date.now(),
      lastError: undefined,
      ...(isReconnect ? {} : { reconnectCount: 0 }),
    });

    this.#emitter.emit(
      isReconnect ? SocketEvent.Reconnected : SocketEvent.Connect,
    );

    if (isReconnect) {
      await this.restoreRooms(socket);
    }
  }

  private handleDisconnect(socket: SocketLike, reason?: unknown): void {
    if (this.#socket !== socket) return;

    const reasonText =
      typeof reason === "string" && reason ? reason : "unknown";

    // io server disconnect：服务端要求断开，socket.io 不会自动重连
    const willRetry =
      this.#config.reconnection &&
      reasonText !== "io server disconnect" &&
      reasonText !== "io client disconnect";

    this.setState({
      status: willRetry ? "connecting" : "disconnected",
      socketId: undefined,
      lastError: reasonText,
    });
    this.#emitter.emit(SocketEvent.Disconnect, reasonText);
  }

  private handleConnectError(socket: SocketLike, error?: unknown): void {
    if (this.#socket !== socket) return;

    const message =
      error instanceof Error
        ? error.message
        : ((error as { message?: string } | undefined)?.message ?? "连接错误");

    this.setState({ status: "error", lastError: message });
    this.#emitter.emit(
      SocketEvent.Error,
      new SocketError(SocketErrorType.CONNECTION_FAILED, message, error),
    );
  }

  private handleReconnectAttempt(attempt?: unknown): void {
    const count =
      typeof attempt === "number" && Number.isFinite(attempt)
        ? attempt
        : this.#state.reconnectCount + 1;

    this.setState({ status: "connecting", reconnectCount: count });
    this.#emitter.emit(SocketEvent.Reconnecting, count);
  }

  /** 重连成功后按记录重新加入房间；单个房间失败不影响其他房间 */
  private async restoreRooms(socket: SocketLike): Promise<void> {
    for (const [roomId, userId] of this.#rooms) {
      try {
        const response = await this.emitWithAckOnSocket<AckResponse>(
          socket,
          ClientCommand.JoinRoom,
          { roomId, userId },
          SocketErrorType.ROOM_JOIN_FAILED,
          "恢复房间超时",
        );
        if (!response?.success) {
          throw new SocketError(
            SocketErrorType.ROOM_JOIN_FAILED,
            response?.error || "恢复房间失败",
          );
        }
        this.#emitter.emit(SocketEvent.RoomJoined, { roomId, userId });
      } catch (error) {
        // 保留房间记录，下次重连仍会尝试恢复
        this.#emitter.emit(
          SocketEvent.Error,
          error instanceof SocketError
            ? error
            : new SocketError(
                SocketErrorType.ROOM_JOIN_FAILED,
                "重连后恢复房间失败",
                error,
              ),
        );
      }
    }
  }

  /** 关闭并释放传输实例，同时拒绝所有未完成的应答请求 */
  private destroySocket(socket: SocketLike): void {
    if (this.#socket === socket) {
      this.#socket = null;
    }
    const pending = [...this.#pendingRequests];
    this.#pendingRequests.clear();
    for (const cancel of pending) {
      cancel(
        new SocketError(
          SocketErrorType.CONNECTION_CANCELLED,
          "请求因连接关闭而取消",
        ),
      );
    }
    socket.dispose();
  }

  /** 发送需要服务端应答的事件，内置超时与连接关闭取消 */
  private emitWithAck<T>(
    event: string,
    payload: unknown,
    failureType: SocketErrorType,
    timeoutMessage: string,
  ): Promise<T> {
    const socket = this.#socket;
    if (!socket?.connected) {
      return Promise.reject(
        new SocketError(SocketErrorType.NOT_CONNECTED, "未连接到服务器"),
      );
    }
    return this.emitWithAckOnSocket<T>(
      socket,
      event,
      payload,
      failureType,
      timeoutMessage,
    );
  }

  private emitWithAckOnSocket<T>(
    socket: SocketLike,
    event: string,
    payload: unknown,
    failureType: SocketErrorType,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timerHandle: unknown;

      const done = (): void => {
        this.#scheduler.clearTimeout(timerHandle);
        this.#pendingRequests.delete(cancel);
      };

      const cancel = (error: SocketError): void => {
        done();
        reject(error);
      };
      this.#pendingRequests.add(cancel);

      timerHandle = this.#scheduler.setTimeout((): void => {
        cancel(new SocketError(SocketErrorType.TIMEOUT, timeoutMessage));
      }, this.#config.timeout);

      try {
        socket.emit(event, payload, (response: unknown): void => {
          done();
          resolve(response as T);
        });
      } catch (error) {
        cancel(new SocketError(failureType, "发送请求失败", error));
      }
    });
  }

  private assertRoomId(roomId: string, failureType: SocketErrorType): string {
    if (typeof roomId !== "string" || !roomId.trim()) {
      throw new SocketError(failureType, "房间ID不能为空");
    }
    return roomId.trim();
  }

  private resolveUserId(explicitUserId?: string): string {
    if (explicitUserId !== undefined) {
      const uid = explicitUserId.trim();
      if (!uid) {
        throw new SocketError(
          SocketErrorType.ROOM_JOIN_FAILED,
          "用户ID不能为空",
        );
      }
      this.#userId = uid;
      return uid;
    }

    if (!this.#userId) {
      this.#userId = this.#config.userId?.trim() || generateId("user");
    }
    return this.#userId;
  }
}

/**
 * 创建一个 Socket 管理器实例（推荐入口）。
 *
 * @example
 * ```ts
 * const socket = createSocket({ url: "https://socket.example.com", namespace: "/chat" });
 * await socket.connect();
 * ```
 */
export function createSocket(
  config: SocketConfig,
  dependencies?: SocketManagerDependencies,
): SocketManager {
  return new SocketManager(config, dependencies);
}
