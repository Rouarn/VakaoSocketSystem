import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SocketError,
  SocketErrorType,
  isSocketError,
} from "../../src/errors.ts";

describe("SocketError", () => {
  it("携带类型、消息与原始错误，且是 Error 的实例", () => {
    const original = new Error("boom");
    const error = new SocketError(
      SocketErrorType.TIMEOUT,
      "请求超时",
      original,
    );

    assert.ok(error instanceof Error);
    assert.ok(error instanceof SocketError);
    assert.equal(error.name, "SocketError");
    assert.equal(error.type, SocketErrorType.TIMEOUT);
    assert.equal(error.message, "请求超时");
    assert.equal(error.cause, original);
  });

  it("错误类型为稳定的字符串字面量", () => {
    assert.equal(SocketErrorType.CONNECTION_FAILED, "CONNECTION_FAILED");
    assert.equal(SocketErrorType.NOT_CONNECTED, "NOT_CONNECTED");
    assert.equal(SocketErrorType.CONNECTION_CANCELLED, "CONNECTION_CANCELLED");
  });

  it("isSocketError 可识别错误类型", () => {
    assert.equal(isSocketError(new SocketError(SocketErrorType.TIMEOUT, "x")), true);
    assert.equal(isSocketError(new Error("x")), false);
    assert.equal(isSocketError(null), false);
    assert.equal(isSocketError("SocketError"), false);
  });
});
