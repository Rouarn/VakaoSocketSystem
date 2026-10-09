# Socket System (TypeScript, socket.io-client)

## 概述

一个基于 `socket.io-client` 的轻量、类型安全、无框架依赖的 Socket 库，适用于 Node 与浏览器环境。提供连接管理、自动重连、房间恢复、标准化消息与统一错误处理。

设计原则：

- **单一入口、实例化使用**：所有能力从一个 `SocketManager` 实例获得，没有隐藏的全局单例，支持多连接并存。
- **依赖注入、天然可测**：传输层（socket.io-client）与计时器均为可替换依赖，测试时注入内存假实现与虚拟时钟即可，无需真实网络与真实定时器。
- **统一错误模型**：一切可预期失败都抛出带 `type` 的 `SocketError`。

## 安装

```bash
pnpm add socket.io-client   # 运行时唯一依赖
pnpm add @vakao-ui/socket-system
```

要求 Node.js >= 18（仅开发/测试时需要；库本身可在现代浏览器中使用）。

## 快速开始

```ts
import { createSocket } from "@vakao-ui/socket-system";

// 1. 创建实例（此时不会建立连接）
const socket = createSocket({
  url: "https://socket.example.com",
  namespace: "/chat",
  auth: { token: "your-jwt-token" },
});

// 2. 订阅（所有 on* 方法都返回取消订阅函数）
const offMessage = socket.onMessage(message => console.log("收到:", message));
const offState = socket.onStateChange(info => console.log("状态:", info.status));
socket.onError(error => console.error(error.type, error.message));

// 3. 连接、加入房间、发消息
await socket.connect();
await socket.joinRoom("room-1", "user-123");
await socket.sendMessage("room-1", "hello world");

// 4. 清理
offMessage();
offState();
await socket.leaveRoom("room-1");
socket.disconnect();
```

## 模块结构

```
src/
├── index.ts          # 唯一公共出口
├── SocketManager.ts  # 核心类 + createSocket() 工厂
├── chat.ts           # 聊天场景的轻量门面 createChatSocket()
├── transport.ts      # 传输层抽象 SocketLike/SocketFactory 与 socket.io-client 适配器
├── emitter.ts        # 独立的类型安全事件发射器
├── events.ts         # 协议常量：客户端命令与服务端事件名
├── errors.ts         # SocketError 与 SocketErrorType
├── scheduler.ts      # 计时器抽象（默认 setTimeout/clearTimeout）
└── types.ts          # 公共数据类型
```

依赖方向单一：`SocketManager` 依赖 `transport`/`scheduler`/`emitter` 抽象，不直接依赖具体平台 API。

## 配置

`createSocket(config, dependencies?)`：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `url` | `string` | —（必填） | 服务端地址，末尾斜杠会自动去除 |
| `namespace` | `string` | 无 | 命名空间，如 `/chat` |
| `auth.token` | `string` | 无 | 认证令牌，通过 socket.io `auth`/`query` 传递；也可随时调用 `setAuthToken()` 更新 |
| `userId` | `string` | 自动生成 | 加入房间未显式传 userId 时使用；自动生成的 ID 在实例生命周期内复用 |
| `reconnection` | `boolean` | `true` | 是否自动重连 |
| `reconnectionAttempts` | `number` | `5` | 最大重连次数 |
| `reconnectionDelay` | `number` | `1000` | 重连初始间隔（毫秒） |
| `timeout` | `number` | `20000` | 连接与服务端应答超时（毫秒） |
| `transports` | `string[]` | `["websocket"]` | 底层传输方式 |

第二个参数 `dependencies` 为可选的依赖注入，一般无需提供：

```ts
createSocket(config, {
  transport: socketIoFactory, // 默认即 socket.io-client；测试时替换为假工厂
  scheduler: defaultScheduler, // 默认即全局定时器；测试时替换为虚拟时钟
});
```

## API 参考

### 连接与状态

```ts
await socket.connect();          // 建立连接；重复调用返回同一个进行中的 Promise
socket.disconnect();             // 主动断开（会清空房间记录，不再自动恢复）
socket.isConnected();            // 当前是否已连接
socket.getState();               // 连接信息快照：{ status, socketId?, reconnectCount, lastConnectedAt?, lastError? }
socket.setAuthToken(token);      // 更新令牌（对下一次连接/重连生效）
```

`status` 取值：`"disconnected" | "connecting" | "connected" | "error"`。
监听状态变化：`socket.onStateChange(info => {})`。

### 房间管理

```ts
await socket.joinRoom("room-1", "user-123"); // userId 可省略，回退到 config.userId
await socket.leaveRoom("room-1");
socket.getJoinedRooms();                     // string[]，当前记录中的房间
const rooms = await socket.getRooms();       // 拉取服务端房间列表 ServerRoomItem[]
```

每个房间的 userId 按房间分别记录，互不影响。断线（非主动断开）不会清空房间记录。

### 消息

```ts
await socket.sendMessage("room-1", "hello");
socket.onMessage(message => {}); // message: MessageData
```

`sendMessage` 会自动补全消息：生成 `id`（`msg_` 前缀）、填充 `ts` 与发送者，并裁剪房间 ID 与内容两端空白。

### 自定义事件

```ts
socket.emit("typing", { room: "room-1" });
const off = socket.on("user:typing", payload => {});
socket.once("announcement", payload => {});
socket.off("user:typing", listener); // 省略第二个参数则移除该事件全部监听器
socket.clearListeners();
```

### 错误处理

所有可预期失败都抛出 `SocketError`，可按 `type` 程序化分支处理：

```ts
import { SocketError, SocketErrorType, isSocketError } from "@vakao-ui/socket-system";

try {
  await socket.sendMessage("room-1", "hello");
} catch (error) {
  if (isSocketError(error)) {
    // 或 error instanceof SocketError
    console.error(error.type, error.message, error.cause);
  }
}
```

| `SocketErrorType` | 触发场景 |
| --- | --- |
| `CONNECTION_FAILED` | 握手失败、网络不可达 |
| `CONNECTION_CANCELLED` | 连接过程中主动断开 |
| `NOT_CONNECTED` | 未连接时调用需要连接态的操作 |
| `ROOM_JOIN_FAILED` | 参数非法、服务端拒绝加入 |
| `ROOM_LEAVE_FAILED` | 参数非法、未加入房间、服务端拒绝离开 |
| `ROOMS_FETCH_FAILED` | 房间列表获取失败或数据结构异常 |
| `MESSAGE_SEND_FAILED` | 参数非法、服务端拒绝消息 |
| `TIMEOUT` | 连接或服务端应答超时 |

除 `try/catch` 外，异步重连、房间恢复等后台失败会通过 `socket.onError(cb)` 上报。

## 自动重连与房间恢复

- `reconnection: true`（默认）时，底层传输断线后由 socket.io 在**同一连接实例**上自动重连。
- 重连尝试时状态变为 `connecting` 且 `reconnectCount` 递增；重连成功后：
  - 状态回到 `connected`，更新 `socketId` 与 `lastConnectedAt`；
  - 自动重新加入断线前所有房间（按房间保存的 userId 逐一恢复）。
- 单个房间恢复失败会抛出 `error` 事件，但**保留该房间记录**，下一次重连会继续重试。
- 只有主动调用 `disconnect()` 才会清空房间记录并停止一切恢复。

## 聊天门面 createChatSocket

在 `SocketManager` 之上提供面向聊天 UI 的轻量封装（无状态、无单例，必须显式传入管理器实例）：

```ts
import { createSocket, createChatSocket } from "@vakao-ui/socket-system";

const socket = createSocket({ url: "https://socket.example.com", userId: "user-1" });
const chat = createChatSocket(socket, { selfId: "user-1" });

const off = chat.onMessage(msg => {
  // msg: ChatMessage —— 在 MessageData 基础上补充
  // msg.self（是否为自己发送）与 msg.status: "sending" | "sent" | "failed"
});
chat.onStateChange(info => {});

await chat.connect();
chat.disconnect();
off();
```

## 服务端协议约定

客户端命令（带 ack 回调，应答结构 `{ success: boolean, error?: string, data?: unknown }`）：

- `join-room`：负载 `{ roomId, userId }`
- `leave-room`：负载 `{ roomId, userId }`
- `send-message`：负载标准化 `MessageData`
- `get-rooms`：应答 `data` 为 `ServerRoomItem[]`（`{ id, name, type, members }`）

服务端广播事件：

- `message`：负载 `MessageData`
- 连接生命周期事件：`connect` / `disconnect` / 重连尝试 / 状态变更 / 错误

这些名称由 `ClientCommand` 与 `SocketEvent` 常量导出，避免手写字符串出错。

## 测试

测试**不依赖任何第三方测试库**，仅使用 Node.js 内置的 `node:test` 与 `node:assert/strict`：

```bash
pnpm test        # 先做完整类型检查（pretest），再运行 tests/ 下全部用例
```

测试布局：

```
tests/
├── unit/           # 错误模型、事件发射器、连接、房间、消息、重连、聊天门面
├── integration/    # connect → join → message → 断线重连 → 恢复房间 → leave 全流程
└── support/
    ├── fakeTransport.ts   # 内存传输假实现 FakeSocket/FakeTransport
    └── virtualScheduler.ts # 虚拟时钟，advance(ms) 同步推进定时器
```

可测试性来自构造期依赖注入，无需网络即可确定性地测试：

```ts
import { createSocket } from "../../src/SocketManager.ts";
import { FakeTransport } from "../support/fakeTransport.ts";
import { VirtualScheduler } from "../support/virtualScheduler.ts";

const transport = new FakeTransport();
const scheduler = new VirtualScheduler();
const socket = createSocket(
  { url: "http://fake", timeout: 5000 },
  { transport: transport.create, scheduler },
);

// 预置“服务端行为”
transport.handle("join-room", () => ({ success: true }));

// 驱动连接生命周期
await socket.connect();
transport.socket.serverConnect();   // 模拟握手成功
transport.socket.serverEmit("message", message); // 模拟服务端推送
transport.socket.serverDisconnect("transport close");
transport.socket.serverConnect();   // 模拟自动重连
scheduler.advance(5000);            // 同步触发任何到期定时器，无需真实等待
```

在自有项目中替换 `SocketFactory`（`(url, options) => SocketLike`）即可接入其它传输实现。

## 发布流程（pnpm）

### 前置准备

- 包名为 Scoped（`@vakao-ui/socket-system`），公开发布需 `--access public`
- 登录：`pnpm login`
- 可选：`pnpm config set registry https://registry.npmjs.org/`

### 版本与构建

- 语义化版本：编辑 `package.json` 的 `version`，或 `pnpm version patch|minor|major`
- 构建：`pnpm run build`（输出到 `dist/`，含 `.js` / `.d.ts` / source map）
- 本地打包验证：`pnpm pack`，再到其它项目 `pnpm add <path-to>.tgz` 安装验证

### 发布

- 干跑检查：`pnpm run publish:dry`
- 正式发布：`pnpm run publish:public`（等价 `pnpm publish --access public --no-git-checks`）
- 自定义 registry 追加 `--registry <url>`；开启 2FA 追加 `--otp <code>`

## 开发提示

- 服务端事件名需与 `ClientCommand` / `SocketEvent` 保持一致
- 认证令牌建议在外部处理刷新逻辑，再调用 `setAuthToken()` 更新
- 库为纯 ESM、`sideEffects: false`，可安全 tree-shaking
