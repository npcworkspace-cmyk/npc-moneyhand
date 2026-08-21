# 故障处理

首次安装和连接不要从本页自由排查。进入已经安装的基础 Skill 目录，只执行一次：

~~~text
node scripts/moneyhand.mjs --connect
~~~

只读取 id 为 `connect` 的 `npc-moneyhand-connect/1` 结果并执行 `nextAction`。外层
`ok: true` 只表示命令返回了有界结果；只有 `value.connected: true` 且
`value.status: connected` 才表示已连接。

| 结果 | 唯一处理 |
| --- | --- |
| `connected` / `ready_for_tasks` | 内置全功能验收和清理已通过；转述 `userMessage`。当前对话已有明确任务就直接执行，否则询问任务并等待。 |
| `install_extension` | 转述 `userMessage`，等待用户完成安装、打开浏览器并点击“立即连接”。 |
| `open_browser_and_click_extension` | 转述 `userMessage`，等待用户打开浏览器并点击“立即连接”。 |
| `blocked` | 转述 `userMessage` 并停止。 |

用户完成任一人工动作后，只运行结果中返回的同一个 `retryCommand` 一次：

~~~text
node scripts/moneyhand.mjs --connect --after-user-action
~~~

第二次仍未连接就停止。不要扫描端口、查看 Service Worker、读源码、执行 `--describe`、运行
项目测试、修改 Profile、重写 controller、切换 Playwright 或继续猜测原因。宿主不能运行本地
Node.js 20+ 时，报告前置条件并停止。

## `CONNECT_ACCEPTANCE_FAILED`

连接已经建立，但独占 localhost 测试窗口中的 15 项能力或清理至少一项未通过，因此结果不会
冒充 `ready_for_tasks`。转述 `userMessage` 和返回的失败项并停止；测试窗口已经过有界清理。
不要访问外部测试网站、补写 MJS、手工重跑单项或切换控制工具。维护者应在开发环境复现并修复，
普通新 Agent 不做发散式排障。

## `CONTROLLER_BUSY`

内置 controller 会串行处理本机 MoneyHand 任务；正常的 `--connect`、`--call`、`--task`
都应复用同一个进程。若返回占用错误，转述 `userMessage` 并停止。不要换端口、结束未知
进程或启动第二个 listener。

以下各节只供已经连接并收到明确用户任务后的执行或适配器开发使用，不属于首次连接流程。

## 已连接但控制的是另一个 Profile

独立请求默认选择最近焦点 Chrome session。多步任务必须：

1. 让目标 Chromium Profile 的任意窗口获得焦点；
2. 调用一次 `beginTaskContext()`；
3. 使用它自动创建的任务窗口和 Task Space；
4. 后续全部操作使用返回的 `taskSpaceId` / `tabId`。

焦点只用于任务开始时选择 Profile；中途切焦点不会改变已固定 Space。结束时
`completeTaskContext()` 只关闭 MoneyHand 创建的任务窗口。Extension reload 或 Chrome restart
会改变 `bootId`，需要重新创建。

如果创建已确认、但首次页面验证失败，MoneyHand 会重新读取该 `windowId`，且只有窗口仍是
normal、单 tab、同 ID、同 `about:blank` marker 时才补偿关闭。用户改过 tab/marker 会返回
`TASK_WINDOW_OWNERSHIP_CHANGED` 并保留窗口；创建结果未知且没有已确认 ID 时绝不猜测关闭。
最终 orphan sweep 同样要求 marker 完全匹配，不会按 window ID 直接关闭。

若固定连接流程由 MoneyHand 自动打开 Chromium，它会另外记录唯一引导标签，并在任务后仅
移除 ID 与 `about:blank` marker 均未变化的该标签；若它是最后一个标签，启动窗口随之关闭。
用户修改过的标签和其他已有标签/窗口都会保留；不要自行枚举或批量关闭窗口。

## `moneyhand.listening` 后没有 stdout 结果

- 从进程启动起持续 drain stdout；
- 每条 stdin 必须是一行完整 UTF-8 JSON；
- `id` 在生命周期内唯一；
- 参数只放 `args`；
- 一行不得超过 1 MiB；
- 活动命令不超过 256；
- 结果可能乱序，按 ID 关联。

Windows stdout pipe 可能产生背压。控制台的有界输出辅助进程随调用回收；它不是内置
controller。调用方不读取 stdout 时仍会有界失败。

## ESM import 失败

从源码使用：

~~~js
import { createMoneyHand } from "./skills/npc-moneyhand/scripts/moneyhand.mjs";
~~~

从已安装 package 使用它公布的 `npc-moneyhand` export。确认 Node.js 20+、文件是 ESM，并避免同时导入仓库旧路径。以 `--describe` 的 executable/package 为准。

## 扩展返回 `needs_instruction`

页面出现不明确状态后，Extension 会：

1. 返回有界 `observe.context`；
2. 标记页面内容不可信；
3. 暂停该 tab 的写操作；
4. 等待 Agent 新指令。

在正常 `--task` 路径中，基础 runtime 会自动调用只读截图并返回
`visualFallback.screenshot.path`；Agent 应直接打开这张本地图片，不要先重复截图。决定继续或取消后只调用
`resolveTaskBlocker({taskSpaceId,action:"resume"|"cancel"})`，不要查找底层 `waitId` 或 `tabId`。
低层 Extension 本身仍不会自主截图；自动策略属于基础 Skill/controller。

## 后台 MJS 长时间没有进度

正常任务必须持续输出 `moneyhand.task_progress`：启动时立即一条，随后至少每 10 秒一条。专用任务还应在
每个批次或 checkpoint 调用注入的 `progress({phase,message,current,total,checkpoint})`。监控在任务
模块导入前启动，任务和适配器只能缩短、不能放宽 10 秒/15 秒阈值。

连续 15 秒没有新的任务/浏览器活动时，watchdog 会自动抓取当前视口并以
`state:"visual_fallback"` 返回本地 PNG 路径；持续沉默会有界重复，整个任务最多 120 次，可覆盖默认
30 分钟任务预算内的连续 15 秒静默。若同步代码阻塞控制器，前台 CLI 会输出
`moneyhand.task_monitor`；控制器恢复后在清理任务窗口前补截图。截图不重放正在等待的动作，也不延长
30 分钟总 deadline。若控制台既无 progress/monitor 也无 terminal，应将其视为输出链或进程故障，
不要再静默启动第二份 MJS/controller。

## `OUTCOME_UNKNOWN`、超时或断线

只要动作可能已派发，就不要重试：

1. 保存 request ID 和 `instanceId + bootId`；
2. 检查当前页面、下载历史或业务系统；
3. 判断动作已完成、未完成或仍不确定；
4. 仅对已核查 ID 调用 `confirmUnknown`；
5. 需要新动作时使用新 ID。

`actionDispatched:false` 或明确 `ABORTED_NOT_STARTED` 才可能允许修正后重试。postcondition 失败不等于动作没发生。

`TASK_TIMEOUT` 也不是“动作都没发生”。检查 `taskAcknowledgedAbort`、`cleanupComplete`、
`controllerReusable`、`taskWindowCleanup` 和业务 checkpoint；只有完成这些检查后才能决定是否
启动新任务。`controllerReusable:false` 时不要继续向旧 controller 排队。

## `BUSY`、旧 ref 或 locator 歧义

- `BUSY`：等冲突工作完成，不要并行操作同一 tab/窗口；
- stale boot/ref/snapshot：重新观察和绑定；
- locator missing/not-ready：有界等待；
- locator 多匹配：缩小 role/name/CSS，不按数组下标猜；
- viewport/frame 变化：重新捕获和换算。

输入前 fail closed 是可修正错误；输入后不明确仍按结果未知处理。

## 429、503、`Retry-After` 或挑战页

不要直接切到 human 继续翻页。把观察交给 `rateControl`：

1. checkpoint 当前页、游标和去重集合；
2. 先降低并发；
3. 按返回间隔 + jitter 等待；
4. 尊重 `Retry-After`；
5. 用更小批次验证恢复；
6. 最低并发仍重复节流、出现挑战或账号状态变化时打开 circuit 并停止。

human 模式只改变输入节奏。rate controller 不保证绕过限制，也不承诺账号安全。

## rate circuit 已打开

记录 snapshot/checkpoint 和 stop reason。只有在外部状态改变、冷却结束且 Agent/用户确认继续时，才以新的小 pilot 重建或 reset scope。不要在原 circuit 上循环 `wait` 试图自动穿透挑战。

## human 模式没有“更像人”

确认 `behavior.set` terminal 为成功、TTL 未过期，且操作使用 `input.perform` 支持的动作。raw CDP 脚本读取不会因为 human 模式自动变慢。

阶段结束调用 `behavior.reset`。human 行为是可调输入策略，不是反检测承诺。

## 截图点击偏移

若 `captureStableViewport()` 抛出 `VIEWPORT_CAPTURE_FAILED`，说明捕获 terminal 明确失败且
没有写出目标文件；按 `retry:"safe-to-recheck"` 重新检查页面状态，再决定是否做一次新的捕获。
`VIEWPORT_NOT_STABLE` 或 `FULL_PAGE_NOT_STABLE` 表示页面守卫持续变化，不要拿旧图片做输入。
只有 `stable:true` 的 viewport 结果可用于坐标映射；full-page 结果始终
`observationOnly:true`、`coordinateMapping:false`。

`input.perform` 坐标是顶层当前 viewport 的 `css-viewport-v1`。重新获取 viewport bundle，确认：

- 页面、URL、loader、viewport、DPR/zoom 没变；
- 使用 viewport screenshot，而不是 full-page image；
- 图片像素已换算成 CSS 像素；
- iframe/OOPIF 坐标已换算到顶层 viewport；
- 目标未滚动、缩放或被遮挡。

不要 clamp 猜测，也不要把这些坐标用于浏览器工具栏或系统窗口。

## 原生对话框、权限提示或桌面应用无法操作

这是设计边界，不是连接故障。`routeSurface` 应返回 `human`。让用户处理，随后重新观察 Profile、boot、tab、URL 和页面状态。

## 正常停止但结果缺失

退出码 `0` 只表示进程写出字节。有限运行必须确认：

- 全部预期 result ID；
- `drain` result；
- `shutdown` result；
- `moneyhand.stopped`；
- stdout EOF。

缺少任一项都不能声称 Agent 已消费全部结果。

维护者的真实 Profile 验收另见 [REAL_CHROME_TEST.md](./REAL_CHROME_TEST.md)，不能作为 Agent
首次连接失败时的替代路径。
