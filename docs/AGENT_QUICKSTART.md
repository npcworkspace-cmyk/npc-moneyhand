# Agent 快速开始

本页给第一次接入 `npc-moneyhand` 的 Agent。产品只有 `skills/npc-moneyhand` Skill 和 `extension` Chrome 扩展；Skill 内的 `moneyhand` 控制台随任务启停。

## 1. 前提

- 桌面 Chrome/Chromium 125+；
- Node.js 20+；
- Extension 与 Agent 进程在同一台电脑；
- 一个 Agent 任务独占一个 loopback 端口；
- 不需要 `npm install`，不需要 daemon。

先在目标 Chrome Profile 中加载仓库的 `extension` 目录。首次打开弹窗，保存 `127.0.0.1:19846`。路径固定为 `/extension`。

## 2. 离线发现

在仓库根目录执行：

~~~text
node skills/npc-moneyhand/scripts/moneyhand.mjs --describe
~~~

必须只得到一行 `npc-agent-cli-descriptor/1`，并确认：

- package：`npc-moneyhand`；
- version：`1.0.0`；
- control protocol：`npc-moneyhand-control/1`；
- wire protocol：`npc-moneyhand/2`；
- executable：`moneyhand`；
- startup/stopped：`moneyhand.listening` / `moneyhand.stopped`。

`--describe` 不绑定端口、不等待 Chrome、不消费 stdin。适配器应以实际输出和 [operation catalog](../skills/npc-moneyhand/references/agent-operations.json) 为准，不要从文档猜字段。

## 3. 启动一个任务期控制台

~~~text
node skills/npc-moneyhand/scripts/moneyhand.mjs --host 127.0.0.1 --port 19846
~~~

第一条 stdout 事件是 `moneyhand.listening`。持续读取 stdout；不要等进程退出后才读。扩展会主动重连，控制台不会启动 Chrome。

发送 UTF-8 JSONL：

~~~json
{"id":"cap-1","op":"capabilities","args":{}}
{"id":"wait-1","op":"wait","args":{"timeoutMs":60000}}
{"id":"status-1","op":"status","args":{}}
~~~

每条命令使用唯一 `id`。结果可能乱序，必须按 `id` 关联。不要把 JSONL ID 当成 Task Space ID 或浏览器 request ID。

直接调用 Extension wire 方法：

~~~json
{"id":"hand-1","op":"request","args":{"request":{"method":"system.status","params":{}}}}
~~~

## 4. 多步任务先建 Task Space

默认请求每次会选择最近焦点 Profile；这适合独立探针，不适合依赖前序状态的动作。多步任务先固定当前 `instanceId + bootId`：

~~~json
{"id":"space-1","op":"createTaskSpace","args":{"taskSpaceId":"research"}}
~~~

后续通过 `taskRequest`、`navigateTaskTab` 或语义动作使用同一个 `taskSpaceId`，并声明 effect：

~~~json
{"id":"tabs-1","op":"taskRequest","args":{"taskSpaceId":"research","effect":"read-only","request":{"method":"target.list","params":{}}}}
~~~

Profile reload/restart 后 `bootId` 改变；旧 Space、snapshot 和 ref 失效，重新观察并绑定。

## 5. 默认 raw，human 必须显式

没有行为设置时走 `raw` 快速路径。只有任务明确需要时启用有界 `human`：

~~~json
{"id":"human-1","op":"request","args":{"request":{"method":"behavior.set","params":{"mode":"human","typingDelayMs":45,"pointerSteps":18,"pointerDurationMs":320,"betweenStepsMs":120,"ttlMs":300000}}}}
~~~

阶段结束必须 reset：

~~~json
{"id":"raw-1","op":"request","args":{"request":{"method":"behavior.reset","params":{}}}}
~~~

`human` 只改变输入形态和节奏，不绕过验证码、访问控制或限流。

## 6. 批量任务先 pilot

为每个站点 origin + Profile/account 建独立 rate scope。开始批量任务前先读取计划：

~~~json
{"id":"rate-1","op":"rateControl","args":{"action":"plan","input":{"scope":{"origin":"https://example.com","profile":"instance-0001"},"mode":"raw"}}}
~~~

每个小批次后把观察信号交回 `rateControl.observe`，遵守返回的 concurrency、interval、wait/stop 和 checkpoint 建议。429/503、`Retry-After`、持续 403、挑战页、账号状态变化或延迟异常都不是“继续拟人翻页”的信号。

这是调用方显式执行的调度契约；普通 `request` 不会被自动限流。需要治理的每一个批次都必须
先读 decision 再派发，不能把 `rateControl` 当成后台透明门禁。

rate controller 只能 pilot、降并发、退避、cooldown、恢复和打开 circuit；不保证避免平台限制。

## 7. 页面外操作交给人

MoneyHand 只能控制网页目标。canvas、地图、WebGL 可在明确截图映射后用页面 CDP Input；以下表面返回 `human`：

- Chrome 工具栏或扩展 UI；
- 原生保存/打印/文件对话框；
- 权限提示、系统认证和 CAPTCHA；
- 其他桌面应用。

不要把 `css-viewport-v1` 坐标当成屏幕坐标。

## 8. 正常关闭

先等已接收命令完成，再关闭：

~~~json
{"id":"drain-1","op":"drain","args":{}}
{"id":"stop-1","op":"shutdown","args":{}}
~~~

按顺序确认：

1. `drain-1` result；
2. `stop-1` result；
3. `moneyhand.stopped`；
4. stdout EOF；
5. 全部预期 result ID 已收到。

exit code `0` 不能替代 stdout 完整消费。

## 9. ESM 模式

可持续运行 JavaScript 的 Agent 应持有一个任务期实例：

~~~js
import { createMoneyHand } from "./skills/npc-moneyhand/scripts/moneyhand.mjs";

const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 19846 });

await moneyhand.start();
try {
  await moneyhand.wait({ timeoutMs: 60_000 });
  const status = await moneyhand.request({
    method: "system.status",
    params: {}
  });
} finally {
  await moneyhand.stop();
}
~~~

同一任务中的专项 Skill 或次抛模块复用这个 `moneyhand` 对象，不再启动 listener。

## 下一步

- 完整宿主模式：[AGENT_INTEGRATION.md](./AGENT_INTEGRATION.md)
- 错误与重试：[AGENT_TROUBLESHOOTING.md](./AGENT_TROUBLESHOOTING.md)
- Extension wire：[PROTOCOL.md](./PROTOCOL.md)
- 真实 Profile 验收：[REAL_CHROME_TEST.md](./REAL_CHROME_TEST.md)
