# Agent 快速开始

本页只定义首次安装和连接。不要在连接成功前研究协议、生成控制脚本或执行网页任务。

要求：本机 Node.js 20+、Chromium 125+；不需要 `npm install`，不安装 daemon。

## 1. 安装基础 Skill

通过当前 Agent 宿主公开的本地 Skill 导入方式安装完整的 `skills/npc-moneyhand` 目录。不要
扫描电脑猜测未知的 Skill 路径。WorkBuddy 使用其本地 Skill 导入界面。

Skill 不包含 Extension。未安装时由用户从项目 Releases 下载并解压
`npc-moneyhand-extension-1.0.0.zip`，再通过 Chromium 扩展管理页加载。

## 2. 执行唯一连接命令

在基础 Skill 目录执行一次：

~~~text
node scripts/moneyhand.mjs --connect
~~~

命令会返回一个 `npc-moneyhand-connect/1` 结果。只执行其中的 `nextAction`：

外层 `ok: true` 只表示命令成功返回了有界结果。只有 `value.connected: true` 且
`value.status: connected` 才表示 MoneyHand 已连接。

| 结果 | Agent 行为 |
| --- | --- |
| `connected` | 转述 `userMessage`，询问用户要做什么，然后等待。 |
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

## 3. 连接成功后等待任务

不要自动访问百度、Google、Reddit 或其他网站，不要枚举标签页、截图或做烟雾测试。只问：

> MoneyHand 已连接，可以开始使用。你希望我现在操作哪个网页、完成什么任务？如果目标页面已经打开，请切到那个页面。

收到任务后才按基础 Skill 的任务阶段说明使用 MoneyHand。专项 Skill 可以复用已连接的
MoneyHand，但必须自己拥有领域工作流、范围、字段、完成标准和输出。

## 4. 禁止发散排障

连接过程中禁止读取 Extension 源码、运行预检、扫描端口、切换控制工具、写临时控制器、
修改浏览器 Profile、杀浏览器进程或改变固定端点。规定路径失败时返回并停止。
