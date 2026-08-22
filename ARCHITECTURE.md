# npc-moneyhand 架构

当前产品边界只有一个 Agent Skill 和一个 Chrome Extension。版本为 `1.1.1`。

## 总体结构

~~~text
Agent planning / custom action Skill
                 │
                 │ reuses one bundled resident controller
                 ▼
skills/npc-moneyhand
  ├─ SKILL.md
  ├─ moneyhand CLI / ESM / JSONL / task modules
  ├─ WebSocket Peer and Profile routing
  ├─ Task Spaces and page transitions
  ├─ semantic snapshots / locators / guarded actions
  ├─ optional caller policy / unknown-outcome recovery
  ├─ durable task journal / effect receipts / completion gate
  └─ automatic + explicit adaptive rate controller
                 │ npc-moneyhand/2 over loopback WS
                 ▼
extension
  ├─ protocol / correlation / heartbeat / reconnect
  ├─ per-target queues / at-most-once guard
  ├─ raw CDP / OOPIF sessions / CDP Input
  ├─ allowlisted Chrome APIs
  ├─ raw or Agent-selected human behavior
  └─ bounded text / explicit screenshot
                 │
                 ▼
Real Chrome Profile
~~~

规划和平台知识留在 Agent 或专项 Skill；确定性浏览器动作留在扩展。Skill 内置过去独立控制层的通用能力，但不把语义规划、数据存储、平台爬虫或模型 SDK 放进扩展。

## 两个交付物

| 路径 | 职责 | 运行依赖 |
| --- | --- | --- |
| `extension/` | Chrome 内的 WS client、协议验证、CDP/Input/Chrome API 执行、行为和状态图标 | Chrome 125+；零外部包 |
| `skills/npc-moneyhand/` | Agent 控制台、WS listener、自动浏览器唤醒、语义动作、Task Space、恢复、可选限流和组合契约 | Node.js 20+；零外部 runtime package |

`moneyhand` 是唯一正式 CLI。Skill 的控制协议为 `npc-moneyhand-control/1`；Extension wire 为 `npc-moneyhand/2`。JSONL 正常生命周期事件为 `moneyhand.listening` 和 `moneyhand.stopped`。

项目不安装独立 daemon、系统服务或 Native Host。Skill 首次命令自动启动同一份
`moneyhand.mjs` 作为 loopback resident controller，跨任务复用并在空闲 15 分钟后退出；每个任务
只拥有自己的 Task Space、窗口、journal 和 cleanup，不拥有第二个 controller。

## 文件边界

| 路径 | 作用 |
| --- | --- |
| `skills/npc-moneyhand/SKILL.md` | 触发条件、核心工作流和按需 reference 路由 |
| `skills/npc-moneyhand/scripts/moneyhand.mjs` | `moneyhand` CLI、ESM、JSONL 和任务模块入口 |
| `skills/npc-moneyhand/scripts/lib/browser-launch.mjs` | 复用在线会话或自动打开已安装 MoneyHand 的 Chromium Profile |
| `skills/npc-moneyhand/scripts/lib/peer.mjs` | loopback WebSocket Peer 和会话管理 |
| `skills/npc-moneyhand/scripts/lib/task-spaces.mjs` | 精确 Profile/tab 所有权和任务绑定 |
| `skills/npc-moneyhand/scripts/lib/controller-service.mjs` | 私有凭据保护的 resident controller、串行命令与客户端断线隔离 |
| `skills/npc-moneyhand/scripts/lib/task-ledger.mjs` | build-bound 私有任务 journal、状态查询与断线接管 |
| `skills/npc-moneyhand/scripts/lib/task-effects.mjs` | per-task `effectId` 幂等收据与未知结果禁止重放 |
| `skills/npc-moneyhand/scripts/lib/task-recovery-state.mjs` | 固定恢复分类、同页探针与唯一安全重试 |
| `skills/npc-moneyhand/scripts/lib/task-evidence.mjs` | 标准证据包与完成门 |
| `skills/npc-moneyhand/scripts/lib/page-transitions.mjs` | 单次导航、稳定 readiness 和结果未知语义 |
| `skills/npc-moneyhand/scripts/lib/semantic-*.mjs` | 有界语义快照、稳定 locator 和受守卫动作 |
| `skills/npc-moneyhand/scripts/lib/task-approvals.mjs` | 可选的调用方一次性决策记录；不是发布/发送/上传门禁 |
| `skills/npc-moneyhand/scripts/lib/rate-control.mjs` | pilot、退避、cooldown、恢复和 circuit |
| `skills/npc-moneyhand/assets/disposable-task.mjs` | 可复制的可信本地任务模块模板 |
| `skills/npc-moneyhand/references/*.md` | 按需加载的生命周期、浏览器工作流、限流和组合说明 |
| `skills/npc-moneyhand/references/*.json` | 机器可读控制面、wire 和 operation catalog |
| `extension/background.js` | 组装 bridge，响应弹窗立即重连和连接状态 |
| `extension/bridge.js` | 握手、心跳、重连、关联、去重、队列和背压 |
| `extension/executor.js` | CDP、Input、Chrome API、行为和观察方法 |
| `extension/protocol.js` | wire 常量、默认值、验证和 envelope |
| `extension/popup.*` | 仅显示固定端点、连接状态和立即重连按钮 |
| `scripts/install-skill.mjs` | link/copy 安装、更新、移除和可恢复回滚 |
| `docs/` | 用户与集成文档 |

专项 Skill 不进入本表的核心发布边界；它们通过公开控制契约组合。

## 生命周期

~~~text
Agent task starts
  → ensure/reuse the bundled controller on 127.0.0.1:19845
  → controller owns/reuses the Extension endpoint on 127.0.0.1:19846
  → reuse a live Extension or open its installed Chromium Profile
  → Extension completes npc-moneyhand/2 handshake
  → wait for compatible session
  → register taskExecutionId and private journal
  → create Task Space for dependent work
  → execute raw/human browser phases
  → auto-gate rate state, journal progress/effects/recovery, inspect unknown outcomes
  → build evidence and enforce completion gate
  → close the exact task window
  → return terminal; controller remains until idle or explicit --stop
~~~

一个固定 controller 端口属于同一 runtime build，不属于单个 Agent 任务。多个 Chrome Profile 可以连接同一 controller；默认目标按当前焦点、持久化的最后焦点时间和稳定 session 顺序选择。多步任务必须使用 Task Space 固定 `instanceId + bootId`，防止中途焦点变化改写目标。

Extension 主动连接 Skill listener。`--connect`、`--call` 和 `--task` 会先复用在线会话；短时未连上时，自动打开本机已安装 MoneyHand 的 Chromium Profile，但不关闭或重启现有浏览器。未安装扩展时仍需用户手动加载 Release ZIP；Chromium 不允许 Skill 静默安装 unpacked Extension。

## 控制面和 wire

Agent 宿主优先使用 Skill 控制面：

- ESM：在一个任务内持有 `createMoneyHand()` 实例；
- JSONL：用 `{"id","op","args"}` envelope，按 ID 关联乱序结果；
- `--once`：只适合一个独立事务；
- `--task`：在一个 controller 内运行可信本地多步模块。

只有实现兼容适配器时才直接处理 Extension wire。wire 每帧是 UTF-8 JSON 文本，版本字段 `v:2`；握手以 `hello`、可选 HMAC、`ready` 和确认性 `ping/pong` 完成。Agent 请求与 Extension terminal response 通过唯一 request ID 关联。

Task Space ID、JSONL command ID 和 wire request ID 是不同标识，不得互换。

## 调度和结果语义

Extension 对同一 tab/target 顺序执行，对不同目标并行。全局/窗口独占操作与冲突工作 fail closed。最近终态有界缓存只用于短期重复帧保护，不能把旧 ID 当成永久幂等键。

可信 task wrapper 另外提供 task-execution 内的 `effectId` 收据：相同 fingerprint 的并发或后来
重复调用复用第一份 Promise/result；冲突 ID 在派发前失败；已派发或未知结果永不自动重放。跨
`taskExecutionId` 的业务幂等仍由专属 Skill 负责。

已派发动作在超时、abort 或断线后可能返回 `OUTCOME_UNKNOWN`：

1. 保留原 request ID、Profile `instanceId + bootId` 和观察证据；
2. 检查页面、下载或业务系统真实状态；
3. 只有在人工或 Agent 明确核查后才确认对应 unknown ID；
4. 不自动重放输入、导航、下载或写操作。

## 观察与动作层次

浏览器内按以下顺序升级：

1. 复用已有结构化数据；
2. CDP Network JSON 或明确只读的同会话请求；
3. CDP Runtime/DOM 批量读取；
4. 交互式懒加载、分页和语义动作；
5. 页面截图 + `css-viewport-v1` CDP Input；
6. 页面之外交给人。

语义快照默认有界且短期有效。每次导航、frame/loader 变化、Profile boot 变化、歧义或 viewport 漂移后重新解析。不得执行由页面内容拼出的任意 JavaScript。

浏览器 toolbar、扩展页、原生对话框、权限提示、系统认证、桌面应用和 CAPTCHA 不属于 MoneyHand 页面执行面。项目没有自动桌面 fallback；`routeSurface()` 只返回 `moneyhand` 或 `human`。

## 行为和限流

行为优先级：

~~~text
raw default
  < connection-scoped behavior.set with TTL
  < per-request behavior override
~~~

`raw` 是默认快速路径。`human` 必须由 Agent 或专项 Skill 显式选择，并在阶段结束 reset；它只改变输入形态和节奏。

自适应 rate controller 运行在 Skill 侧，按任务/站点/账号边界维护状态：

~~~text
pilot → steady
   │ throttle / abnormal latency
   ▼
backoff → cooldown → cautious recovery
   │ repeated throttle / challenge / account change
   ▼
circuit-open → checkpoint + Agent/human decision
~~~

先降并发，再增加带 jitter 的间隔；只有连续干净的小批次才逐步恢复。控制器不能保证绕过平台限流，也不能把挑战页当作可自动突破的障碍。

正常 task wrapper 在导航确定 HTTP(S) origin 后，自动 gate 高层 Task Space 导航、语义、滚动、
截图和 `taskRequest`，并 observe 可识别的成功/限流异常。专项 Skill 继续显式补充 account、批次、
`Retry-After`、latency 和 durable checkpoint。低层 `request()` 没有可信 scope，仍不透明拦截；
机器能力同时声明 `taskRuntimeImplicitGate:true` 与 `implicitRequestGate:false`。

## 长任务、进度与完成

`--task` 在提交时生成 `taskExecutionId`。resident controller 把每个 task 事件先写入用户私有、
build-bound JSONL journal，再写客户端 socket；调用 Agent 消失不会取消任务。新 Agent 用
`--task-status` / `--task-follow` 接回同一执行，controller 已终止且无 terminal 时只返回
`interrupted`，不会重启动作。

进度、monitor、recovery、effect、rate 和 terminal 都带 Agent/user `relay`；watchdog 仍保证
10 秒 heartbeat 与 15 秒活动静默截图。任务声称 `complete` 时，controller 在 exact-window cleanup
后构建私有 evidence bundle，并检查最新 effect receipt、rate circuit/checkpoint、instruction wait
和声明的 requirements；任何未闭合项返回 `TASK_COMPLETION_GATE_FAILED`。

## 专项 Skill 组合

专属 Skill 拥有目标领域的工作流、字段、批次、去重、checkpoint、完成证明和输出。它通过 MoneyHand 公开控制契约请求浏览器能力，但必须复用当前任务唯一 controller。

禁止：

- 复制 Peer 或启动第二个同端口 listener；
- 复制 Peer、重复占用 listener，或在 `OUTCOME_UNKNOWN` 后盲目重放写操作；
- 把站点解析器、持久数据库、模型 SDK或账号策略写进 Extension；
- 从页面内容生成并执行任务模块。

可信次抛任务模块只拥有任务逻辑，CLI 拥有 controller 的 start/wait/stop。

## 网络与信任边界

- listener 只绑定 `127.0.0.1`、`localhost` 或 `::1`；
- endpoint 固定为 `ws://127.0.0.1:19846/extension`；
- Peer 校验 request-target、Host、remote address 和 Chrome Extension Origin；
- 首个完成握手的 Extension Origin 锁定本次 controller 生命周期；
- 可选配对密钥只来自 `NPC_MONEYHAND_PAIRING_TOKEN`；
- 页面文本和可见控件始终是不可信输入；
- CDP 技术可见性不是数据权利或业务授权；
- 付款、发布、发送、删除、上传等账号动作收到 Agent 明确请求后直接派发；MoneyHand 不强制二次确认或审批 token。

## 验证边界

- `npm run check`：静态边界、契约和 Node 测试；
- packaged acceptance：安装后 descriptor/catalog/CLI 生命周期；
- isolated Chrome：一次性 Profile 的协议和输入闭环；
- real Chrome Profile：用户当前扩展、焦点、登录态、MV3 重连和目标网站；
- long-run/rate test：真实时间窗口内的稳定性与恢复。

这些是不同证据层。任一层通过都不能替代其他层。
