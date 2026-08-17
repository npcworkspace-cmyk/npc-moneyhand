# npc-moneyhand

`npc-moneyhand` 是给 AI Agent 使用的 Chrome 工具手。对外交付只有两部分：

- `extension/`：WS-only、零外部依赖的 Chrome MV3 扩展；
- `skills/npc-moneyhand/`：自包含的 Agent Skill，内置 `moneyhand` 控制台、连接管理、语义动作、Task Space、拟人行为入口、恢复和自适应限流控制器。

当前版本：`1.0.0`。

扩展负责确定性执行，Skill 负责 Agent 侧控制。没有独立常驻服务，没有桌面控制产品，也不要求另装一个控制器产品。

## 五分钟开始

要求：

- 桌面 Chrome/Chromium 125+；
- 使用官方 Skill 时需要 Node.js 20+；
- Extension 与 Skill 在同一台电脑上通过 loopback 通信；
- 不需要 `npm install`。

直接克隆仓库：

~~~powershell
git clone https://github.com/npcworkspace-cmyk/npc-moneyhand.git
cd .\npc-moneyhand
~~~

在每个需要交给 Agent 的 Chrome Profile 中：

1. 打开 `chrome://extensions`，启用开发者模式；
2. “加载已解压的扩展程序”，选择仓库的 `extension` 目录；
3. 打开扩展弹窗，确认 `127.0.0.1:19846`，点击一次“保存”；
4. 保持 Chrome 和扩展启用。以后 Agent listener 启动时扩展会自动重连。

安装 Skill 到默认 Agent Skills 目录：

~~~text
npm run skill:install
~~~

仓库开发时可使用会随源码更新的链接：

~~~text
npm run skill:link
~~~

其他支持 Skills 的 Agent 可指定自己的目录：

~~~text
node scripts/install-skill.mjs --mode copy --target "<agent-skills-directory>"
~~~

要交付一个不依赖仓库、不需要 `npm install` 的便携包：

~~~text
npm run skill:pack:portable
~~~

产物位于 `artifacts/portable-skill/`：一个以 `npc-moneyhand/` 为根的 ZIP，以及
`portable-manifest.json` 和 `SHA256SUMS.txt`。该 ZIP 只包含 Skill、控制器和插件完整性
清单，**不包含 Extension 源码或安装目录**。在新电脑解压后，Agent 第一步必须从 Skill 目录运行
`node scripts/preflight.mjs --json`；它只扫描有界的已知/显式 Chromium Profile 路径，
不会启动浏览器、绑定端口或写 Profile。各 Agent 的原生目录与通用交接见
[`agent-hosts.md`](./skills/npc-moneyhand/references/agent-hosts.md)。

若预检没有找到匹配且启用的 Extension，让用户前往
[GitHub Releases](https://github.com/npcworkspace-cmyk/npc-moneyhand/releases) 下载独立的
`npc-moneyhand-extension-1.0.0.zip`，解压后从浏览器扩展页人工加载。Skill 不会自动下载、
解压、写入 Profile 或修改浏览器策略；Skill 与 Extension 可以分别升级和分发。

从源码发现并启动控制台：

~~~text
node skills/npc-moneyhand/scripts/moneyhand.mjs --describe
node skills/npc-moneyhand/scripts/moneyhand.mjs --host 127.0.0.1 --port 19846
~~~

安装为可执行包后，正式 CLI 名称是 `moneyhand`：

~~~text
moneyhand --describe
moneyhand --host 127.0.0.1 --port 19846
~~~

启动成功先输出 `moneyhand.listening`；正常有限运行最终输出 `moneyhand.stopped`。完整启动和关闭顺序见 [Agent 快速开始](./docs/AGENT_QUICKSTART.md)。

## 运行关系

~~~text
专项 Skill（可选：Reddit 评论、红人开发、VOC……）
                         │ 复用同一个任务期控制器
                         ▼
npc-moneyhand Skill
  ├─ moneyhand CLI / ESM / JSONL / trusted task module
  ├─ connection / Task Space / semantic action / approval
  └─ pilot / backoff / cooldown / circuit
                         │ npc-moneyhand/2
                         ▼
loopback WebSocket
                         ▲ Extension 主动连接
                         │
npc-moneyhand Chrome Extension
  ├─ raw CDP / CDP Input
  ├─ allowlisted Chrome API
  ├─ bounded text observation
  └─ explicit screenshot
                         ▼
当前真实 Chrome Profile
~~~

每个 Agent 任务只能拥有一个 MoneyHand controller。任务内可以运行多个专项阶段或次抛任务模块；任务结束必须关闭 controller。项目不会安装 daemon、Windows 服务、launch agent、Native Host 或后台常驻控制器。

扩展是 WebSocket client，Skill 是本机 listener。所谓“输入端口唤醒”是扩展发现已启动的 listener，不是 listener 启动 Chrome。Chrome 已关闭、扩展被禁用或电脑休眠时，仅启动端口不能唤醒浏览器。

## 默认快，拟人模式显式开启

默认行为是 `raw`：

- 直接走结构化响应、CDP、DOM 或批量操作；
- 不添加人为延迟；
- 不自动截图；
- 不自动重放结果未知的动作。

只有 Agent 或上层专项 Skill 明确要求时才启用 `human`。它改变鼠标轨迹、输入节奏、滚动分段和停顿；应设置有限 TTL，并在 `finally` 中 `behavior.reset`。它不是验证码规避、账号伪装或绕过网站限制的机制。

大批量任务可使用 Skill 内的自适应 rate controller，但它与 `human` 行为是两件事：

1. 先用最小代表样本 pilot；
2. 观察 429/503、`Retry-After`、节流载荷、持续 403、挑战页和延迟异常；
3. 先降并发，再增加带 jitter 的间隔并进入 cooldown；
4. 达到停止条件时打开 circuit，保存 checkpoint 并交回 Agent；
5. 只在连续干净的小批次后逐步恢复，且不超过最后已知安全速率。

这是显式调用方调度器，不会替普通 `request()` 猜测站点/Profile/账号 scope，也不会自动拦截
未纳入调度的低层请求。Agent 或专项 Skill 必须在每个受控批次前读取 decision、遵守
concurrency/interval/wait/stop，并在批次后回传观察。`human` 在同一个 decision 内不会放宽门槛。

这只能降低冲击、识别限流并安全恢复，**不保证不触发限流，也不保证账号不会被平台限制**。挑战页、账号状态变化或最低并发下重复节流必须停止，不得靠拟人模式继续冲量。

## 能力边界

Extension wire `npc-moneyhand/2` 提供：

| 类别 | 方法 |
| --- | --- |
| 状态与行为 | `system.status`、`behavior.get/set/reset` |
| 目标 | `target.list/attach/detach/sessions` |
| 原始浏览器能力 | `cdp.send` |
| 受限 Chrome API | `chrome.call` |
| 高频输入与批处理 | `input.perform`、`batch.run` |
| 观察 | `observe.context`、`observe.screenshot` |
| 事件与求助恢复 | `events.subscribe/unsubscribe`、`instruction.resolve` |

Skill 控制面 `npc-moneyhand-control/1` 在 wire 之上增加：

- ESM、UTF-8 JSONL、`--once` 和可信 `--task`；
- 最近焦点 Profile 路由与精确 `instanceId + bootId` 固定；
- Task Space、页面 transition、语义快照、稳定 locator 和短期 ref；
- 下载、上传、select、check、drag 等受守卫动作；
- 高影响操作的一次性审批和活动记录；
- `OUTCOME_UNKNOWN` 检查后确认；
- 自适应 rate controller；
- 页面/浏览器外表面路由判断。

页面正文、标题、URL 和控件文本都视为不可信内容。页面不明确时先返回有界文本给 Agent；只有文字不足且 Agent 明确要求时才截图。

## 浏览器外表面

MoneyHand 只控制网页目标：

1. 结构化 DOM/CDP；
2. 页面视觉 + CDP Input（canvas、地图、WebGL 等）；
3. 浏览器工具栏、原生保存/打印窗口、权限弹窗、系统认证、桌面软件和 CAPTCHA 交给人。

项目不再提供桌面自动化后端。`css-viewport-v1` 坐标只属于页面 viewport，不能直接用于系统窗口或屏幕坐标。

## 叠加专项 Skill

例如 `crawl-reddit-comments`、红人开发或 VOC Skill 可以复用 MoneyHand，但职责必须分开：

- 专项 Skill：平台入口、字段、分页、去重、checkpoint、业务输出和平台特有限流信号；
- MoneyHand Skill：唯一 controller、连接、行为、Task Space、通用动作、审批、恢复和 rate controller；
- Extension：确定性浏览器执行。

专项 Skill 不得复制 WebSocket Peer、另开同端口 listener、绕过审批/限流控制，或把平台业务逻辑塞进扩展。若需要动态任务代码，复制 `skills/npc-moneyhand/assets/disposable-task.mjs` 到任务目录；模块只导出任务逻辑，不拥有 controller 生命周期。

创作专项 Skill 时还必须先声明站点/账号范围、最大任务边界、字段、effects、所需 operation、
controller 归属、完成证明、rate scope 和输出；无法证明全量完成时必须返回有界的 incomplete，
不能把部分数据包装成 complete。完整的“允许做什么、必须做什么、禁止做什么、如何打包与
验收”见 [`skill-composition.md`](./skills/npc-moneyhand/references/skill-composition.md)。

## 安全与网络边界

- listener 只绑定 `127.0.0.1`、`localhost` 或 `::1`；IPv4 和 IPv6 是不同 listener；
- Upgrade 只接受精确 `/extension`、匹配端口的 loopback Host/remote 和 Chrome Extension Origin；
- 配对密钥只通过 `NPC_MONEYHAND_PAIRING_TOKEN` 传入，不写 argv、页面或日志；
- 不导出 cookie/token，不绕过挑战，不把“CDP 看得到”解释成数据授权；
- 付款、发布、发送、删除、上传等外部写入需要当前用户确认；
- post-dispatch 超时、断线或 `OUTCOME_UNKNOWN` 必须先检查真实状态，禁止盲重试。

## 文档

- [架构](./ARCHITECTURE.md)
- [Agent 快速开始](./docs/AGENT_QUICKSTART.md)
- [Agent / CLI 接入](./docs/AGENT_INTEGRATION.md)
- [兼容、升级与回滚](./docs/AGENT_COMPATIBILITY.md)
- [故障处理](./docs/AGENT_TROUBLESHOOTING.md)
- [Extension wire 协议](./docs/PROTOCOL.md)
- [性能原则](./docs/PERFORMANCE.md)
- [真实 Chrome 验收](./docs/REAL_CHROME_TEST.md)
- [Git 工作流](./docs/GIT_WORKFLOW.md)

机器可读契约位于：

- `skills/npc-moneyhand/references/moneyhand-contract.json`；
- `skills/npc-moneyhand/references/agent-operations.json`；
- `skills/npc-moneyhand/references/extension-integrity.json`。

## 验证

本地零依赖门禁：

~~~text
npm run check
~~~

真实 Chrome 是独立验收面：

~~~text
npm run smoke:chrome
npm run e2e:chrome
~~~

测试脚本通过不等于当前用户 Profile、登录账号或目标网站已经验收；交付结论必须分别说明本地门禁、打包门禁和真实 Profile 结果。

## License

MIT
