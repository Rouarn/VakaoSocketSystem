import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SocketEvent } from "../../src/events.ts";
import { createChatSocket, type ChatMessage } from "../../src/chat.ts";
import type { MessageData } from "../../src/types.ts";
import { connectClient, createTestClient } from "../support/fakeTransport.ts";

describe("createChatSocket", () => {
  it("getState 返回管理器的连接快照", async () => {
    const client = createTestClient();
    const chat = createChatSocket(client.socket);

    assert.equal(chat.getState().status, "disconnected");
    await connectClient(client);
    assert.equal(chat.getState().status, "connected");
    assert.equal(chat.getState().socketId, "fake-socket-id");
  });

  it("onMessage 将消息标准化为 ChatMessage，并按 selfId 标记 self", async () => {
    const client = createTestClient();
    const chat = createChatSocket(client.socket, { selfId: "user-1" });
    const received: ChatMessage[] = [];
    chat.onMessage(message => received.push(message));
    await connectClient(client);

    client.transport.socket.serverEmit(SocketEvent.Message, {
      id: "m-1",
      room: "room-1",
      content: "自己的消息",
      ts: 1000,
      sender: "user-1",
    } satisfies MessageData);
    client.transport.socket.serverEmit(SocketEvent.Message, {
      id: "m-2",
      room: "room-1",
      content: "别人的消息",
      ts: 1001,
      sender: "user-2",
    } satisfies MessageData);

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], {
      id: "m-1",
      room: "room-1",
      content: "自己的消息",
      ts: 1000,
      sender: "user-1",
      self: true,
      status: "sent",
    });
    assert.equal(received[1]?.self, false);
    assert.equal(received[1]?.sender, "user-2");
  });

  it("消息缺少 id/ts 时自动补全；非法负载被忽略", async () => {
    const client = createTestClient();
    const chat = createChatSocket(client.socket);
    const received: ChatMessage[] = [];
    chat.onMessage(message => received.push(message));
    await connectClient(client);

    client.transport.socket.serverEmit(SocketEvent.Message, {
      room: "room-1",
      content: "hello",
    });
    // 非法负载：缺少 content / room
    client.transport.socket.serverEmit(SocketEvent.Message, {
      room: "room-1",
    });
    client.transport.socket.serverEmit(SocketEvent.Message, {
      content: "no-room",
    });

    assert.equal(received.length, 1);
    assert.match(received[0]?.id ?? "", /^msg_/);
    assert.ok(typeof received[0]?.ts === "number");
    assert.equal(received[0]?.status, "sent");
  });

  it("onStateChange 订阅状态变化，退订后不再接收", async () => {
    const client = createTestClient();
    const chat = createChatSocket(client.socket);
    const statuses: string[] = [];
    const unsubscribe = chat.onStateChange(info => statuses.push(info.status));

    const connecting = chat.connect();
    client.transport.socket.serverConnect();
    await connecting;
    unsubscribe();
    chat.disconnect();

    assert.deepEqual(statuses, ["connecting", "connected"]);
  });

  it("connect/disconnect 委托到底层管理器", async () => {
    const client = createTestClient();
    const chat = createChatSocket(client.socket);

    const promise = chat.connect();
    client.transport.socket.serverConnect();
    await promise;
    assert.equal(chat.getState().status, "connected");

    chat.disconnect();
    assert.equal(chat.getState().status, "disconnected");
  });
});
