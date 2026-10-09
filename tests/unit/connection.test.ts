import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SocketError, SocketErrorType } from "../../src/errors.ts";
import { createSocket } from "../../src/SocketManager.ts";
import type { ConnectionInfo, SocketConfig } from "../../src/types.ts";
import { connectClient, createTestClient } from "../support/fakeTransport.ts";
import { VirtualScheduler } from "../support/virtualScheduler.ts";

function isSocketErrorOfType(type: string) {
  return (error: unknown): boolean =>
    error instanceof SocketError && error.type === type;
}

describe("SocketManager — 构造与配置", () => {
  it("url 缺失或为空白时抛出 TypeError", () => {
    assert.throws(
      () => createTestClient({ url: "" }),
      error => error instanceof TypeError,
    );
    assert.throws(
      () => createTestClient({ url: "   " }),
      error => error instanceof TypeError,
    );
    assert.throws(
      // 缺少 url 字段的配置
      () => createSocket({} as SocketConfig),
      error => error instanceof TypeError,
    );
  });

  it("拼接 endpoint 时去除 url 末尾斜杠并附加 namespace", async () => {
    const client = createTestClient({
      url: "https://server.io/",
      namespace: "/chat",
    });
    await connectClient(client);

    assert.equal(client.transport.lastCreate?.url, "https://server.io/chat");
  });

  it("向传输层透传归一化后的默认选项", async () => {
    const client = createTestClient({
      auth: { token: "jwt-123" },
      reconnectionAttempts: 9,
      reconnectionDelay: 250,
      timeout: 8000,
      transports: ["polling"],
    });
    await connectClient(client);

    assert.deepEqual(client.transport.lastCreate?.options, {
      auth: { token: "jwt-123" },
      reconnection: true,
      reconnectionAttempts: 9,
      reconnectionDelay: 250,
      timeout: 8000,
      transports: ["polling"],
    });
  });
});

describe("SocketManager — 连接生命周期", () => {
  it("连接成功后状态变为 connected，并依次触发 stateChange 与 connect", async () => {
    const client = createTestClient();
    const statuses: string[] = [];
    let connectCount = 0;

    client.socket.onStateChange((info: ConnectionInfo) => {
      statuses.push(info.status);
    });
    client.socket.on("connect", () => {
      connectCount++;
    });

    await connectClient(client, "sid-1");

    assert.equal(client.socket.isConnected(), true);
    assert.deepEqual(statuses, ["connecting", "connected"]);
    assert.equal(connectCount, 1);

    const state = client.socket.getState();
    assert.equal(state.status, "connected");
    assert.equal(state.socketId, "sid-1");
    assert.equal(state.reconnectCount, 0);
    assert.ok(state.lastConnectedAt);
    assert.equal(state.lastError, undefined);
  });

  it("连接进行中重复调用返回同一个 Promise，且只创建一个传输实例", async () => {
    const client = createTestClient();

    const first = client.socket.connect();
    const second = client.socket.connect();
    assert.equal(first, second);

    client.transport.socket.serverConnect();
    await first;
    await second;

    assert.equal(client.transport.instances.length, 1);
  });

  it("已连接后再次调用 connect 立即返回且不重复建连", async () => {
    const client = createTestClient();
    await connectClient(client);

    await client.socket.connect();
    assert.equal(client.transport.instances.length, 1);
  });

  it("握手失败时抛出 CONNECTION_FAILED，进入 error 状态并销毁传输实例", async () => {
    const client = createTestClient();
    const errors: SocketError[] = [];
    client.socket.onError(error => errors.push(error));

    const promise = client.socket.connect();
    client.transport.socket.serverConnectError("bad handshake");

    await assert.rejects(
      promise,
      error =>
        error instanceof SocketError &&
        error.type === SocketErrorType.CONNECTION_FAILED &&
        error.message === "bad handshake",
    );

    assert.equal(client.socket.getState().status, "error");
    assert.equal(client.socket.getState().lastError, "bad handshake");
    assert.equal(client.socket.isConnected(), false);
    assert.equal(client.transport.socket.disposed, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.type, SocketErrorType.CONNECTION_FAILED);
  });

  it("握手失败后可以重新建立连接（新传输实例）", async () => {
    const client = createTestClient();

    const failed = client.socket.connect();
    client.transport.socket.serverConnectError("nope");
    await assert.rejects(failed, isSocketErrorOfType("CONNECTION_FAILED"));

    await connectClient(client);
    assert.equal(client.transport.instances.length, 2);
    assert.equal(client.socket.isConnected(), true);
  });

  it("连接超时抛出 TIMEOUT 并进入 error 状态（虚拟时钟，零等待）", async () => {
    const clock = new VirtualScheduler();
    const client = createTestClient({ timeout: 3000 }, { scheduler: clock });

    const promise = client.socket.connect();
    clock.advance(3000);

    await assert.rejects(promise, isSocketErrorOfType("TIMEOUT"));
    assert.equal(client.socket.getState().status, "error");
    assert.equal(client.transport.socket.disposed, true);
    assert.equal(clock.pendingCount, 0);
  });

  it("连接过程中调用 disconnect 会取消连接并抛出 CONNECTION_CANCELLED", async () => {
    const client = createTestClient();

    const promise = client.socket.connect();
    client.socket.disconnect();

    await assert.rejects(promise, isSocketErrorOfType("CONNECTION_CANCELLED"));
    assert.equal(client.transport.socket.disposed, true);
    assert.equal(client.socket.getState().status, "disconnected");
  });

  it("从未连接时调用 disconnect 是幂等的，且不产生 disconnect 事件", () => {
    const client = createTestClient();
    let disconnectCount = 0;
    client.socket.on("disconnect", () => disconnectCount++);

    client.socket.disconnect();
    client.socket.disconnect();

    assert.equal(disconnectCount, 0);
    assert.equal(client.socket.getState().status, "disconnected");
  });

  it("连接后 disconnect 关闭传输、重置状态并发出 disconnect 事件", async () => {
    const client = createTestClient();
    const reasons: string[] = [];
    client.socket.on("disconnect", (reason?: string) => {
      if (reason) reasons.push(reason);
    });

    await connectClient(client, "sid-xyz");
    client.socket.disconnect();

    assert.equal(client.socket.isConnected(), false);
    assert.equal(client.transport.socket.disposed, true);
    assert.equal(client.socket.getState().status, "disconnected");
    assert.deepEqual(reasons, ["client disconnect"]);
  });

  it("disconnect 会拒绝所有尚未应答的请求", async () => {
    const client = createTestClient();
    await connectClient(client);

    const pending = client.socket.joinRoom("room-1", "user-1");
    client.socket.disconnect();

    await assert.rejects(pending, isSocketErrorOfType("CONNECTION_CANCELLED"));
  });

  it("setAuthToken 在连接前通过传输选项传递，在连接后更新底层认证", async () => {
    const client = createTestClient();
    client.socket.setAuthToken("token-before-connect");
    await connectClient(client);
    assert.deepEqual(client.transport.lastCreate?.options.auth, {
      token: "token-before-connect",
    });

    client.socket.setAuthToken("token-after");
    assert.deepEqual(client.transport.socket.auth, {
      token: "token-after",
    });

    client.socket.setAuthToken();
    assert.equal(client.transport.socket.auth, undefined);
  });
});
