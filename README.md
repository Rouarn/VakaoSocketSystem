# Socket System (TypeScript, socket.io-client)

## 概述

一个基于 `socket.io-client` 的轻量、类型安全、无框架依赖的 Socket 系统。提供稳定的连接管理、房间管理与消息通信能力，并具备自动重连与完善的错误处理逻辑。

## 模块结构

- `socketManager.ts`：核心管理器，实现连接、重连、房间、消息、事件订阅与错误处理
- `index.ts`：顶层简洁 API 暴露（连接、断开、发送消息、监听消息）
- `useSocket.ts`：函数式封装（加入房间、连接信息、事件订阅等）
- `useChatSocket.ts`：聊天场景工具（连接状态监控与消息监听）

## 安装依赖

```bash
pnpm install socket.io-client
```

## 快速开始

```ts
import { connect, disconnect, sendMessage, onMessage } from "./index";
import { joinRoom } from "./useSocket";
import { socketManager } from "./socketManager";

// 可选：设置认证令牌
socketManager.setAuthToken("your-jwt-token");

// 建立连接
await connect();

// 加入房间
await joinRoom("room-1", "user-123");

// 监听消息
const off = onMessage(payload => {
  // payload 来自服务端的标准化消息
  console.log("message:", payload);
});

// 发送消息
await sendMessage("room-1", "hello");

// 取消监听
off();

// 断开连接
disconnect();
```

## 标准化消息结构

发送与接收统一采用：

```ts
type MessageData = {
  id?: string;
  room: string;
  content: string;
  ts: number;
  sender?: string;
};
```

## 连接状态

```ts
import { getConnectionInfo } from "./useSocket";

const info = getConnectionInfo(); // { status, socketId?, reconnectCount, lastConnectedAt?, lastError? }
```

也可使用聊天工具：

```ts
import { createChatSocket } from "./useChatSocket";

const chat = createChatSocket();
const offState = chat.onStateChange(info => {
  console.log("state:", info.status);
});
```

## 房间管理

```ts
import { joinRoom, getJoinedRooms } from "./useSocket";

await joinRoom("room-1", "user-123");
console.log(getJoinedRooms()); // ['room-1']
// 离开房间：socketManager.leaveRoom('room-1')
```

## 错误类型

所有错误采用统一的 `SocketError`：

```ts
import { SocketError, SocketErrorType } from "./socketManager";

try {
  await sendMessage("room-1", "hello");
} catch (e) {
  if (e instanceof SocketError) {
    // e.type in SocketErrorType
    console.error(e.type, e.message);
  }
}
```

## 自动重连

- 开启 `reconnection: true`（默认）
- 在 `reconnect` 事件后，自动恢复房间订阅与事件监听

## 性能与可维护性
- 无 Vue 等框架依赖，适用于 Node/浏览器/多框架
- 事件驱动，无多余轮询
- 模块化接口，便于扩展（如新增命名空间、更多事件类型）

## 在前端项目中使用（全流程）

### 安装
```
pnpm add @vakao-ui/socket-system
```

本地包测试：
```
pnpm add C:\Rouarn\DEV\socket\vakao-ui-socket-system-0.1.0.tgz
```

### 推荐用法（类实例方式）

创建并配置管理器实例：
```ts
import { SocketManager } from '@vakao-ui/socket-system'

const socket = new SocketManager({
  url: 'https://your-socket-server',
  namespace: '/chat',
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  timeout: 20000,
  transports: ['websocket'],
})
```

设置认证令牌（可选）并连接：
```ts
socket.setAuthToken('your-jwt-token')
await socket.connect()
```

加入房间与发送消息：
```ts
await socket.joinRoom('room-1', 'user-123')
await socket.sendMessage('room-1', 'hello world')
```

监听消息与连接状态：
```ts
socket.on('message', (payload) => {
  // payload: { id, room, content, ts, sender? }
})

const info = socket.getConnectionInfo()
// info: { status, socketId?, reconnectCount, lastConnectedAt?, lastError? }
```

清理与断开：
```ts
socket.off('message')
socket.disconnect()
```

### 事件与消息约定
- 客户端发送与服务端回调：
  - `join-room`、`leave-room`、`send-message`、`get-rooms`（回调 `RoomResponse`）
- 服务端广播：
  - `message`（负载 `{ id?, room, content, ts, sender? }`）
- 客户端标准化消息：
  - `MessageData`：`{ id?: string; room: string; content: string; ts: number; sender?: string }`

### 错误处理（统一错误类型）
```ts
import { SocketError } from '@vakao-ui/socket-system'

try {
  await socket.sendMessage('room-1', 'hello')
} catch (e) {
  if (e instanceof SocketError) {
    // e.type 与 e.message 可用于定位问题
  }
}
```

### 重连与状态恢复
- 自动重连开启后会尝试恢复连接
- 重连成功将自动：
  - 重新加入之前的房间
  - 重新绑定所有事件监听器

### 简洁工具（可选）
如仅需默认单例监听消息与状态，使用：
```ts
import { createChatSocket } from '@vakao-ui/socket-system'

const chat = createChatSocket()
const offMsg = chat.onMessage((msg) => {})
const offState = chat.onStateChange((info) => {})
await chat.connect()
offMsg()
offState()
chat.disconnect()
```

## API 参考

### index.ts

- `connect(): Promise<void>` 建立连接
- `disconnect(): void` 断开连接
- `sendMessage(roomId: string, content: string): Promise<void>` 发送消息
- `onMessage(cb): () => void` 监听消息，返回取消订阅函数

### useSocket.ts

- `joinRoom(room: string, userId?: string): Promise<void>` 加入房间
- `getJoinedRooms(): string[]` 已加入房间列表
- `connect()/disconnect()` 连接控制
- `getRooms(): Promise<ServerRoomItem[]>` 获取房间列表
- `getConnectionInfo(): ConnectionInfo` 获取连接状态快照
- `on(event, cb)/off(event, cb?)` 事件订阅与取消
- `emit(event, data?)` 发送自定义事件

### socketManager.ts（核心）

- `setAuthToken(token?: string)` 设置认证令牌
- `connect()/disconnect()` 连接控制
- `joinRoom(roomId, userId?)` 加入房间（重连后自动恢复）
- `leaveRoom(roomId)` 离开房间
- `sendMessage(roomId, content)` 发送消息（标准化）
- `getRooms()` 获取房间列表
- `on(event, cb)/off(event, cb?)` 事件订阅与取消
- `emit(event, data?)` 自定义事件发送
- `getConnectionInfo()` 获取连接状态快照

## 发布流程（pnpm）

### 前置准备

- 确保包名为 Scoped（当前：`@vakao-ui/socket-system`）且需公开发布时使用 `--access public`
- 登录 npm（任选其一）：
  - `pnpm login` 或 `npm login`
- 可选：设置私有 registry：
  - `pnpm config set registry https://registry.npmjs.org/`

### 版本管理

- 采用标准语义化版本：`major.minor.patch`
- 快速修改版本（任选其一）：
  - 编辑 `package.json` 的 `version` 字段
  - `pnpm version patch` 或 `pnpm version minor` / `pnpm version major`

### 构建与打包

- 构建：`pnpm run build`
- 本地打包验证：`pnpm pack`
  - 产物：`vakao-ui-socket-system-<version>.tgz`
  - 可在其它项目中执行：`pnpm add <path-to-tgz>` 进行本地安装测试

### 预发布检查

- 干跑：`pnpm run publish:dry`
  - 使用 `--dry-run` 模拟发布，检查文件列表、元信息与访问权限

### 正式发布

- 公共发布：`pnpm run publish:public`
  - 脚本等价于：`pnpm publish --access public --no-git-checks`
  - 如使用自定义 registry：在命令后附加 `--registry <url>`
  - 如开启两步验证：追加 `--otp <code>`

### 常见问题

- 无法找到构建产物：请确认已执行 `pnpm run build`，且 `dist` 已包含导出文件
- 403 或权限错误：确认已登录正确 npm 账户并具备 `@vakao-ui` scope 发布权限
- 未公开包：发布 Scoped 包到公共仓库必须携带 `--access public`

## 开发提示

- 确保服务端事件名与客户端一致（示例：`join-room`, `leave-room`, `send-message`, `get-rooms`, `message`）
- 若使用认证，服务端需支持 `auth.token` 或 `query.token`
- 生产环境建议在外部处理令牌刷新并调用 `setAuthToken`
