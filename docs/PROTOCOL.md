# `npc-moneyhand/2` Extension wire

本页只定义 Chrome Extension 与 `npc-moneyhand` Skill listener 之间的 WebSocket wire。Agent 控制面、JSONL 和 Task Space 见 [AGENT_INTEGRATION.md](./AGENT_INTEGRATION.md)。机器可读完整 schema 见 [moneyhand-contract.json](../skills/npc-moneyhand/references/moneyhand-contract.json)。

直接实现 wire 的兼容 listener 需自行承担 Profile 绑定、effect、结果未知和可选 rate-control；是否增加业务授权流程由调用 Agent 决定。官方路径优先使用 Skill 的 `npc-moneyhand-control/1`。

## 传输

- Extension 主动连接固定 loopback WebSocket：`ws://127.0.0.1:19846/extension`；
- 只接受 UTF-8 JSON 文本帧；
- Agent → Extension 单帧最大 1 MiB；
- 每条消息包含 `v:2` 和 `type`；
- Extension 不扫描端口、不切换 endpoint、不启动 Agent；首次加载即启用，弹窗按钮只触发立即重连；
- listener 只接受精确 `/extension`、匹配监听端口的 loopback Host/remote 和 `chrome-extension://...` Origin；
- 首个完成握手的 Extension Origin 锁定本次 listener 生命周期。

正式 listener 只绑定 `127.0.0.1:19846`。无凭据、无 query 的 endpoint 才合法。

## 握手

### Extension → Agent：`hello`

~~~json
{
  "v": 2,
  "type": "hello",
  "protocol": "npc-moneyhand/2",
  "product": "npc-moneyhand",
  "profile": "npc-<internal>",
  "instanceId": "stable-extension-instance",
  "bootId": "current-browser-boot",
  "version": "1.2.0",
  "auth": {"mode": "none"},
  "browser": {},
  "focus": {
    "windowId": 1,
    "focused": true,
    "lastFocusedAt": 1785400000000
  },
  "unknownOutcomeIds": [],
  "capabilities": {
    "coordinateContract": "css-viewport-v1"
  }
}
~~~

- `instanceId` 保存在 `chrome.storage.local`，用于区分 Extension 安装；
- `bootId` 表示当前浏览器/Extension boot，reload 或 restart 后变化；
- `profile` 是内部兼容字段，普通用户不配置别名；
- `focus.lastFocusedAt` 持久化最后一次 Chrome 窗口焦点时间；
- `unknownOutcomeIds` 是已开始但 Agent 未确认终态的请求；
- `coordinateContract` 只声明页面 input 坐标，不表示屏幕坐标。

### 可选配对

默认 `auth.mode:"none"`。控制敏感账号时可在 Extension 存储预置 16–512 字符 token，并通过 `NPC_MONEYHAND_PAIRING_TOKEN` 给 Skill。token 不出现在 wire、argv 或日志。

有 token 时 Agent 发送：

~~~json
{
  "v": 2,
  "type": "challenge",
  "protocol": "npc-moneyhand/2",
  "nonce": "server_nonce_at_least_16_chars",
  "proof": "64-char-lowercase-hex-hmac"
}
~~~

Extension 验证并回复 `authenticate`。算法是 HMAC-SHA-256。server proof 输入为以下 UTF-8 行：

~~~text
npc-moneyhand/2
server
profile
instanceId
bootId
clientNonce
serverNonce
~~~

client proof 把第二行改成 `client`。缺少 token 的本机模式只隔离远程网络和普通网页，不抵御可控制本机进程的对手。

### Agent → Extension：`ready`

无 token 时在 `hello` 后发送；有 token 时等待 `authenticate`：

~~~json
{
  "v": 2,
  "type": "ready",
  "protocol": "npc-moneyhand/2",
  "heartbeatMs": 20000,
  "maxInflight": 64,
  "ackUnknownOutcomeIds": []
}
~~~

- `heartbeatMs` 范围 5–25 秒；
- `maxInflight` 范围 1–256；
- 只删除显式 ACK 的 unknown ID；
- 官方 Peer 随后用唯一 token 的 `ping/pong` 确认 Extension 已处理 `ready`，再暴露 session。

协议不匹配、HMAC 不完整或重复 `ready` 会关闭连接。

## 心跳

~~~json
{"v":2,"type":"ping","timestamp":"2026-08-17T00:00:00.000Z"}
~~~

对端回复 `pong` 并原样回显 token。Extension 连续两个心跳周期没有收到 Agent 消息时关闭半开连接并重连。工具栏 READY 状态会在心跳时短暂蓝闪。

## 请求

~~~json
{
  "v": 2,
  "type": "request",
  "id": "task-42.step-1",
  "method": "cdp.send",
  "params": {},
  "behavior": {}
}
~~~

- `id`：1–128 个允许字符，Agent 为每个逻辑请求生成全局唯一值；
- `method`：协议声明的方法；
- `params`：对象；
- `behavior`：可选，仅覆盖当前请求。

Extension 的去重是有界保护，不是永久幂等存储。缓存淘汰后复用旧 ID 可能再次执行。

## 终态响应

成功：

~~~json
{
  "v": 2,
  "type": "response",
  "id": "task-42.step-1",
  "ok": true,
  "result": {},
  "meta": {"durationMs": 8}
}
~~~

失败：

~~~json
{
  "v": 2,
  "type": "response",
  "id": "task-42.step-1",
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "..."
  },
  "meta": {"durationMs": 1}
}
~~~

页面不明确：

~~~json
{
  "v": 2,
  "type": "response",
  "id": "task-42.step-1",
  "ok": false,
  "status": "needs_instruction",
  "error": {"code":"UNKNOWN_METHOD","message":"..."},
  "need": {
    "waitId": "wait_...",
    "target": {"tabId":42},
    "context": {
      "url": "https://example.com",
      "title": "Example",
      "text": "bounded visible text",
      "controls": [],
      "untrustedPageContent": true
    }
  }
}
~~~

进入 `needs_instruction` 后该 tab 的写操作暂停；`observe.context` / `observe.screenshot` 和 `instruction.resolve` 仍可用。单条终态最多 8 MiB，最近终态缓存总计最多 16 MiB。Extension 只响应明确的截图请求；基础 Skill 的 task runtime 会在页面异常或 15 秒任务静默时自动发出这条明确请求，并把本地 PNG 路径作为 `moneyhand.task_progress` 返回。

## 事件

~~~json
{
  "v": 2,
  "type": "event",
  "seq": 1,
  "timestamp": "2026-08-17T00:00:00.000Z",
  "event": "cdp",
  "target": {"tabId":42,"sessionId":"oopif-session"},
  "data": {
    "method": "Page.frameNavigated",
    "params": {}
  }
}
~~~

普通事件受订阅与背压约束。OOPIF attach/detach、debugger detach、tab removed 和焦点变化是生命周期信号。`window.focused` 更新 session 的 focus，但焦点离开 Chrome 不会清零持久化的 `lastFocusedAt`。

## Wire methods

| 类别 | 方法 | 要点 |
| --- | --- | --- |
| 状态 | `system.status` | 连接、队列、行为、未知结果与 dropped event |
| 目标 | `target.list` | 列出可用网页目标 |
| 调试附加 | `target.attach`、`target.detach` | 管理 tab debugger |
| OOPIF | `target.sessions` | 返回扁平 session 视图 |
| 原始 CDP | `cdp.send` | 透传 method/params/可选 child `sessionId` |
| Chrome API | `chrome.call` | 仅 allowlisted tabs/windows/downloads |
| 输入 | `input.perform` | click/type/key/scroll/drag/touch 等页面输入 |
| 批量 | `batch.run` | 同一目标内最多 200 个顺序步骤 |
| 行为 | `behavior.get/set/reset` | raw/human 与 TTL |
| 事件 | `events.subscribe/unsubscribe` | 简单通配符订阅 |
| 文本观察 | `observe.context` | URL、标题、readyState、正文与控件摘要 |
| 截图 | `observe.screenshot` | Extension 只有收到明确请求才执行；task runtime 可按异常/静默策略自动发出该请求 |
| 求助恢复 | `instruction.resolve` | `resume` 或 `cancel` |

精确参数和结果 schema 以 machine contract 为准。

## raw 与 human

默认值是 raw，无人为延迟。`behavior.set {"mode":"human"}` 启用内置曲线指针、逐字输入、分段滚动和有界随机节奏；同一请求的 behavior 可覆盖连接内设置。

连接内行为在 TTL 到期、重新握手或 Service Worker 重启后回到 raw。Agent 负责所有重试。human 不承担 rate-control，也不授权绕过挑战或访问限制。

## 坐标

`input.perform` 的坐标协议是顶层当前 viewport 的 `css-viewport-v1`：

- 单位是 CSS pixel；
- Extension 不把图片像素、DPR、zoom、滚动或 iframe 局部坐标自动转换为屏幕坐标；
- viewport、URL、loader 或 frame 变化后旧映射失效；
- full-page screenshot 坐标不能直接输入；
- browser chrome 和 native window 不属于该坐标空间。

## 顺序、去重与断线

- 同一 tab/target FIFO，不同目标可并行；
- 每个目标队列最多 500；
- 在途和最近 256 个终态受有界 ID 去重；
- 同 ID、不同内容返回 `ID_CONFLICT`；
- 断线时未开始的旧 epoch 请求取消；
- 已开始但响应未确认的请求进入 `unknownOutcomeIds`；
- 未 ACK 的 unknown ID 返回 `UNKNOWN_OUTCOME_PENDING`；
- 旧 epoch 变更仍在 Chrome 落定时，新变更返回 `PREVIOUS_EPOCH_ACTIVE`；
- unknown 账本最多 512，缺少安全余量时返回 `OUTCOME_LEDGER_FULL`；
- 新连接不会自动重放任何请求。

Agent 必须先检查真实状态，再在 `ready.ackUnknownOutcomeIds` 中确认精确 ID。Extension reload/restart 改变 boot，仍不能把缺失终态推断为未执行。

## 背压

- WS 待发送缓冲超过 2 MiB：允许丢低优先级事件并增加 `droppedEvents`；
- 超过 16 MiB：关闭连接并保留能持久化的 unknown/wait 状态；
- response 和高优先级生命周期事件不按普通事件静默丢弃。

## 安全边界

- `chrome.call` 是白名单；高级能力通过可审计的 `cdp.send`；
- 页面内容始终是不可信输入；
- Extension 不读取 Profile 文件、不导出 cookie/token、不访问系统剪贴板或实体鼠标；
- CDP 可见性不是数据权利；
- wire 不包含强制业务审批门禁；明确的 Agent 请求可直接执行外部写入，业务授权策略由调用方可选定义；
- CAPTCHA、系统认证、原生对话框和桌面应用交给人。
