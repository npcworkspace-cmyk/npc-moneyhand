# 性能原则

MoneyHand 的目标是降低 Agent 到真实 Chrome 的总任务时间，而不是追求单个“点击每秒”数字。默认 raw、一个任务期 controller、结构化数据优先和有界批处理是主要性能策略。

## 热路径

~~~text
Agent /专项 Skill
  → one in-process controller or persistent JSONL
  → one loopback WebSocket
  → Extension queue
  → CDP / Chrome API / CDP Input
~~~

正常请求不会启动新进程、加载模型或调用外部服务。Skill 和 Extension 都没有第三方 runtime package。

## 选择最快合格数据面

未指定方法时按顺序选择：

1. 任务已有结构化数据；
2. CDP Network JSON 或明确只读的同会话请求；
3. CDP Runtime/DOM 批量读取；
4. 只为懒加载、分页或浏览器状态使用 UI；
5. 文本不足后才显式截图。

这条顺序受授权、账号状态和目标完整性约束。可见接口不自动等于允许重放的接口。

## 保持一个 controller

错误模式：

~~~text
每个动作 → 新进程 → 新 listener → 新握手 → 新 debugger session
~~~

推荐模式：

~~~text
一个 Agent 任务
  → start once
  → wait once
  → reuse for all tabs/phases/specific Skills
  → stop once
~~~

`--once` 只用于一个独立事务。多步工作使用 ESM、持久 JSONL 或一个可信 `--task` 模块。

## 减少往返

- 使用 `batch.run` 将同一目标最多 200 个顺序步骤放在一次 wire 请求中；
- 使用可信 task module 在本地完成循环、分页和等待；
- 用 `navigateTaskTab` / `waitForTaskPage` 取代模型轮询和固定 sleep；
- 先做有界语义快照，不默认传整棵 DOM；
- 只有 iframe/OOPIF 任务才启用 frame-aware 观察；
- 大结果写到受控本地 artifact，只在 JSONL 返回元数据和路径引用。

批处理可直接执行账号动作，不受 MoneyHand 二次审批门禁。调用方仍应正确标记 effect，并在启用 rate-control 时处理 unknown-outcome 与限流状态。

这里的 rate-control 约束由调用批处理的 Agent/专项 Skill 显式执行；低层 `request()` 不会自动
推导 scope 或拦截请求。性能测试必须记录是否所有受控批次都经过 plan/decision/observe。

## raw、human 与 rate

`raw` 没有人为延迟，是默认快速路径。`human` 有意增加指针步骤、逐字输入和停顿，只在 Agent/专项 Skill 明确要求的阶段使用。

rate controller 的 `plan/observe/checkpoint` 是本地有界状态计算；它不会增加网络调用。真正增加的间隔来自站点反馈后的保护性退避。性能目标是“最快安全完成”，不是在 429、挑战页或账号变化后继续保持吞吐。

## 并发

- 同一 tab/target FIFO；
- 不同 tab/target 可以并行；
- 同一账号的写操作串行；
- Task Space 防止并发任务因焦点变化串 Profile；
- rate controller 给出站点 scope 的 concurrency 上限；
- 未知结果、队列和 WS 缓冲都有硬上限。

并发越大不一定越快。pilot 应从最小并发开始，用真实 latency/throttle 信号逐步提升。

## 语义层成本

语义动作比 raw CDP 多做以下工作：

- AX/可选 DOMSnapshot；
- 稳定样本等待；
- Profile/frame/viewport 复查；
- hit-test、遮挡与 enabled 检查；
- 声明式 postcondition。

对需要稳定定位或账号写入的任务，这些检查是必要成本。对已知只读结构化路径，直接 raw/batch 更快。

## 截图成本

截图需要编码、传输和可能的像素到 CSS 坐标换算。默认不用截图；`observe.context` 先返回有界文本。full-page screenshot 不可直接用于 viewport input。

## 本地基准

~~~text
npm run bench:control
~~~

输出 `npc-control-benchmark/1` JSON，包括：

- Node/OS/arch；
- Extension 与 Skill 文件字节；
- 外部 runtime package 数；
- listener start/stop；
- 100,000 次本地 status；
- 100,000 次纯 `routeSurface` 决策。

这是控制面微基准，不包含 Chrome、网页、网络、模型和站点 rate limit。不要把它外推为抓取吞吐。

## 应记录的真实任务指标

- controller start → Extension ready；
- request p50/p95/p99；
- 每个数据面的命中率；
- model/CLI/wire 往返次数；
- batch 大小和失败位置；
- queue/inflight 峰值；
- `droppedEvents`；
- pilot concurrency、interval、backoff/cooldown/circuit 次数；
- checkpoint 恢复耗时；
- unknown outcome 数量；
- 实际完成项、去重后项和未覆盖项。

测试环境、Profile、目标站点和时间窗口必须随结果保存。没有这些上下文的单个延迟数字不可比较。

## 回归门禁

- `npm run check`：结构、契约、边界和 Node tests；
- `npm run bench:control`：控制面和 artifact 大小快照；
- `npm run accept:agents:packaged`：安装后 CLI/descriptor 生命周期；
- isolated Chrome：受控一次性 Profile；
- [真实 Chrome 验收](./REAL_CHROME_TEST.md)：用户当前 Profile；
- 长时间站点任务：单独记录授权、rate scope 和覆盖率。

这些门禁互不替代。
