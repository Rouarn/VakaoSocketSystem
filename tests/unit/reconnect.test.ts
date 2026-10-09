import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SocketError, SocketErrorType } from "../../src/errors.ts";
import { ClientCommand } from "../../src/events.ts";
import type { RoomEventPayload } from "../../src/types.ts";
import {
  connectClient,
  createTestClient,
  flushAsync,
} from "../support/fakeTransport.ts";

function acceptJoins(client: ReturnType<typeof createTestClient>): void {
  client.transport.handle(ClientCommand.JoinRoom, () => ({
    success: true,
  }));
}

describe("SocketManager — 断线与重连状态", () => {
  it("被动断开且开启自动重连时进入 connecting，并携带断开原因", async () => {
    const client = createTestClient();
    const reasons: string[] = [];
    client.socket.on("disconnect", (reason?: string) => {
      if (reason) reasons.push(reason);
    });
    await connectClient(client);

    client.transport.socket.serverDisconnect("transport close");

    assert.equal(client.socket.getState().status, "connecting");
    assert.equal(client.socket.getState().lastError, "transport close");
    assert.deepEqual(reasons, ["transport close"]);
  });

  it("io server disconnect（服务端强制下线）时不重试，进入 disconnected", async () => {
    const client = createTestClient();
    await connectClient(client);

    client.transport.socket.serverDisconnect("io server disconnect");

    assert.equal(client.socket.getState().status, "disconnected");
  });

  it("关闭自动重连后，被动断开直接进入 disconnected", async () => {
    const client = createTestClient({ reconnection: false });
    await connectClient(client);

    client.transport.socket.serverDisconnect("ping timeout");

    assert.equal(client.socket.getState().status, "disconnected");
    assert.equal(client.socket.getState().lastError, "ping timeout");
  });

  it("reconnect_attempt 更新重连计数并触发 reconnecting 事件", async () => {
    const client = createTestClient();
    const attempts: number[] = [];
    client.socket.on("reconnecting", (attempt: number) =>
      attempts.push(attempt),
    );
    await connectClient(client);

    client.transport.socket.serverDisconnect("transport close");
    client.transport.socket.serverReconnectAttempt(1);
    client.transport.socket.serverReconnectAttempt(2);

    assert.deepEqual(attempts, [1, 2]);
    assert.equal(client.socket.getState().reconnectCount, 2);
    assert.equal(client.socket.getState().status, "connecting");
  });
});

describe("SocketManager — 重连后自动恢复房间", () => {
  it("重连成功后自动重新加入所有房间（携带各自的 userId），并触发 reconnected/roomJoined", async () => {
    const client = createTestClient();
    acceptJoins(client);
    const joined: RoomEventPayload[] = [];
    const lifecycle: string[] = [];
    client.socket.on("roomJoined", payload => joined.push(payload));
    client.socket.on("connect", () => lifecycle.push("connect"));
    client.socket.on("reconnected", () => lifecycle.push("reconnected"));
    await connectClient(client, "sid-1");

    await client.socket.joinRoom("room-a", "user-a");
    await client.socket.joinRoom("room-b", "user-b");

    // 模拟网络中断后自动重连
    client.transport.socket.serverDisconnect("transport close");
    client.transport.socket.serverReconnectAttempt(1);
    client.transport.socket.serverConnect("sid-2");
    await flushAsync();

    const state = client.socket.getState();
    assert.equal(state.status, "connected");
    assert.equal(state.socketId, "sid-2");
    assert.equal(state.reconnectCount, 1);
    assert.deepEqual(lifecycle, ["connect", "reconnected"]);

    // 初次 2 次 join + 重连恢复 2 次 join
    assert.equal(client.transport.socket.emitCount(ClientCommand.JoinRoom), 4);
    const restorePayloads = client.transport.socket.emits
      .filter(record => record.event === ClientCommand.JoinRoom)
      .slice(2)
      .map(record => record.payload);
    assert.deepEqual(restorePayloads, [
      { roomId: "room-a", userId: "user-a" },
      { roomId: "room-b", userId: "user-b" },
    ]);

    assert.deepEqual(joined.slice(2), [
      { roomId: "room-a", userId: "user-a" },
      { roomId: "room-b", userId: "user-b" },
    ]);
    assert.deepEqual(client.socket.getJoinedRooms(), ["room-a", "room-b"]);
  });

  it("单个房间恢复失败时抛出 error 事件，但保留记录以便下次重连重试", async () => {
    const client = createTestClient();
    let joinCalls = 0;
    client.transport.handle(ClientCommand.JoinRoom, payload => {
      joinCalls++;
      const roomId = (payload as { roomId: string }).roomId;
      // 前两次为首次加入（应成功）；之后为重连恢复，room-bad 恢复失败
      if (joinCalls > 2 && roomId === "room-bad") {
        return { success: false, error: "房间已解散" };
      }
      return { success: true };
    });
    const errors: SocketError[] = [];
    client.socket.onError(error => errors.push(error));
    await connectClient(client);

    await client.socket.joinRoom("room-good", "user-1");
    await client.socket.joinRoom("room-bad", "user-1");

    client.transport.socket.serverDisconnect("transport close");
    client.transport.socket.serverConnect("sid-2");
    await flushAsync();

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.type, SocketErrorType.ROOM_JOIN_FAILED);
    assert.equal(errors[0]?.message, "房间已解散");

    // 两个房间记录都保留，下次重连仍会尝试
    assert.deepEqual(client.socket.getJoinedRooms(), ["room-good", "room-bad"]);

    // 再重连一次，room-good 恢复成功，room-bad 仍失败并再次上报
    client.transport.socket.serverDisconnect("transport close");
    client.transport.socket.serverConnect("sid-3");
    await flushAsync();

    assert.equal(errors.length, 2);
  });

  it("主动 disconnect 后重新连接不会恢复旧房间，且首次连接只触发 connect", async () => {
    const client = createTestClient();
    acceptJoins(client);
    const lifecycle: string[] = [];
    client.socket.on("connect", () => lifecycle.push("connect"));
    client.socket.on("reconnected", () => lifecycle.push("reconnected"));
    await connectClient(client);
    await client.socket.joinRoom("room-a", "user-a");

    client.socket.disconnect();
    await connectClient(client);
    await flushAsync();

    assert.deepEqual(client.socket.getJoinedRooms(), []);
    assert.deepEqual(lifecycle, ["connect", "connect"]);
    // 旧实例上初次加入 1 次；新实例上不应有任何房间恢复请求
    assert.equal(
      client.transport.instances[0]?.emitCount(ClientCommand.JoinRoom),
      1,
    );
    assert.equal(
      client.transport.instances[1]?.emitCount(ClientCommand.JoinRoom),
      0,
    );
  });
});
