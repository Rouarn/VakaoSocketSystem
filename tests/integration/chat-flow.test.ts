/**
 * 集成测试：以库的公共入口（index.ts）走完聊天全流程。
 * 传输层使用内存模拟服务端，覆盖连接 -> 订阅 -> 加入房间 -> 收发消息 ->
 * 查询房间 -> 断线重连 -> 房间恢复 -> 离开房间 -> 断开的完整链路。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ClientCommand,
  SocketEvent,
  createChatSocket,
  createSocket,
  type ConnectionInfo,
  type MessageData,
  type ServerRoomItem,
  type SocketManager,
} from "../../src/index.ts";
import { FakeTransport, flushAsync } from "../support/fakeTransport.ts";

const SERVER_ROOM_LIST: ServerRoomItem[] = [
  { id: "room-1", name: "大厅", type: "public", members: 1 },
];

/** 在给定的内存 socket 上注册一套聊天服务端行为 */
function registerServer(
  fake: FakeTransport["socket"],
  serverSideRooms: Map<string, Set<string>>,
): void {
  fake.handle(ClientCommand.JoinRoom, payload => {
    const { roomId, userId } = payload as {
      roomId: string;
      userId: string;
    };
    let members = serverSideRooms.get(roomId);
    if (!members) {
      members = new Set();
      serverSideRooms.set(roomId, members);
    }
    members.add(userId);
    return { success: true };
  });

  fake.handle(ClientCommand.LeaveRoom, payload => {
    const { roomId, userId } = payload as {
      roomId: string;
      userId: string;
    };
    serverSideRooms.get(roomId)?.delete(userId);
    return { success: true };
  });

  fake.handle(ClientCommand.SendMessage, payload => {
    const message = payload as MessageData;
    // 服务端将消息广播回客户端
    fake.serverEmit(SocketEvent.Message, message);
    return { success: true };
  });

  fake.handle(ClientCommand.GetRooms, () => ({
    success: true,
    data: { rooms: SERVER_ROOM_LIST },
  }));
}

/** 搭建一个带简单服务端行为的聊天客户端 */
function setupChatClient(): {
  socket: SocketManager;
  transport: FakeTransport;
  serverSideRooms: Map<string, Set<string>>;
  /** 建立连接（connect 同步创建传输实例后注册服务端处理器） */
  start: (socketId?: string) => Promise<void>;
} {
  const transport = new FakeTransport();
  const serverSideRooms = new Map<string, Set<string>>();

  const socket = createSocket(
    {
      url: "http://chat.example/",
      namespace: "/chat",
      auth: { token: "jwt-token" },
      timeout: 5000,
    },
    { transport: transport.create },
  );

  const start = async (socketId = "server-sid"): Promise<void> => {
    const promise = socket.connect();
    registerServer(transport.socket, serverSideRooms);
    transport.socket.serverConnect(socketId);
    await promise;
  };

  return { socket, transport, serverSideRooms, start };
}

describe("集成：聊天完整流程", () => {
  it("连接前订阅、加入房间、收发消息、查询列表", async () => {
    const { socket, transport, serverSideRooms, start } = setupChatClient();
    const chat = createChatSocket(socket, { selfId: "user-1" });

    // 关键：订阅发生在连接建立之前
    const statuses: string[] = [];
    const messages: MessageData[] = [];
    socket.onStateChange((info: ConnectionInfo) => statuses.push(info.status));
    chat.onMessage(message => messages.push(message));

    await start("server-sid-1");

    assert.equal(transport.lastCreate?.url, "http://chat.example/chat");
    assert.deepEqual(transport.lastCreate?.options.auth, {
      token: "jwt-token",
    });

    await socket.joinRoom("room-1", "user-1");
    assert.deepEqual([...(serverSideRooms.get("room-1") ?? [])], ["user-1"]);

    await socket.sendMessage("room-1", "hello world");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, "hello world");
    assert.equal(messages[0]?.sender, "user-1");
    // chat 门面标记 self
    let selfFlag: boolean | undefined;
    const off = chat.onMessage(message => {
      selfFlag = message.self;
    });
    await socket.sendMessage("room-1", "second");
    off();
    assert.equal(selfFlag, true);

    const rooms = await socket.getRooms();
    assert.deepEqual(rooms, SERVER_ROOM_LIST);

    assert.deepEqual(statuses, ["connecting", "connected"]);

    await socket.leaveRoom("room-1");
    assert.equal(serverSideRooms.get("room-1")?.size, 0);
    assert.deepEqual(socket.getJoinedRooms(), []);

    socket.disconnect();
    assert.equal(transport.socket.disposed, true);
    assert.equal(socket.getState().status, "disconnected");
  });

  it("断线自动重连后恢复房间订阅，随后可继续正常通信", async () => {
    const { socket, transport, serverSideRooms, start } = setupChatClient();

    const reconnectEvents: string[] = [];
    socket.on("reconnecting", () => reconnectEvents.push("reconnecting"));
    socket.on("reconnected", () => reconnectEvents.push("reconnected"));

    await start("sid-1");

    await socket.joinRoom("room-1", "user-1");
    assert.equal(serverSideRooms.get("room-1")?.has("user-1"), true);

    // 服务端掉线：成员状态在“服务端”丢失
    serverSideRooms.clear();
    transport.socket.serverDisconnect("transport close");
    assert.equal(socket.getState().status, "connecting");

    // 自动重连成功
    transport.socket.serverReconnectAttempt(1);
    transport.socket.serverConnect("sid-2");
    await flushAsync();

    assert.deepEqual(reconnectEvents, ["reconnecting", "reconnected"]);
    assert.equal(socket.getState().socketId, "sid-2");
    assert.deepEqual(socket.getJoinedRooms(), ["room-1"]);
    // 服务端收到自动重新加入的请求
    assert.equal(serverSideRooms.get("room-1")?.has("user-1"), true);
    assert.equal(transport.socket.emitCount(ClientCommand.JoinRoom), 2);

    // 重连后消息链路仍然可用
    const received: MessageData[] = [];
    socket.onMessage(message => received.push(message));
    await socket.sendMessage("room-1", "after reconnect");
    assert.equal(received[0]?.content, "after reconnect");
    assert.equal(received[0]?.room, "room-1");

    socket.disconnect();
  });

  it("多个管理器实例之间状态完全隔离（无全局单例）", async () => {
    const clientA = setupChatClient();
    const clientB = setupChatClient();

    await clientA.start("sid-A");
    await clientB.start("sid-B");

    await clientA.socket.joinRoom("room-a", "user-a");

    assert.deepEqual(clientA.socket.getJoinedRooms(), ["room-a"]);
    assert.deepEqual(clientB.socket.getJoinedRooms(), []);
    assert.notEqual(clientA.transport.socket, clientB.transport.socket);
    assert.equal(clientA.socket.getState().socketId, "sid-A");
    assert.equal(clientB.socket.getState().socketId, "sid-B");

    clientA.socket.disconnect();
    assert.equal(clientA.socket.getState().status, "disconnected");
    // 断开 A 不影响 B
    assert.equal(clientB.socket.getState().status, "connected");
    assert.equal(clientB.transport.socket.disposed, false);

    clientB.socket.disconnect();
  });
});
