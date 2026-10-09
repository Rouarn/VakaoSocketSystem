import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SocketError, SocketErrorType } from "../../src/errors.ts";
import { ClientCommand, SocketEvent } from "../../src/events.ts";
import type { MessageData } from "../../src/types.ts";
import { connectClient, createTestClient } from "../support/fakeTransport.ts";

function isType(type: string) {
  return (error: unknown): boolean =>
    error instanceof SocketError && error.type === type;
}

describe("SocketManager — 发送消息", () => {
  it("未连接时抛出 NOT_CONNECTED", async () => {
    const client = createTestClient();
    await assert.rejects(
      client.socket.sendMessage("room-1", "hello"),
      isType(SocketErrorType.NOT_CONNECTED),
    );
  });

  it("房间 ID 或内容为空白时抛出 MESSAGE_SEND_FAILED", async () => {
    const client = createTestClient();
    await connectClient(client);

    await assert.rejects(
      client.socket.sendMessage(" ", "hello"),
      isType(SocketErrorType.MESSAGE_SEND_FAILED),
    );
    await assert.rejects(
      client.socket.sendMessage("room-1", "   "),
      isType(SocketErrorType.MESSAGE_SEND_FAILED),
    );
    assert.equal(
      client.transport.socket.emitCount(ClientCommand.SendMessage),
      0,
    );
  });

  it("发送标准化消息：自动填充 id/ts/sender，并裁剪内容与房间 ID", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    client.transport.handle(ClientCommand.SendMessage, () => ({
      success: true,
    }));
    await connectClient(client);
    await client.socket.joinRoom("room-1", "user-7");

    const before = Date.now();
    await client.socket.sendMessage("  room-1  ", "  hello world  ");
    const after = Date.now();

    const payload = client.transport.socket.lastEmit(ClientCommand.SendMessage)
      ?.payload as MessageData;

    assert.match(payload.id ?? "", /^msg_/);
    assert.equal(payload.room, "room-1");
    assert.equal(payload.content, "hello world");
    assert.equal(payload.sender, "user-7");
    assert.ok(payload.ts >= before && payload.ts <= after);
  });

  it("服务端返回失败时抛出 MESSAGE_SEND_FAILED 且错误消息透传", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    client.transport.handle(ClientCommand.SendMessage, () => ({
      success: false,
      error: "已被禁言",
    }));
    await connectClient(client);
    await client.socket.joinRoom("room-1", "user-1");

    await assert.rejects(
      client.socket.sendMessage("room-1", "hi"),
      error =>
        error instanceof SocketError &&
        error.type === SocketErrorType.MESSAGE_SEND_FAILED &&
        error.message === "已被禁言",
    );
  });
});

describe("SocketManager — 自定义事件 emit", () => {
  it("未连接时静默忽略", async () => {
    const client = createTestClient();
    client.socket.emit("typing", { value: 1 });
    assert.equal(client.transport.instances.length, 0);
  });

  it("事件名为空时静默忽略", async () => {
    const client = createTestClient();
    await connectClient(client);

    client.socket.emit("", { value: 1 });
    assert.equal(client.transport.socket.emitCount(""), 0);
  });

  it("连接后透传事件与数据", async () => {
    const client = createTestClient();
    await connectClient(client);

    client.socket.emit("typing", { roomId: "room-1" });

    assert.deepEqual(client.transport.socket.lastEmit("typing")?.payload, {
      roomId: "room-1",
    });
  });
});

describe("SocketManager — 事件订阅", () => {
  it("onMessage / on('message') 接收服务端广播的标准化消息", async () => {
    const client = createTestClient();
    const received: MessageData[] = [];
    const receivedViaOn: MessageData[] = [];
    client.socket.onMessage(message => received.push(message));
    client.socket.on(SocketEvent.Message, (message: MessageData) =>
      receivedViaOn.push(message),
    );
    await connectClient(client);

    const message: MessageData = {
      id: "m-1",
      room: "room-1",
      content: "你好",
      ts: 123456,
      sender: "user-2",
    };
    client.transport.socket.serverEmit(SocketEvent.Message, message);

    assert.deepEqual(received, [message]);
    assert.deepEqual(receivedViaOn, [message]);
  });

  it("onStateChange 接收状态快照", async () => {
    const client = createTestClient();
    const statuses: string[] = [];
    client.socket.onStateChange(info => statuses.push(info.status));

    await connectClient(client);
    client.socket.disconnect();

    assert.deepEqual(statuses, ["connecting", "connected", "disconnected"]);
  });

  it("on 返回的取消函数与 off 都可以移除订阅", async () => {
    const client = createTestClient();
    let first = 0;
    let second = 0;
    const unsubscribe = client.socket.on("custom", () => first++);
    client.socket.on("custom", () => second++);
    await connectClient(client);

    client.transport.socket.serverEmit("custom");
    unsubscribe();
    client.transport.socket.serverEmit("custom");
    client.socket.off("custom");
    client.transport.socket.serverEmit("custom");

    assert.equal(first, 1);
    assert.equal(second, 2);
  });

  it("once 只接收一次自定义事件", async () => {
    const client = createTestClient();
    const values: unknown[] = [];
    client.socket.once("custom", (value: unknown) => values.push(value));
    await connectClient(client);

    client.transport.socket.serverEmit("custom", 1);
    client.transport.socket.serverEmit("custom", 2);

    assert.deepEqual(values, [1]);
  });

  it("传输层生命周期事件不会以原名透传给业务监听器", async () => {
    const client = createTestClient();
    let rawLifecycleEvent = 0;
    client.socket.on("connectError", () => rawLifecycleEvent++);
    client.socket.on("reconnectAttempt", () => rawLifecycleEvent++);

    const promise = client.socket.connect();
    client.transport.socket.serverConnectError("fail");
    await assert.rejects(promise);
    client.transport.socket.serverReconnectAttempt(1);

    assert.equal(rawLifecycleEvent, 0);
  });

  it("clearListeners 移除全部业务监听器但不影响连接管理", async () => {
    const client = createTestClient();
    let count = 0;
    client.socket.on("custom", () => count++);
    client.socket.onMessage(() => count++);
    await connectClient(client);

    client.socket.clearListeners();
    client.transport.socket.serverEmit("custom");
    client.transport.socket.serverEmit(SocketEvent.Message, {
      room: "r",
      content: "c",
      ts: 1,
    });

    assert.equal(count, 0);
    assert.equal(client.socket.isConnected(), true);
  });
});
