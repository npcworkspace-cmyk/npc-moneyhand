# Agent / CLI 接入

`npc-moneyhand` 对外是一个 Agent Skill 和一个 Chrome Extension。Skill 是唯一官方 Agent 控制入口，正式 CLI 名称为 `moneyhand`。

## 接入条件

宿主满足以下任一方式即可：

| 宿主能力 | 模式 |
| --- | --- |
| 可导入本地 ESM | 任务内持有一个 `createMoneyHand()` |
| 可维持双向子进程 | 持久 UTF-8 JSONL |
| 只能做一个独立事务 | `--once` |
| 需要本地完成多步、减少 Agent 往返 | 可信 `--task <absolute-module.mjs>` |
| 支持 Agent Skills | 安装或链接 `skills/npc-moneyhand` |

所有模式都要求本机 Node.js 20+ 和 loopback 访问。不能在用户电脑启动进程、访问 loopback 或安装 Chrome 扩展的远程沙箱，不能直接控制用户 Profile。

## 单 controller 规则

一个 Agent 任务只创建一个 MoneyHand controller：

~~~text
task start → start listener → wait extension → run all phases → stop in finally
~~~

同一任务可以：

- 控制多个 tab；
- 接收多个 Profile 的 Extension 连接；
- 创建多个互相独立的 Task Space；
- 运行多个可信次抛模块；
- 叠加 Reddit 评论、红人开发等专项 Skill。

它们必须复用这个 controller。不要为每个点击启动 CLI，不要让专项 Skill 各开一个 listener，不要跨 Agent 任务保留进程。

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

离线发现：

~~~text
moneyhand --describe
moneyhand --version
~~~

从源码运行：

~~~text
node skills/npc-moneyhand/scripts/moneyhand.mjs --describe
~~~

机器可读入口：

- [moneyhand-contract.json](../skills/npc-moneyhand/references/moneyhand-contract.json)
- [agent-operations.json](../skills/npc-moneyhand/references/agent-operations.json)

适配器先校验 `npc-agent-cli-descriptor/1`，再用 operation catalog 构造命令。不要用可执行文件名或旧文档推断兼容。

## CLI

~~~text
moneyhand [--host <loopback>] [--port <0-65535>]
moneyhand --once [connection options]
moneyhand --task <absolute-module.mjs> [--args-json <json>]
moneyhand --describe
moneyhand --version
~~~

端口 `0` 只适用于能从 startup event 读取动态 endpoint 的测试宿主；固定配置的 Extension 使用 `1–65535`。

支持的环境变量：

~~~text
NPC_MONEYHAND_HOST
NPC_MONEYHAND_PORT
NPC_MONEYHAND_PAIRING_TOKEN
NPC_MONEYHAND_CONNECT_TIMEOUT_MS
NPC_MONEYHAND_REQUEST_TIMEOUT_MS
NPC_MONEYHAND_HEARTBEAT_MS
NPC_MONEYHAND_HANDSHAKE_TIMEOUT_MS
NPC_MONEYHAND_MAX_INFLIGHT
NPC_MONEYHAND_ONCE_TIMEOUT_MS
NPC_MONEYHAND_OUTPUT_DRAIN_TIMEOUT_MS
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

const moneyhand = createMoneyHand({ host: "127.0.0.1", port: 19846 });
~~~

关键分层：

- `moneyhand.start/wait/stop`：生命周期；
- `moneyhand.request`：直接 Extension wire 请求；
- `createTaskSpace` / `taskRequest`：固定 Profile/tab 并声明 effect；
- `navigateTaskTab` / `waitForTaskPage`：无盲 sleep 的页面 transition；
- semantic snapshot/locator/ref API：有界观察和受守卫动作；
- `rateControl` 或 `createRateController`：pilot、退避、cooldown 和 circuit；
- `routeSurface`：只做 `moneyhand | human` 路由，不产生输入。

具体签名以 descriptor/catalog 和 Skill references 为准。

## 可信任务模块

复制 [disposable-task.mjs](../skills/npc-moneyhand/assets/disposable-task.mjs) 到任务自己的临时或工作目录：

~~~js
export async function run({ moneyhand, signal, args }) {
  return await moneyhand.request(
    { method: "system.status", params: {} },
    { signal }
  );
}
~~~

执行：

~~~text
moneyhand --task "C:\absolute\task.mjs" --args-json "{\"job\":\"status\"}"
~~~

CLI 拥有 start/wait/stop；模块只拥有任务逻辑。任务模块是可信本地 Node 代码，不是沙箱：不得从网页内容、评论或模型不可审计输出直接生成并执行。

## Profile 与 Task Space

多个 Profile 可以连接同一端口，不需要人工别名。默认路由依次使用：

1. 当前 focused session；
2. 持久化的最后焦点时间；
3. 稳定 session 顺序。

独立读取可使用默认路由。依赖页面状态的工作必须创建 Task Space，固定 `instanceId + bootId` 和必要 tab ID。Extension reload、Chrome restart、Profile 替换或明确 handoff 后重新绑定。

每个请求声明 effect，例如 `read-only`、`navigation`、`input`、`download`、`upload`、`send`、`publish`。同一账号的写操作串行执行。

## 高影响操作

`delete`、`payment`、`publish`、`send`、`upload` 和 `external-write` 需要近期、明确、来自用户的确认。审批令牌绑定：

- Task Space；
- effect；
- 精确 request 或 semantic ref/action；
- 短 TTL；
- 一次消费。

低层 `request` 是可信开发者逃生口，不会理解业务含义；集成方不能用它绕过用户确认。

## 行为与 rate controller

`raw` 是默认行为。`human` 只能由 Agent 或专项 Skill 显式设置，并在阶段结束 reset。它不承担限流判断。

批量工作使用 `rateControl` 的 `plan`、`observe`、`checkpoint`、`wait`、`snapshot`、`reset` 动作。scope 至少隔离站点 origin 与 Profile/account。控制器：

- 从单并发/小批次 pilot 开始；
- 先降并发，再指数退避并加入 jitter；
- 尊重 `Retry-After`；
- 在挑战、账号变化或最低并发重复节流时打开 circuit；
- 只在连续干净批次后逐步恢复；
- 不保证绕过或避免平台限流。

checkpoint 属于调用任务；MoneyHand 不内置平台数据库或跨任务采集队列。

rate controller 的执行模型是 `explicit-caller-scheduler`。低层 `request` 不包含可信 rate scope，
因此不会被透明拦截；集成方负责在每个受控批次前消费 decision，并在批次后 observe。descriptor
同时声明 `implicitRequestGate:false`，适配器不得把它解释成自动 transport gate。

## 专项 Skill 组合

专项 Skill 定义平台方法和输出，MoneyHand 定义浏览器执行。建议专项 Skill 声明：

- 所需 `npc-moneyhand-control/1` 版本；
- 所需 operation 和 Extension wire method；
- 平台 rate scope 和 stop signals；
- checkpoint/去重格式；
- effect 与审批要求。

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

正常 JSONL 关闭必须同时满足：

- 所有预期 result ID 已收到；
- `drain` 已完成；
- `shutdown` result 已收到；
- `moneyhand.stopped` 已收到；
- stdout 已读到 EOF。

进程退出码不能证明上层 Agent 已消费结果。ESM 模式必须在 `finally` 调用 `stop()`。

更多错误决策见 [AGENT_TROUBLESHOOTING.md](./AGENT_TROUBLESHOOTING.md)。
