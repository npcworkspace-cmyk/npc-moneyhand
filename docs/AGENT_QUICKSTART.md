# Agent 快速开始

本页只定义首次安装和连接。不要在连接成功前研究协议、生成控制脚本或执行网页任务。

要求：本机 Node.js 20+、Chromium 125+；不需要 `npm install`。本地控制器已经包含在 Skill
里，由唯一连接命令自动启动或复用，空闲后退出，不需要另装 daemon 或系统服务。

## 1. 安装基础 Skill

通过当前 Agent 宿主公开的本地 Skill 导入方式安装完整的 `skills/npc-moneyhand` 目录。不要
扫描电脑猜测未知的 Skill 路径。WorkBuddy 使用其本地 Skill 导入界面。

“安装完成”必须包含本页第 1～2 步并在同一个 Agent 回合内返回一次有界连接/验收结果。只复制
目录不算完成；Agent 不得把连接命令列为以后可选的下一步，不得询问用户是否现在连接或验收。

从 GitHub Latest Release 分发时，下载 `npc-moneyhand-portable-skill.zip`，用同一 Release 的
`npc-moneyhand-portable-skill-SHA256SUMS.txt` 校验后解压；ZIP 顶层的 `npc-moneyhand` 就是要
导入的完整 Skill 目录。

Skill 不包含 Extension。未安装时由用户从项目 Releases 下载并解压
`npc-moneyhand-extension.zip`，再通过 Chromium 扩展管理页加载。Skill 与 Extension 必须来自
同一个 Latest Release，不得混用 main 源码与旧 Release 资产。

## 2. 执行唯一连接命令

复制或导入结束后立即在直接包含 `SKILL.md` 的基础 Skill 根目录执行一次。不要先结束当前回合，
也不要先进入 `scripts/` 目录：

~~~text
node scripts/moneyhand.mjs --connect
~~~

这条命令内部自动管理控制器。自动唤醒浏览器后的有界握手等待和全功能验收都属于这一条命令，
不占用一次用户确认重试。正常流程不得先运行 `--ensure`，也不得另开 listener。

验收不需要客户选择，也不得由 Agent 跳过。MoneyHand 会创建一个独占测试窗口，仅访问临时
`127.0.0.1` 页面，依次验证任务绑定与拟人模式、导航、语义快照、输入、点击、勾选、选择、
上传、滚动、CDP 读取、视口截图、整页截图、下载和下载清理，最后关闭测试窗口并把行为重置为
`raw`。它不访问百度、Google、Reddit 等外部测试网站，也不使用用户已有页面。

命令会返回一个 `npc-moneyhand-connect/1` 结果。只执行其中的 `nextAction`：

外层 `ok: true` 只表示命令成功返回了有界结果。只有 `value.connected: true` 且
`value.status: connected` 才表示 MoneyHand 已连接。

| 结果 | Agent 行为 |
| --- | --- |
| `connected` / `ready_for_tasks` | 自动验收已经全部通过；转述 `userMessage`。当前对话已有明确浏览器任务就直接执行，否则询问任务并等待。 |
| `install_extension` | 转述 `userMessage`，等待用户安装并确认。 |
| `open_browser_and_click_extension` | 转述 `userMessage`，等待用户点击并确认。 |
| `blocked` | 转述 `userMessage`并停止。 |

`install_extension` 的提示会同时要求安装 Extension、打开该浏览器并点击“立即连接”。用户
完成 `install_extension` 或 `open_browser_and_click_extension` 返回的全部动作后，都只运行
结果中的同一个 `retryCommand` 一次：

~~~text
node scripts/moneyhand.mjs --connect --after-user-action
~~~

该命令仍未连接时必须停止，不得进行第三次自动重试。

## 3. 自动验收通过后路由任务

不要为了测试连接再访问百度、Google、Reddit 或其他网站，也不要追加枚举、截图或第二轮烟雾
测试。直接转述 `userMessage`；其标准含义是：

> MoneyHand 已连接，自动全功能验收通过，测试窗口已关闭。已准备好接收浏览器任务，请告诉我要做什么。

如果用户在连接前已经给出了明确浏览器任务，转述连接结果后直接继续，不要求用户重复或再次
确认同一任务；如果尚无任务，才停下来询问。执行时按基础 Skill 的任务阶段说明使用 MoneyHand。
基础 Skill 会在最近焦点 Profile
中创建专属任务窗口，并自动流出任务进度：启动后立即反馈、每 10 秒至少一次 heartbeat；页面操作
超时、遮挡、语义/页面异常或连续 15 秒没有任务活动时自动返回当前视口截图路径。Agent 应直接读取
该图片并基于当前状态继续，不能盲目重放原动作，也不需要自行寻找 tab/window ID。任务结束只关闭
该专属窗口，不关闭用户原有窗口。专项 Skill 可以复用已连接的 MoneyHand，但必须自己拥有领域
工作流、范围、字段、完成标准和输出。

长任务必须以前台附着方式运行 `--task` 并持续读取 stdout，不能把 MJS 放到后台后结束 Agent
回合。控制器硬编码每 10 秒至少输出一次 `moneyhand.task_progress`，连续 15 秒无任务活动时启动
页面截图，任务或适配器不能放宽阈值。若任务代码阻塞控制器，前台 CLI 输出
`moneyhand.task_monitor`，控制器恢复后会在清理前补截图。宿主若返回进程/session 句柄，Agent
必须每 30 秒以内继续等待该句柄直到终态；重要
checkpoint、截图或错误立即转述，只有 heartbeat 时也至少每 30 秒告诉用户任务仍在运行。控制器
返回的每类任务事件都带 `relay.wakeAgent`、`relay.notifyUser` 和下次反馈期限；宿主应据此唤醒
Agent 并转述进度。

启动时必须记录 `moneyhand.task_submitted.taskExecutionId`。如果 Agent、终端或命令句柄意外断开，
常驻控制器继续原任务并先写私有 journal；不得再次提交同一任务。用
`node scripts/moneyhand.mjs --task-follow "TASK_EXECUTION_ID"` 接回原流；只查一次状态用
`--task-status`，ID 丢失才运行一次 `--task-last`。控制器不能跨产品主动新建 Agent 回合，因此
宿主仍需消费附着流或 follow 流，但不再因为一次客户端断开而丢失任务。

正常高层 Task Space 操作会自动执行站点 origin + 固定 Profile 的限流 gate；同一任务内的
写入/导航等可用稳定 `effectId` 防止重复派发。终态会返回私有 `taskEvidence` 与
`completionGate`；只要清理、幂等结果、rate circuit、等待指令或声明的 requirements 未闭合，
即使任务脚本写了 `complete` 也会被拒绝。

任务窗口和自动拉起浏览器时的唯一引导标签都只使用 `about:blank` fragment 作为所有权标记，
不会为了创建标记而访问外部网站。

## 4. 禁止发散排障

连接过程中禁止读取 Extension 源码、运行额外预检、扫描端口、切换控制工具、写临时控制器、
修改浏览器 Profile、杀浏览器进程或改变固定端点。规定路径失败时返回并停止。
