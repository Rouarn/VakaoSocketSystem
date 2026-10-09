/**
 * 默认计时器：基于宿主环境的全局 setTimeout/clearTimeout。
 * 通过 globalThis 访问，使本库在不引入任何平台类型依赖的情况下
 * 同时兼容浏览器与 Node.js。
 */

import type { Scheduler } from "./types.ts";

type TimerGlobal = {
  setTimeout?: (handler: () => void, timeout?: number) => unknown;
  clearTimeout?: (handle?: unknown) => void;
};

export const defaultScheduler: Scheduler = {
  setTimeout(handler, timeout) {
    return (globalThis as TimerGlobal).setTimeout!(handler, timeout);
  },
  clearTimeout(handle) {
    (globalThis as TimerGlobal).clearTimeout?.(handle);
  },
};
