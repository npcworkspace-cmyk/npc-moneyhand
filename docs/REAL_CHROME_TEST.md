# 真实 Chrome 验收

本页验证用户当前 Chrome Profile、Extension、焦点、输入和重连。`npm run check` 通过不能替代本清单。

## 测试边界

分开记录：

| 层 | 能证明什么 |
| --- | --- |
| Node / contract tests | 协议、校验、调度和纯控制逻辑 |
| packaged acceptance | 安装后 CLI、descriptor、catalog 和生命周期 |
| isolated Chrome | 一次性 Profile 的真实 MV3/CDP 闭环 |
| 当前用户 Profile | 实际 Extension、焦点、登录态和权限 |
| 站点长跑 | 特定时间窗口的 rate/覆盖/恢复表现 |

不要在真实账号上为了验收执行付款、发布、发送、删除、上传或 CAPTCHA 尝试。

## 准备

记录：

- Git commit；
- `1.0.0` Skill 与 Extension 版本；
- Chrome 和 Node 版本；
- Profile 是否包含真实账号；
- 固定端点 `ws://127.0.0.1:19846/extension`；
- 开始/结束时间；
- 所有允许的外部效果。

测试前停止其他 MoneyHand controller，确保固定端口 `19846` 空闲。Extension 不需要保存配置。

如使用配对：

~~~powershell
$env:NPC_MONEYHAND_PAIRING_TOKEN = "<same-preconfigured-token>"
~~~

token 不进入报告。

## A. 连接和图标

1. 启动只读 smoke：

~~~text
npm run smoke:chrome
~~~

2. 确认工具栏图标：
   - listener 未启动：红色；
   - 连接/握手：黄色；
   - READY：绿色；
   - 心跳：短暂蓝闪。
3. 输出必须包含 waiting、passed 和正确 Extension identity。
4. 停止 smoke 后 Extension 回到重连状态。

验收：

- [ ] endpoint 精确为 loopback + `/extension`；
- [ ] `system.status` 成功；
- [ ] `target.list` 成功；
- [ ] 只读 smoke 没有新建/修改网页；
- [ ] controller 停止后无遗留 listener。

## B. 本地 fixture 输入闭环

~~~text
npm run e2e:chrome
~~~

脚本创建本机 HTTP fixture 和测试 tab，验证 raw 输入、调整行为、文本观察与显式截图。若必须验证真实 pointer：

~~~powershell
$env:NPC_MONEYHAND_REQUIRE_POINTER = "1"
npm run e2e:chrome
~~~

在脚本提示 `awaiting-foreground` 时让测试 Chrome 窗口位于前台，不要操作其他账号页。

验收：

- [ ] raw 模式没有人为延迟；
- [ ] `css-viewport-v1` click/type/key 在 fixture 生效；
- [ ] human/自定义节奏确实增加可测时延；
- [ ] `behavior.reset` 回到 raw；
- [ ] 页面文字优先；
- [ ] screenshot 只在显式调用后出现；
- [ ] 测试 tab 和 listener 按脚本终态回收。

## C. 最近焦点与 Task Space

在两个安装了 Extension 的 Profile 中使用固定端口 `19846`：

1. 依次聚焦 A、B，并观察 active session 变化；
2. 聚焦 A 后创建 Space A；
3. 聚焦 B 后创建 Space B；
4. 在两个 Space 各做只读 `target.list` / `system.status`；
5. 切换焦点后重复 Space 请求。

验收：

- [ ] 默认独立请求跟随最近焦点；
- [ ] Space A/B 始终固定不同 `instanceId + bootId`；
- [ ] 切焦点不串 Profile；
- [ ] Extension reload 后旧 Space fail closed；
- [ ] 没有 Profile 别名依赖。

## D. raw、human 和截图

在无账号影响的本地 fixture：

- [ ] 默认 `behavior.get` 为 raw；
- [ ] human 的 pointer step、typing delay、scroll pause 生效；
- [ ] TTL 到期恢复 raw；
- [ ] Agent `finally` 中 reset；
- [ ] unknown method 返回有界 text context；
- [ ] waiting tab 的写操作被阻止；
- [ ] `instruction.resolve` 恢复或取消；
- [ ] 没有自动截图；
- [ ] viewport screenshot 的像素/CSS 比例有记录；
- [ ] full-page 图片没有直接用于 input。

## E. 高频与并发

在本地 fixture 的两个 tab 发送有界只读请求：

- [ ] 每个 request ID 只有一个 terminal；
- [ ] 同一 tab 保持 FIFO；
- [ ] 不同 tab 有真实重叠；
- [ ] 无 `ID_CONFLICT`；
- [ ] 无无解释的丢失 result；
- [ ] 记录 p50/p95、inflight、queue peak、`droppedEvents`；
- [ ] stdout 持续 drain；
- [ ] 停止时收到全部 result、`moneyhand.stopped` 和 EOF。

不要用外部站点做极限吞吐基准。

## F. 断线和结果未知

只在可恢复本地 fixture 上：

1. 派发一个可观察动作；
2. 在动作执行后、响应确认前制造连接中断；
3. 让 Extension 重连。

验收：

- [ ] 新 `hello.unknownOutcomeIds` 包含原 ID；
- [ ] Extension 没有自动重放；
- [ ] Agent 先观察 fixture 状态；
- [ ] ACK 前重复重连仍报告 ID；
- [ ] 仅核查后 `confirmUnknown`；
- [ ] ACK 后下一次 hello 不再报告；
- [ ] 旧 epoch 变更未落定时新变更 fail closed；
- [ ] 没有用新 ID 盲重试。

## G. rate controller

使用纯本地测试或模拟观察，不向真实站点制造限流：

- [ ] 新 scope 从 pilot/小并发开始；
- [ ] clean batch 后有限提升；
- [ ] 429 + `Retry-After` 先降并发并 cooldown；
- [ ] 503/latency anomaly 增加 backoff；
- [ ] challenge/account change 打开 circuit；
- [ ] circuit-open 不继续派发；
- [ ] checkpoint/snapshot 可序列化；
- [ ] reset 只发生在明确的新 pilot 决策后；
- [ ] 多个 origin/Profile scope 不串状态。

该测试只能证明调度器逻辑，不能证明目标网站不会限流。

## H. MV3 与重连

- [ ] READY 空闲后仍能执行只读探针；
- [ ] 停止 listener 后 Extension 自动重试；
- [ ] listener 恢复后自动握手；
- [ ] Service Worker 回收后状态符合 `chrome.storage.session` 语义；
- [ ] Extension reload 后 `instanceId` 稳定、`bootId` 更新；
- [ ] Chrome restart 后自动重连；
- [ ] 禁用 Extension 后不再连接；
- [ ] 纯持久 listener 不会自动启动 Chrome；`--connect`/`--call`/`--task` 在未连接时会打开已安装 MoneyHand 的 Profile。

至少做一次 30 分钟连接稳定观察；长期交付应按真实任务时长单独测试。

## I. 页面外边界

对 `routeSurface` 做无输入验证：

- [ ] normal web page → `moneyhand`；
- [ ] canvas/map/WebGL → 页面视觉 + CDP Input；
- [ ] browser toolbar/native dialog/permission/system auth/desktop app → `human`；
- [ ] CAPTCHA → `human`；
- [ ] 没有自动系统输入；
- [ ] 人工接管后 Agent 重新观察 Profile/boot/tab/URL。

## J. 可选站点只读 smoke

仅对用户允许访问的 URL：

~~~powershell
$env:NPC_MONEYHAND_TEST_URL = "https://example.com/"
npm run smoke:site
~~~

脚本只做有界访问和挑战判断。若出现登录变化、挑战、持续 403、429/503 或不明确状态，记录终态并停止；不要把 smoke 自动升级为批量采集。

## 通过标准

交付报告至少写明：

- 通过的层和命令；
- 当前 Profile 是否实际参与；
- 输入是否要求前台；
- 站点是否只读；
- rate/challenge 信号；
- unknown outcome 数；
- 未执行或跳过的项目；
- 重连后的 Extension 状态。

只有证据存在的项才标为通过。
