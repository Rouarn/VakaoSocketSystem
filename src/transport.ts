/**
 * 传输层抽象。
 *
 * {@link SocketManager} 只依赖最小化的 {@link SocketLike} 接口，
 * 而不是直接耦合 socket.io-client。默认通过 {@link socketIoFactory}
 * 创建真实连接；测试或特殊环境可以注入任意自定义实现（内存模拟、WebSocket 等）。
 */

import { io } from "socket.io-client";
import type { EventListener, TransportOptions } from "./types.ts";

/** 传输层生命周期事件（已做跨实现归一化） */
export const TransportEvent = {
  Connect: "connect",
  Disconnect: "disconnect",
  /** 对应 socket.io 的 `connect_error` */
  ConnectError: "connectError",
  /** 对应 socket.io manager 的 `reconnect_attempt` */
  ReconnectAttempt: "reconnectAttempt",
} as const;

/** 管理器所需的最小 Socket 能力 */
export interface SocketLike {
  /** 当前是否处于已连接状态 */
  readonly connected: boolean;
  /** 服务端分配的连接 ID */
  readonly id: string | undefined;

  on(event: string, listener: EventListener): void;
  once(event: string, listener: EventListener): void;
  /** 不传 listener 时移除该事件的全部监听器 */
  off(event: string, listener?: EventListener): void;
  /** 监听任意服务端派发的事件 */
  onAny(listener: (event: string, ...args: unknown[]) => void): void;

  /**
   * 发送事件。最后一个参数若为函数，则视为应答回调（acknowledgement）。
   */
  emit(event: string, ...args: unknown[]): void;

  /** 连接存活期间更新认证信息（影响下一次重连握手） */
  setAuth?(auth: unknown): void;

  /** 关闭连接并释放全部监听器，调用后实例不再可用 */
  dispose(): void;
}

/** 传输层工厂：根据地址与选项创建一个未连接的 {@link SocketLike} */
export type SocketFactory = (
  url: string,
  options: TransportOptions,
) => SocketLike;

/**
 * 基于 socket.io-client 的默认传输工厂。
 */
export const socketIoFactory: SocketFactory = (url, options) => {
  const socket = io(url, {
    autoConnect: true,
    ...options,
    query: options.auth?.token ? { token: options.auth.token } : undefined,
    // socket.io 的选项类型分散在 ManagerOptions/SocketOptions 中，这里已是透传
  } as Parameters<typeof io>[1]);

  /** 将归一化事件名映射到 socket.io 原生事件 */
  const resolveBinding = (
    event: string,
  ): { target: "socket" | "manager"; name: string } => {
    if (event === TransportEvent.ConnectError) {
      return { target: "socket", name: "connect_error" };
    }
    if (event === TransportEvent.ReconnectAttempt) {
      return { target: "manager", name: "reconnect_attempt" };
    }
    return { target: "socket", name: event };
  };

  const addListener = (
    kind: "on" | "once",
    event: string,
    listener: EventListener,
  ): void => {
    const binding = resolveBinding(event);
    const target = binding.target === "manager" ? socket.io : socket;
    // socket.io 的事件类型是强类型字面量联合，此处为归一化边界，使用宽松签名
    (
      target as unknown as {
        on: (name: string, cb: EventListener) => void;
        once: (name: string, cb: EventListener) => void;
      }
    )[kind](binding.name, listener);
  };

  const adapter: SocketLike = {
    get connected() {
      return socket.connected;
    },
    get id() {
      return socket.id ?? undefined;
    },

    on(event, listener) {
      addListener("on", event, listener);
    },
    once(event, listener) {
      addListener("once", event, listener);
    },
    off(event, listener) {
      const binding = resolveBinding(event);
      // 归一化边界，socket.io 的字面量事件类型在此处放宽
      const target = (binding.target === "manager" ? socket.io : socket) as {
        off: (name: string, cb?: EventListener) => void;
      };
      target.off(binding.name, listener);
    },

    onAny(listener) {
      socket.onAny(listener as never);
    },

    emit(event, ...args) {
      socket.emit(event, ...(args as never[]));
    },

    setAuth(auth) {
      // socket.io 在下一次握手（含重连）时读取该字段
      socket.auth = (auth ?? {}) as Record<string, unknown>;
    },

    dispose() {
      socket.offAny();
      (
        socket.io as unknown as {
          off: (name: string) => void;
        }
      ).off("reconnect_attempt");
      socket.off();
      socket.disconnect();
    },
  };

  return adapter;
};
