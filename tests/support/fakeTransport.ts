/**
 * 内存版传输层：测试专用的 SocketLike 实现。
 *
 * - 通过实例方法模拟服务端行为（建连、断连、重连尝试、下发事件、应答）；
 * - `handle()` 可注册自动应答处理器，模拟完整服务端；
 * - 所有通信都在内存中完成，不触碰真实网络。
 */

import { createSocket } from "../../src/SocketManager.ts";
import type { SocketManager } from "../../src/SocketManager.ts";
import type {
  Scheduler,
  SocketConfig,
  TransportOptions,
} from "../../src/types.ts";
import type { SocketFactory, SocketLike } from "../../src/transport.ts";

type AnyHandler = (...args: unknown[]) => void;
type ServerHandler = (payload: unknown) => unknown | Promise<unknown>;

export interface RecordedEmit {
  event: string;
  payload: unknown;
  ack?: (response: unknown) => void;
}

export class FakeSocket implements SocketLike {
  connected = false;
  id: string | undefined;
  disposed = false;
  auth: unknown;

  /** 记录所有外发事件（按发送顺序） */
  readonly emits: RecordedEmit[] = [];

  #handlers = new Map<string, Set<AnyHandler>>();
  #anyHandlers = new Set<(event: string, ...args: unknown[]) => void>();
  #serverHandlers = new Map<string, ServerHandler>();

  on(event: string, handler: AnyHandler): void {
    let group = this.#handlers.get(event);
    if (!group) {
      group = new Set();
      this.#handlers.set(event, group);
    }
    group.add(handler);
  }

  once(event: string, handler: AnyHandler): void {
    const wrapper: AnyHandler = (...args: unknown[]) => {
      this.off(event, wrapper);
      handler(...args);
    };
    this.on(event, wrapper);
  }

  off(event: string, handler?: AnyHandler): void {
    const group = this.#handlers.get(event);
    if (!group) return;
    if (handler) {
      group.delete(handler);
      if (group.size === 0) this.#handlers.delete(event);
    } else {
      this.#handlers.delete(event);
    }
  }

  onAny(handler: (event: string, ...args: unknown[]) => void): void {
    this.#anyHandlers.add(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    if (this.disposed) return;

    let ack: ((response: unknown) => void) | undefined;
    if (args.length > 0 && typeof args[args.length - 1] === "function") {
      ack = args.pop() as (response: unknown) => void;
    }
    const payload = args[0];
    this.emits.push({ event, payload, ack });

    const handler = this.#serverHandlers.get(event);
    if (handler && ack) {
      Promise.resolve()
        .then(() => handler(payload))
        .then(
          result => ack!(result ?? { success: true }),
          (error: unknown) =>
            ack!({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
    }
  }

  setAuth(auth: unknown): void {
    this.auth = auth;
  }

  dispose(): void {
    this.disposed = true;
    this.connected = false;
    this.#handlers.clear();
    this.#anyHandlers.clear();
  }

  // ------------------------------------------------------------ 服务端模拟

  /** 注册服务端命令处理器，其返回值会作为 ack 应答 */
  handle(event: string, handler: ServerHandler): void {
    this.#serverHandlers.set(event, handler);
  }

  /** 模拟服务端接受连接 */
  serverConnect(id = "fake-socket-id"): void {
    this.connected = true;
    this.id = id;
    this.dispatch("connect");
  }

  /** 模拟连接断开 */
  serverDisconnect(reason = "transport close"): void {
    this.connected = false;
    this.id = undefined;
    this.dispatch("disconnect", reason);
  }

  /** 模拟连接错误 */
  serverConnectError(message = "connection refused"): void {
    this.connected = false;
    this.dispatch("connectError", new Error(message));
  }

  /** 模拟自动重连尝试 */
  serverReconnectAttempt(attempt: number): void {
    this.dispatch("reconnectAttempt", attempt);
  }

  /** 模拟服务端主动下发事件 */
  serverEmit(event: string, ...args: unknown[]): void {
    this.dispatch(event, ...args);
  }

  /** 手动应答最近一条指定事件的外发请求 */
  serverAck(event: string, response: unknown): boolean {
    for (let i = this.emits.length - 1; i >= 0; i--) {
      const record = this.emits[i];
      if (record.event === event && record.ack) {
        const ack = record.ack;
        record.ack = undefined;
        ack(response);
        return true;
      }
    }
    return false;
  }

  /** 获取最近一条外发事件（可按事件名过滤） */
  lastEmit(event?: string): RecordedEmit | undefined {
    for (let i = this.emits.length - 1; i >= 0; i--) {
      if (!event || this.emits[i].event === event) {
        return this.emits[i];
      }
    }
    return undefined;
  }

  /** 统计某事件的外发次数 */
  emitCount(event: string): number {
    return this.emits.filter(record => record.event === event).length;
  }

  private dispatch(event: string, ...args: unknown[]): void {
    const group = this.#handlers.get(event);
    if (group) {
      for (const handler of [...group]) {
        handler(...args);
      }
    }
    for (const handler of [...this.#anyHandlers]) {
      handler(event, ...args);
    }
  }
}

/** 测试传输工厂：记录创建参数并持有所有实例 */
export class FakeTransport {
  readonly instances: FakeSocket[] = [];
  lastCreate: { url: string; options: TransportOptions } | undefined;

  /** 在任何传输实例创建之前就存在的“服务端行为”，创建实例时自动挂载 */
  #defaultHandlers = new Map<string, ServerHandler>();

  /** 最近一次创建的 socket（通常也是当前活跃连接） */
  get socket(): FakeSocket {
    const socket = this.instances[this.instances.length - 1];
    if (!socket) {
      throw new Error("FakeTransport 尚未创建任何 socket");
    }
    return socket;
  }

  /** 预注册服务端命令处理器（对所有后续创建的实例生效） */
  handle(event: string, handler: ServerHandler): void {
    this.#defaultHandlers.set(event, handler);
  }

  create: SocketFactory = (url, options): SocketLike => {
    const socket = new FakeSocket();
    this.#defaultHandlers.forEach((handler, event) => {
      socket.handle(event, handler);
    });
    this.instances.push(socket);
    this.lastCreate = { url, options };
    return socket;
  };
}

export interface TestClient {
  socket: SocketManager;
  transport: FakeTransport;
  scheduler?: Scheduler;
}

/** 创建带内存传输层的测试客户端 */
export function createTestClient(
  configOverrides: Partial<SocketConfig> = {},
  options: { scheduler?: Scheduler } = {},
): TestClient {
  const transport = new FakeTransport();
  const config: SocketConfig = {
    url: "http://fake-server",
    namespace: "/chat",
    timeout: 5000,
    ...configOverrides,
  };
  const socket = createSocket(config, {
    transport: transport.create,
    scheduler: options.scheduler,
  });
  return { socket, transport, scheduler: options.scheduler };
}

/** 建连 helper：触发 connect 并立即模拟服务端接受 */
export async function connectClient(
  client: TestClient,
  socketId?: string,
): Promise<void> {
  const promise = client.socket.connect();
  client.transport.socket.serverConnect(socketId);
  await promise;
}

/** 排空异步 ack 的微任务队列 */
export async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}
