/**
 * 聊天场景的轻量函数式门面。
 *
 * 与旧版不同，{@link createChatSocket} 必须显式接收一个 {@link SocketManager}
 * 实例，因此不存在隐藏的全局状态，可在多连接场景下使用，也便于测试。
 */

import type { SocketManager } from "./SocketManager.ts";
import { SocketEvent } from "./events.ts";
import type {
  ConnectionInfo,
  MessageData,
} from "./types.ts";

/** 聊天消息状态 */
export type ChatMessageStatus = "sending" | "sent" | "failed";

/** 标准化聊天消息（在 MessageData 基础上补充展示层字段） */
export interface ChatMessage {
  id: string;
  room: string;
  sender?: string;
  content: string;
  ts: number;
  /** 是否为当前用户自己发送的消息 */
  self: boolean;
  status: ChatMessageStatus;
}

/** createChatSocket 的选项 */
export interface ChatSocketOptions {
  /** 当前用户 ID，用于将消息标记为 self */
  selfId?: string;
}

export interface ChatSocket {
  /** 获取当前连接信息快照 */
  getState(): ConnectionInfo;
  /** 监听标准化聊天消息，返回取消订阅函数 */
  onMessage(callback: (message: ChatMessage) => void): () => void;
  /** 监听连接信息变化，返回取消订阅函数 */
  onStateChange(callback: (info: ConnectionInfo) => void): () => void;
  /** 建立连接 */
  connect(): Promise<void>;
  /** 断开连接 */
  disconnect(): void;
}

function generateId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * 基于给定的 SocketManager 创建聊天工具集。
 *
 * @example
 * ```ts
 * const socket = createSocket({ url: "https://socket.example.com" });
 * const chat = createChatSocket(socket, { selfId: "user-1" });
 * const off = chat.onMessage(msg => console.log(msg));
 * await chat.connect();
 * ```
 */
export function createChatSocket(
  socket: SocketManager,
  options: ChatSocketOptions = {},
): ChatSocket {
  const selfId = options.selfId;

  function getState(): ConnectionInfo {
    return socket.getState();
  }

  function onMessage(
    callback: (message: ChatMessage) => void,
  ): () => void {
    return socket.on(
      SocketEvent.Message,
      (data: MessageData): void => {
        if (!data?.room || !data?.content) return;
        callback({
          id: data.id || generateId(),
          room: data.room,
          sender: data.sender,
          content: String(data.content),
          ts: data.ts || Date.now(),
          self:
            selfId !== undefined &&
            data.sender !== undefined &&
            data.sender === selfId,
          status: "sent",
        });
      },
    );
  }

  function onStateChange(
    callback: (info: ConnectionInfo) => void,
  ): () => void {
    return socket.on(SocketEvent.StateChange, callback);
  }

  return {
    getState,
    onMessage,
    onStateChange,
    connect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
  };
}
