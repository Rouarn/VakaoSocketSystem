/**
 * 最小化的类型安全事件总线。
 *
 * 设计要点：
 * - `on/once` 均返回取消订阅函数，便于在任意环境中做资源清理；
 * - 单个监听器抛错不会影响其他监听器（错误异步重新抛出）；
 * - 与具体传输实现完全解耦，重连期间监听器不会丢失、无需重新绑定。
 */

import type { EventListener } from "./types.ts";

function reportError(error: unknown): void {
  const global = globalThis as {
    queueMicrotask?: (callback: () => void) => void;
  };
  const throwError = () => {
    throw error;
  };
  if (global.queueMicrotask) {
    global.queueMicrotask(throwError);
  } else {
    Promise.resolve().then(throwError);
  }
}

export class EventEmitter {
  #handlers = new Map<string, Set<EventListener>>();

  /** 订阅事件，返回取消订阅函数 */
  on(event: string, listener: EventListener): () => void {
    let group = this.#handlers.get(event);
    if (!group) {
      group = new Set();
      this.#handlers.set(event, group);
    }
    group.add(listener);
    return () => this.off(event, listener);
  }

  /** 订阅一次，触发后自动移除 */
  once(event: string, listener: EventListener): () => void {
    const wrapper: EventListener = (...args: unknown[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  /** 取消订阅；不传 listener 时移除该事件的全部监听器 */
  off(event: string, listener?: EventListener): void {
    const group = this.#handlers.get(event);
    if (!group) return;
    if (listener) {
      group.delete(listener);
      if (group.size === 0) {
        this.#handlers.delete(event);
      }
    } else {
      this.#handlers.delete(event);
    }
  }

  /** 移除全部事件监听器 */
  clear(): void {
    this.#handlers.clear();
  }

  /** 派发事件（监听器按注册顺序调用） */
  emit(event: string, ...args: unknown[]): void {
    const group = this.#handlers.get(event);
    if (!group || group.size === 0) return;
    for (const listener of [...group]) {
      try {
        listener(...args);
      } catch (error) {
        reportError(error);
      }
    }
  }

  /** 某事件当前的监听器数量 */
  listenerCount(event: string): number {
    return this.#handlers.get(event)?.size ?? 0;
  }
}
