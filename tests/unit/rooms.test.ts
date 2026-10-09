import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SocketError, SocketErrorType } from "../../src/errors.ts";
import { ClientCommand } from "../../src/events.ts";
import type { RoomEventPayload, ServerRoomItem } from "../../src/types.ts";
import { connectClient, createTestClient } from "../support/fakeTransport.ts";
import { VirtualScheduler } from "../support/virtualScheduler.ts";

const SERVER_ROOMS: ServerRoomItem[] = [
  { id: "room-1", name: "大厅", type: "public", members: 10 },
  { id: "room-2", name: "小黑屋", type: "private", members: 2 },
];

function isType(type: string) {
  return (error: unknown): boolean =>
    error instanceof SocketError && error.type === type;
}

describe("SocketManager — 加入房间", () => {
  it("未连接时加入房间抛出 NOT_CONNECTED", async () => {
    const client = createTestClient();
    await assert.rejects(
      client.socket.joinRoom("room-1", "user-1"),
      isType(SocketErrorType.NOT_CONNECTED),
    );
  });

  it("房间 ID 为空白时抛出 ROOM_JOIN_FAILED", async () => {
    const client = createTestClient();
    await connectClient(client);

    await assert.rejects(
      client.socket.joinRoom("   ", "user-1"),
      isType(SocketErrorType.ROOM_JOIN_FAILED),
    );
  });

  it("加入成功：发送标准 payload、记录房间并触发 roomJoined 事件", async () => {
    const client = createTestClient();
    const joined: RoomEventPayload[] = [];
    client.socket.on("roomJoined", payload => joined.push(payload));
    client.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    await connectClient(client);

    await client.socket.joinRoom("room-1", "user-1");

    assert.deepEqual(
      client.transport.socket.lastEmit(ClientCommand.JoinRoom)?.payload,
      { roomId: "room-1", userId: "user-1" },
    );
    assert.deepEqual(client.socket.getJoinedRooms(), ["room-1"]);
    assert.deepEqual(joined, [{ roomId: "room-1", userId: "user-1" }]);
  });

  it("userId 解析优先级：显式参数 > 配置 userId > 自动生成，且自动生成的会复用", async () => {
    // 自动生成
    const client1 = createTestClient();
    client1.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    await connectClient(client1);

    await client1.socket.joinRoom("room-a");
    await client1.socket.joinRoom("room-b");

    const firstUserId = (
      client1.transport.socket.emits[0]?.payload as { userId: string }
    ).userId;
    const secondUserId = (
      client1.transport.socket.emits[1]?.payload as { userId: string }
    ).userId;
    assert.match(firstUserId, /^user_/);
    assert.equal(firstUserId, secondUserId);

    // 配置 userId
    const client2 = createTestClient({ userId: "cfg-user" });
    client2.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    await connectClient(client2);
    await client2.socket.joinRoom("room-a");
    assert.equal(
      (
        client2.transport.socket.lastEmit(ClientCommand.JoinRoom)?.payload as {
          userId: string;
        }
      ).userId,
      "cfg-user",
    );

    // 显式参数覆盖
    await client2.socket.joinRoom("room-b", "explicit-user");
    assert.equal(
      (
        client2.transport.socket.lastEmit(ClientCommand.JoinRoom)?.payload as {
          userId: string;
        }
      ).userId,
      "explicit-user",
    );

    // 空白的显式 userId 被拒绝
    await assert.rejects(
      client2.socket.joinRoom("room-c", "   "),
      isType(SocketErrorType.ROOM_JOIN_FAILED),
    );
  });

  it("服务端拒绝时抛出错误且不记录房间", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.JoinRoom, () => ({
      success: false,
      error: "房间已满",
    }));
    await connectClient(client);

    await assert.rejects(
      client.socket.joinRoom("room-1", "user-1"),
      error =>
        error instanceof SocketError &&
        error.type === SocketErrorType.ROOM_JOIN_FAILED &&
        error.message === "房间已满",
    );
    assert.deepEqual(client.socket.getJoinedRooms(), []);
  });

  it("服务端不应答时在超时后抛出 TIMEOUT（虚拟时钟）", async () => {
    const clock = new VirtualScheduler();
    const client = createTestClient({ timeout: 2000 }, { scheduler: clock });
    await connectClient(client);

    const promise = client.socket.joinRoom("room-1", "user-1");
    clock.advance(2000);

    await assert.rejects(promise, isType(SocketErrorType.TIMEOUT));
    assert.deepEqual(client.socket.getJoinedRooms(), []);
    assert.equal(clock.pendingCount, 0);
  });
});

describe("SocketManager — 离开房间", () => {
  it("房间 ID 为空白时抛出 ROOM_LEAVE_FAILED", async () => {
    const client = createTestClient();
    await connectClient(client);
    await assert.rejects(
      client.socket.leaveRoom(""),
      isType(SocketErrorType.ROOM_LEAVE_FAILED),
    );
  });

  it("离开未加入的房间抛出 ROOM_LEAVE_FAILED（回归：不再依赖单一全局 userId）", async () => {
    const client = createTestClient();
    await connectClient(client);
    await assert.rejects(
      client.socket.leaveRoom("not-joined"),
      error =>
        error instanceof SocketError &&
        error.type === SocketErrorType.ROOM_LEAVE_FAILED &&
        error.message === "尚未加入该房间，无需离开",
    );
  });

  it("离开房间时使用该房间各自的 userId，成功后删除记录并触发 roomLeft", async () => {
    const client = createTestClient();
    const left: Array<{ roomId: string }> = [];
    client.socket.on("roomLeft", payload => left.push(payload));
    client.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    client.transport.handle(ClientCommand.LeaveRoom, () => ({
      success: true,
    }));
    await connectClient(client);

    await client.socket.joinRoom("room-a", "user-a");
    await client.socket.joinRoom("room-b", "user-b");
    await client.socket.leaveRoom("room-a");

    assert.deepEqual(
      client.transport.socket.lastEmit(ClientCommand.LeaveRoom)?.payload,
      { roomId: "room-a", userId: "user-a" },
    );
    assert.deepEqual(client.socket.getJoinedRooms(), ["room-b"]);
    assert.deepEqual(left, [{ roomId: "room-a" }]);
  });

  it("服务端拒绝离开时保留房间记录", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.JoinRoom, () => ({
      success: true,
    }));
    client.transport.handle(ClientCommand.LeaveRoom, () => ({
      success: false,
      error: "不允许离开",
    }));
    await connectClient(client);
    await client.socket.joinRoom("room-1", "user-1");

    await assert.rejects(
      client.socket.leaveRoom("room-1"),
      isType(SocketErrorType.ROOM_LEAVE_FAILED),
    );
    assert.deepEqual(client.socket.getJoinedRooms(), ["room-1"]);
  });
});

describe("SocketManager — 获取房间列表", () => {
  it("成功解析服务端返回的房间数组", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.GetRooms, () => ({
      success: true,
      data: { rooms: SERVER_ROOMS },
    }));
    await connectClient(client);

    const rooms = await client.socket.getRooms();
    assert.deepEqual(rooms, SERVER_ROOMS);
  });

  it("success 为 false 时抛出 ROOMS_FETCH_FAILED", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.GetRooms, () => ({
      success: false,
      error: "禁止查询",
    }));
    await connectClient(client);

    await assert.rejects(
      client.socket.getRooms(),
      isType(SocketErrorType.ROOMS_FETCH_FAILED),
    );
  });

  it("返回数据结构异常时抛出 ROOMS_FETCH_FAILED", async () => {
    const client = createTestClient();
    client.transport.handle(ClientCommand.GetRooms, () => ({
      success: true,
      data: {},
    }));
    await connectClient(client);

    await assert.rejects(
      client.socket.getRooms(),
      isType(SocketErrorType.ROOMS_FETCH_FAILED),
    );
  });

  it("未连接时抛出 NOT_CONNECTED", async () => {
    const client = createTestClient();
    await assert.rejects(
      client.socket.getRooms(),
      isType(SocketErrorType.NOT_CONNECTED),
    );
  });
});
