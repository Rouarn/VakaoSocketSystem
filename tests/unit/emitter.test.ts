import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EventEmitter } from "../../src/emitter.ts";

describe("EventEmitter", () => {
  it("按注册顺序向监听器传递参数", () => {
    const emitter = new EventEmitter();
    const received: unknown[][] = [];

    emitter.on("evt", (a, b) => received.push(["first", a, b]));
    emitter.on("evt", (a, b) => received.push(["second", a, b]));
    emitter.emit("evt", 1, "x");

    assert.deepEqual(received, [
      ["first", 1, "x"],
      ["second", 1, "x"],
    ]);
  });

  it("on 返回的函数可取消订阅", () => {
    const emitter = new EventEmitter();
    let count = 0;
    const unsubscribe = emitter.on("evt", () => count++);

    emitter.emit("evt");
    unsubscribe();
    emitter.emit("evt");

    assert.equal(count, 1);
  });

  it("once 只触发一次并接收参数", () => {
    const emitter = new EventEmitter();
    const values: unknown[] = [];
    emitter.once("evt", (value) => values.push(value));

    emitter.emit("evt", 1);
    emitter.emit("evt", 2);

    assert.deepEqual(values, [1]);
  });

  it("off 不传监听器时移除该事件的全部订阅", () => {
    const emitter = new EventEmitter();
    let count = 0;
    emitter.on("evt", () => count++);
    emitter.on("evt", () => count++);

    emitter.off("evt");
    emitter.emit("evt");

    assert.equal(count, 0);
    assert.equal(emitter.listenerCount("evt"), 0);
  });

  it("clear 移除所有事件的监听器", () => {
    const emitter = new EventEmitter();
    let count = 0;
    emitter.on("a", () => count++);
    emitter.on("b", () => count++);

    emitter.clear();
    emitter.emit("a");
    emitter.emit("b");

    assert.equal(count, 0);
  });

  it("事件之间相互独立", () => {
    const emitter = new EventEmitter();
    const values: string[] = [];
    emitter.on("a", () => values.push("a"));
    emitter.on("b", () => values.push("b"));

    emitter.off("a");
    emitter.emit("a");
    emitter.emit("b");

    assert.deepEqual(values, ["b"]);
  });
});
