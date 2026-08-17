# 故障处理

先记录四项：`moneyhand --describe`、`moneyhand.listening`、Extension 弹窗地址/端口、`chrome://extensions` 中的版本与错误。不要先重装或盲重放动作。

## 保存后没有连接

检查：

1. 控制台是否已经输出 `moneyhand.listening`；
2. host/port 是否与弹窗完全一致；
3. Extension 路径是否是 `/extension`（弹窗自动添加）；
4. Chrome 和 Extension 是否启用；
5. 是否有另一个进程占用端口；
6. `127.0.0.1` 与 `::1` 是否混用；
7. Extension Service Worker 控制台是否有握手或 Origin 错误。

启动探针：

~~~text
node skills/npc-moneyhand/scripts/moneyhand.mjs --host 127.0.0.1 --port 19846
~~~

Extension 是主动连接方。活跃 worker 通常在短退避后重试，休眠 worker 依靠持久 alarm。Chrome 已关闭、扩展禁用或电脑休眠时，端口不能把它唤醒。

## 卡在 CONNECTING

常见原因：

- listener 未启动或 host/port 不匹配；
- 本机防火墙/安全软件拦截 Node loopback；
- Upgrade 不是精确 `/extension`；
- 端口对应另一个服务；
- 配对 token 与 Extension 预置 token 不一致；
- Skill/Extension wire 版本不同。

不要把 listener 改成 `0.0.0.0`。MoneyHand 有意只允许 loopback。

## 地址已被占用

一个端口只能由一个 Agent 任务拥有。结束旧 controller 并确认其 stdout EOF，再重启当前任务。不要让专项 Skill 单独再开 listener。

若不确定旧进程是否仍在处理写动作，先检查页面/业务状态；强制结束进程不会证明动作未执行。

## 已连接但控制的是另一个 Profile

独立请求默认选择最近焦点 Chrome session。多步任务必须：

1. 让目标 Chrome 窗口获得焦点；
2. `wait/status` 确认 session；
3. 创建 Task Space；
4. 后续全部操作使用该 Space。

中途切焦点不会改变已固定 Space。Extension reload 或 Chrome restart 会改变 `bootId`，需要重新创建。

## `moneyhand.listening` 后没有 stdout 结果

- 从进程启动起持续 drain stdout；
- 每条 stdin 必须是一行完整 UTF-8 JSON；
- `id` 在生命周期内唯一；
- 参数只放 `args`；
- 一行不得超过 1 MiB；
- 活动命令不超过 256；
- 结果可能乱序，按 ID 关联。

Windows stdout pipe 可能产生背压。控制台的有界输出辅助进程随任务回收，不是 daemon；调用方不读取 stdout 时仍会有界失败。

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

Agent 应检查文字，必要时显式调用 `observe.screenshot`，再通过 `instruction.resolve` 结束等待。截图不会自动触发。

## `OUTCOME_UNKNOWN`、超时或断线

只要动作可能已派发，就不要重试：

1. 保存 request ID 和 `instanceId + bootId`；
2. 检查当前页面、下载历史或业务系统；
3. 判断动作已完成、未完成或仍不确定；
4. 仅对已核查 ID 调用 `confirmUnknown`；
5. 需要新动作时使用新 ID。

`actionDispatched:false` 或明确 `ABORTED_NOT_STARTED` 才可能允许修正后重试。postcondition 失败不等于动作没发生。

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

## 最小诊断命令

~~~text
node --version
node skills/npc-moneyhand/scripts/moneyhand.mjs --version
node skills/npc-moneyhand/scripts/moneyhand.mjs --describe
npm run check
~~~

涉及真实 Profile 再按 [REAL_CHROME_TEST.md](./REAL_CHROME_TEST.md) 分层验证。不要用本地单元测试替代用户当前 Chrome 证据。
