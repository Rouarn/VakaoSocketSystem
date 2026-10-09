/**
 * 虚拟计时器：超时逻辑的测试无需真实等待，时间推进完全确定。
 */

import type { Scheduler } from "../../src/types.ts";

interface TimerTask {
  id: number;
  time: number;
  handler: () => void;
}

export class VirtualScheduler implements Scheduler {
  #now = 0;
  #seq = 0;
  #tasks = new Set<TimerTask>();

  setTimeout(handler: () => void, timeout = 0): unknown {
    const task: TimerTask = {
      id: ++this.#seq,
      time: this.#now + Math.max(0, timeout),
      handler,
    };
    this.#tasks.add(task);
    return task;
  }

  clearTimeout(handle?: unknown): void {
    if (handle) {
      this.#tasks.delete(handle as TimerTask);
    }
  }

  /** 当前挂起的定时器数量 */
  get pendingCount(): number {
    return this.#tasks.size;
  }

  /**
   * 推进虚拟时间，并按到期顺序同步执行所有到期任务；
   * 任务执行过程中新注册的到期任务也会被执行。
   */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#tasks]
        .filter((task) => task.time <= target)
        .sort((a, b) => a.time - b.time || a.id - b.id);
      if (due.length === 0) break;

      const task = due[0];
      this.#tasks.delete(task);
      this.#now = task.time;
      task.handler();
    }
    this.#now = target;
  }
}
