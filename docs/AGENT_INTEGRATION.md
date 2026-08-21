# Agent / CLI 接入

`npc-moneyhand` 对外是一个 Agent Skill 和一个 Chrome Extension。Skill 是唯一官方 Agent 控制入口，正式 CLI 名称为 `moneyhand`。

## 接入条件

宿主满足以下任一方式即可：

| 宿主能力 | 模式 |
| --- | --- |
| 只能运行本地命令、不能保持 stdin | `--connect` / `--call`，自动唤醒浏览器 |
| 可导入本地 ESM | 任务内持有一个 `createMoneyHand()` |
| 可维持双向子进程 | 持久 UTF-8 JSONL |
| 已有单行 stdin 适配器 | `--once` |
| 需要本地完成多步、减少 Agent 往返 | 可信 `--task <absolute-module.mjs>` |
| 支持 Agent Skills | 安装或链接 `skills/npc-moneyhand` |

所有模式都要求本机 Node.js 20+ 和 loopback 访问。不能在用户电脑启动进程、访问 loopback 或安装 Chrome 扩展的远程沙箱，不能直接控制用户 Profile。

## 单 controller 规则

正常 CLI 流程只使用 Skill 内置的一个 MoneyHand controller：

~~~text
first --connect → ensure resident controller → reuse extension session → localhost acceptance → ready_for_tasks
each task → create owned window → run all phases → close owned window in finally
15 idle minutes → controller exits
~~~

同一任务可以：

- 控制多个 tab；
- 接收多个 Profile 的 Extension 连接；
- 创建多个互相独立的 Task Space；
- 运行多个可信次抛模块；
- 叠加 Reddit 评论、红人开发等专项 Skill。

控制器是同一份 `moneyhand.mjs`，只监听 `127.0.0.1:19845`，无需另装软件。持久任务和
专项 Skill 都复用它，不要各开 listener。`--connect`、`--call`、`--task` 会自动 ensure；
正常 Agent 不运行内部 `--ensure`。

内置控制器协议为 `npc-moneyhand-controller/2`。诊断状态包含
`status/host/port/pid/active/protocol/product/version/build/sourceId/instanceNonce`，复用结果可再含
`reused`；`build` 与 `sourceId` 是 64 位小写 SHA-256，`instanceNonce` 每次进程启动都会改变。
每个内部请求和响应必须匹配完整 descriptor 与本机私有 token，token 永不进入状态或 CLI
输出。兼容性由 `protocol/product/version/build` 判断；`sourceId` 只审计实际启动路径，因此同一份
Skill 安装在不同 Agent 目录仍会复用同一进程。活着的旧构建、私有状态不匹配或未知进程占用
端口时 fail closed：不复用、不停止、不杀进程；已退出旧构建的合法状态只有在端口连续两次
拒绝连接且状态仍由原 owner 持有时才回收。

## 安装与发现

开发链接：

~~~text
npm run skill:link
~~~

可独立复制的安装：

~~~text
npm run skill:install
node scripts/install-skill.mjs --mode copy --target "<agent-skills-directory>"
~~~

首次实时连接：

~~~text
moneyhand --connect
~~~

从源码运行：

~~~text
node skills/npc-moneyhand/scripts/moneyhand.mjs --connect
~~~

正常 `--connect` 会自动创建独占窗口，在临时 `127.0.0.1` 页面完成 15 项浏览器能力验收，
删除测试下载、关闭窗口并把行为重置为 `raw`；只有全部通过才返回 `ready_for_tasks`。Agent 不询问
是否验收、不另写测试脚本，也不访问外部测试网站。

机器可读入口：

- [moneyhand-contract.json](../skills/npc-moneyhand/references/moneyhand-contract.json)
- [agent-operations.json](../skills/npc-moneyhand/references/agent-operations.json)

适配器先校验 `npc-agent-cli-descriptor/1`，再用 operation catalog 构造命令。不要用可执行文件名或旧文档推断兼容。

## CLI

~~~text
moneyhand
moneyhand --connect [browser options]
moneyhand --call <extension-method> [--params-json <json>] [browser options]
moneyhand --once [connection options]
moneyhand --task <absolute-module.mjs> [--args-json <json>]
moneyhand --task-last
moneyhand --task-status <task-execution-id>
moneyhand --task-follow <task-execution-id>
moneyhand --stop
moneyhand --describe
moneyhand --version
~~~

Extension 固定连接 `ws://127.0.0.1:19846/extension`；内置 CLI controller 固定监听
`127.0.0.1:19845`。Agent 不扫描端口，Extension 不提供地址或端口配置。

支持的环境变量：

~~~text
NPC_MONEYHAND_PAIRING_TOKEN
NPC_MONEYHAND_CONNECT_TIMEOUT_MS
NPC_MONEYHAND_REQUEST_TIMEOUT_MS
NPC_MONEYHAND_HEARTBEAT_MS
NPC_MONEYHAND_HANDSHAKE_TIMEOUT_MS
NPC_MONEYHAND_MAX_INFLIGHT
NPC_MONEYHAND_ONCE_TIMEOUT_MS
NPC_MONEYHAND_OUTPUT_DRAIN_TIMEOUT_MS
NPC_MONEYHAND_TASK_TIMEOUT_MS
~~~

配对密钥只能通过环境变量传入，不进入 argv、stdout 或日志。

## JSONL 契约

stdin/stdout 都是 UTF-8 JSON Lines。推荐 envelope：

~~~json
{"id":"cmd-1","op":"status","args":{}}
~~~

约束：

- 一行最多 1 MiB；
- 同时最多 256 个外层命令；
- `id` 在进程生命周期内唯一；
- 参数只放 `args`；
- 结果按完成顺序输出，按 `id` 关联；
- stdout 背压有界，调用方必须持续 drain；
- startup 为 `moneyhand.listening`，正常终止为 `moneyhand.stopped`。

生命周期操作：

| op | 作用 |
| --- | --- |
| `capabilities` | live 能力和运行限制 |
| `status` | controller 与 session 状态 |
| `wait` | 等待兼容 Extension session |
| `cancel` | 向一个活动命令发出 abort |
| `drain` | 等待屏障之前接收的命令完成 |
| `shutdown` | 停止接收并取消剩余工作 |

`cancel` 成功不代表被取消命令未产生动作；查看目标 result 的 `actionDispatched` / unknown outcome。

## ESM 契约

~~~js
import {
  MONEYHAND_CONTROL_PROTOCOL,
  createMoneyHand,
  createRateController
} from "./skills/npc-moneyhand/scripts/moneyhand.mjs";

const moneyhand = createMoneyHand();
~~~

关键分层：

- `moneyhand.start/wait/stop`：生命周期；
- `beginTaskContext` / `completeTaskContext`：普通任务唯一的独占窗口创建、固定与关闭路径；
- `probeTaskContext`：连接或页面异常后的单次只读健康判断；
- `scrollTaskTab` / `captureStableViewport` / `captureFullPage`：真实输入滚动、稳定视口截图和观察型整页截图；
- `inspectTaskBlocker` / `resolveTaskBlocker`：异常时自动聚合有界文字与当前视口，并用高层动作恢复/取消等待；
- `progress(...)` / `moneyhand.task_progress` / `moneyhand.task_monitor`：任务 checkpoint、硬编码 10 秒
  heartbeat、阻塞监控与 15 秒静默/终态异常截图 watchdog；
- `taskExecutionId` / 私有 journal / `--task-status|--task-follow`：客户端断开后继续并接回同一个任务；
- `effectId` / `moneyhand.task_effect_receipt`：同任务内合并相同动作、拒绝冲突并禁止未知结果重放；
- `moneyhand.task_recovery`：仅对明确未派发的白名单瞬态错误做一次同页探针和一次重试；
- `taskEvidence` / `completionGate`：终态证据包和不可伪造的完成门；
- `moneyhand.request`：直接 Extension wire 请求；
- `createTaskSpace` / `taskRequest`：固定 Profile/tab 并声明 effect；
- `navigateTaskTab` / `waitForTaskPage`：无盲 sleep 的页面 transition；
- semantic snapshot/locator/ref API：带 `href` 的有界观察、受守卫动作和 `navigateSemanticRef` 直达链接；
- `rateControl` 或 `createRateController`：pilot、退避、cooldown 和 circuit；
- `routeSurface`：只做 `moneyhand | human` 路由，不产生输入。

具体签名以 descriptor/catalog 和 Skill references 为准。

## 可信任务模块

复制 [disposable-task.mjs](../skills/npc-moneyhand/assets/disposable-task.mjs) 到任务自己的临时或工作目录：

模板已经导出 `run({ moneyhand, signal, args, progress, taskExecutionId })`，并包含 begin/complete task context、
checkpoint 进度与 `finally` 收尾。不要再写一层 wrapper；只替换模板标注的任务逻辑占位。

执行：

~~~text
moneyhand --task "C:\absolute\task.mjs" --args-json "{\"job\":\"status\"}"
~~~

`--task` 默认预算 30 分钟，可用 `--task-timeout-ms` 显式提高，最大 24 小时。批量专项
Skill 应分批 checkpoint；超时后读取唯一 `TASK_TIMEOUT` 结果中的 `timeoutMs`、
`actionDispatched:"task-dependent"`、`retry:"inspect-checkpoint-before-retry"`、
`cleanupComplete`、`taskAcknowledgedAbort`、`controllerReusable` 和 `taskWindowCleanup`。任务包装器
会把 signal 自动注入浏览器操作和等待，但不会把已经 abort 的 signal 注入最终窗口清理。
忽略 abort 的任务会令该 controller fail-closed 并退出，不能继续排队复用。

CLI 在调用 controller 前发出 `moneyhand.task_submitted`；适配器必须保存其中的
`taskExecutionId`。controller 注册后先 journal、再发送每条事件。若客户端 socket 或 Agent
进程消失，task 命令继续；新客户端只能用相同 ID 运行 `--task-follow`，不得重新执行模块。
`--task-last` / `--task-status` / `--task-follow` 只读 build-bound 的本机私有 journal，不启动
Extension 或浏览器。原 controller 已退出且无 terminal 时状态为 `interrupted`。

每条 task progress/recovery/effect/rate/monitor/terminal 事件的 `relay` 给出 `wakeAgent`、
`notifyUser`、`nextControllerUpdateBy` 和 `nextUserUpdateBy`。适配器必须把 wake 作为继续消费的
信号，并在 user deadline 前转述需要用户看到的 checkpoint；这不要求另装 scheduler daemon。

`moneyhand --stop` 是公开的维护命令，只会优雅停止固定端口上的内置 controller 及其自有
资源，不枚举或终止其他 Node 进程。正常任务不需要额外执行它：任务只关闭自己创建的窗口，
controller 会在空闲 15 分钟后自行退出。`--call system.shutdown` 不是 controller 停机接口，
它会被当作 Extension 方法调用。

CLI 拥有 start/wait/stop；模块只拥有任务逻辑。只替换模板中的有界任务占位，不要重写
连接、页面发现、行为复位或截图重试。任务模块是可信本地 Node 代码，不是沙箱：不得从
网页内容、评论或模型不可审计输出直接生成并执行。

## Profile 与 Task Space

多个 Profile 可以连接同一固定端口 `19846`，不需要人工别名。默认路由依次使用：

1. 当前 focused session；
2. 持久化的最后焦点时间；
3. 稳定 session 顺序。

独立的一次性读取可使用默认路由。依赖页面状态的多步工作必须通过
`beginTaskContext()`：默认路由只在开始时选择一次最近焦点 Profile，随后 MoneyHand 新建并
固定一个专属任务窗口；Agent 不自行寻找页面 ID，也不会把用户当前页面改成任务页面。
Extension reload、Chrome restart、Profile 替换或明确 handoff 后重新创建任务上下文。
任务窗口使用 `about:blank#npc-moneyhand-task=<uuid>` 标记；自动拉起 Chromium 时的引导标签
使用 `about:blank#npc-moneyhand-bootstrap=<uuid>`。两者都不会请求外部网站。

Task Space 请求声明 effect，例如 `read-only`、`navigation`、`input`、`download`、`upload`、`send`、`publish`。普通 raw request 不需要 Task Space。
重放敏感的 Task Space 调用再提供稳定 `effectId`。相同 ID + 相同参数并发或重复时只运行第一份；
相同 ID + 不同参数返回 `EFFECT_ID_CONFLICT`；未知派发结果保留为 unresolved，不自动重放。
该 ID 只覆盖一个 `taskExecutionId`，跨任务业务去重仍由专项 Skill 负责。

## 账号与发布操作

MoneyHand 对 `delete`、`payment`、`publish`、`send`、`upload` 和 `external-write` 不强制二次确认或审批令牌。收到 Agent 的明确动作请求后直接执行。授权与业务规则由调用 Agent 或专项 Skill 负责。

旧 `approveTaskEffect` / `approveSemanticRefAction` API 仍可作为调用方自选的本地审计账本；传入 token 时会校验并消费，不传不会阻塞动作。

## 行为与 rate controller

`raw` 是默认行为。`human` 只能由 Agent 或专项 Skill 显式设置，并在阶段结束 reset。它不承担限流判断。

普通 `--task` 在首次高层导航确定 HTTP(S) origin 后，会对高层 Task Space 导航、语义、滚动、
截图和 `taskRequest` 自动执行 `wait/observe`；发现可识别的 403/429/503、节流、挑战或账号变化后，
下一动作可在派发前 cooldown 或熔断。批量专项工作仍使用 `rateControl` 的 `plan`、`observe`、
`checkpoint`、`wait`、`snapshot`、`reset` 补充 account、`Retry-After`、latency 和批次 checkpoint。
scope 至少隔离站点 origin 与 Profile/account。控制器：

- 从单并发/小批次 pilot 开始；
- 先降并发，再指数退避并加入 jitter；
- 尊重 `Retry-After`；
- 在挑战、账号变化或最低并发重复节流时打开 circuit；
- 只在连续干净批次后逐步恢复；
- 不保证绕过或避免平台限流。

checkpoint 属于调用任务；MoneyHand 不内置平台数据库或跨任务采集队列。

rate controller 的执行模型是 `task-runtime-auto-gate-plus-explicit-specialized-scheduler`。
低层 `request` 不包含可信 rate scope，因此不会被透明拦截；descriptor 同时声明
`taskRuntimeImplicitGate:true` 与 `implicitRequestGate:false`，适配器不得把它解释成全 transport gate。

## 专项 Skill 组合

专项 Skill 定义平台方法和输出，MoneyHand 定义浏览器执行。建议专项 Skill 声明：

- 所需 `npc-moneyhand-control/1` 版本；
- 所需 operation 和 Extension wire method；
- 平台 rate scope 和 stop signals；
- checkpoint/去重格式；
- effect 与调用方可选授权策略。

执行时将现有 `moneyhand` 实例传给专项任务模块，或让一个宿主 JSONL 进程执行完整工作。禁止嵌套启动第二个控制台。

## 结果未知和恢复

以下情况必须 inspect-before-retry：

- `OUTCOME_UNKNOWN`；
- `actionDispatched:true` 后 timeout/abort；
- 断线发生在动作派发后；
- postcondition 未验证；
- 下载/导航返回不完整。

保留 request ID 和 `instanceId + bootId`，检查页面、下载或业务状态。只对已核查 ID 调用 `confirmUnknown`。自动 ACK 或换新 ID 重放都可能重复副作用。

## 浏览器外边界

`routeSurface()` 只有两个结果：

- `moneyhand`：网页 DOM/CDP 或页面视觉 + CDP Input；
- `human`：浏览器 chrome、原生窗口、系统认证、CAPTCHA、桌面应用。

项目没有自动桌面后端。人处理后，Agent 必须重新观察 Profile、boot、tab、URL 和页面状态再继续。

## 完成语义

任务脚本只有返回 `status:"complete"`（或等价状态）时才强制完成门。它必须同时提供
`requirements:[{id,satisfied,expected,actual}]` 和领域 evidence。terminal envelope 在 `value`
之外返回 `taskEvidence` 与 `completionGate`；owned window 清理、最新 effect receipt、rate
circuit/checkpoint、instruction wait 或任一 requirement 未闭合都会返回
`TASK_COMPLETION_GATE_FAILED`。专项输出仍由专项 Skill 负责，私有 controller evidence 不是业务数据库。

正常 JSONL 关闭必须同时满足：

- 所有预期 result ID 已收到；
- `drain` 已完成；
- `shutdown` result 已收到；
- `moneyhand.stopped` 已收到；
- stdout 已读到 EOF。

进程退出码不能证明上层 Agent 已消费结果。ESM 模式必须在 `finally` 调用 `stop()`。

更多错误决策见 [AGENT_TROUBLESHOOTING.md](./AGENT_TROUBLESHOOTING.md)。
