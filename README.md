# npc-moneyhand（抓钱手）

[简体中文](./README.md) | [English](./README_EN.md)

> **Agent 时代的浏览器行动与任务运行基座。**
>
> 给 AI Agent 一双真实浏览器里的手，也提供一套多任务隔离、长任务管理和无人值守运行机制。

**AI Agent Browser Automation · Multi-Agent Browser Control · Chrome Extension · CDP · Web Automation · Computer Use · Agent Skill · Local-first**

<strong>npc-moneyhand（抓钱手 / MoneyHand）</strong> 让 Codex、Claude Code、OpenClaw、Hermes 等本地 Agent 连接用户正在使用的 Chromium 浏览器和真实登录环境，稳定执行网页任务。

它不是某个网站的专用爬虫，也不是一次性自动化脚本。MoneyHand 把浏览器操作、任务隔离、进度管理、异常恢复和 Skill 扩展整合成一套可复用的基础能力。

[下载 Release](https://github.com/npcworkspace-cmyk/npc-moneyhand/releases) · [快速开始](./docs/AGENT_QUICKSTART.md) · [MIT License](./LICENSE)

## 可以用来做什么

- 搜索、浏览、提取和整理网页信息；
- 在用户授权下操作已有登录状态的网站；
- 批量点击、输入、翻页、填写表单和处理列表；
- 上传、下载、提交、核对和管理网页内容；
- 测试网站流程、控件、链接和操作结果；
- 运行长时间、批量或无人值守的网页任务；
- 通过专属 Skill 固化团队和个人的重复工作流程。

只要任务发生在 Chromium 网页内部，MoneyHand 就可以作为 Agent 的通用执行层。

## 核心能力

### 多 Agent、多任务隔离

多个 Agent 可以同时提交和跟进不同网页任务。每个任务拥有独立窗口、Task Space、执行 ID、进度和检查点；底层根据浏览器、Profile 和网站承载能力并发或排队，减少任务之间抢标签、串页面和互相干扰。

> **多个 Agent 共享一双手，每个任务都有自己的工作台。**

### 完整任务管理

MoneyHand 管理任务的完整生命周期：

~~~text
创建任务 → 固定窗口 → 执行动作 → 返回进度
→ 保存检查点 → 处理异常 → 验证结果 → 自动清理
~~~

Agent 可以随时知道任务是否仍在运行、执行到哪里、是否遇到限制，以及下一步应该继续、等待还是停止。

### 长任务与无人值守

专属 Skill 可以定义步骤、批次、检查点、异常处理、停止条件和完成标准。任务启动后可以持续运行；发起任务的 Agent 暂时断开时，其他 Agent 仍可继续跟进同一个任务。

适合日常信息整理、网页后台处理、页面巡检、列表任务和其他可重复工作。定时触发可由 Agent、系统计划任务或外部调度器负责。

### 批量执行与 Token 效率

MoneyHand 把重复步骤下沉为批量动作、快速页面读取和确定性脚本，减少每一步都调用模型、重复传输页面和反复识别截图。

> **在可批处理任务中，显著减少模型往返、Token 消耗和等待时间。**

固定节省比例将在统一基准测试后公布，不使用未经验证的营销数字。

### 异常识别与截图兜底

遇到超时、遮挡、页面变化、操作无反馈或任务静默时，MoneyHand 会返回当前页面信息、截图和处理建议，让 Agent 根据真实现场继续，而不是盲目重试。

### 自动节流与结果验证

MoneyHand 根据网站反馈调整速度、间隔和批次，必要时等待、保存检查点或停止。任务完成前还会检查结果、证据、异常状态和窗口清理，减少空跑与虚假完成。

### 完整网页操作

支持导航、等待、点击、输入、滚动、选择、勾选、拖拽、上传、下载、截图、结构化页面读取、快速 CDP 操作，以及按任务开启的拟人输入模式。

## 三层结构

~~~text
Agent
理解目标、做判断
    ↓
专属 Skill
定义具体流程和结果
    ↓
npc-moneyhand Skill
管理任务、进度、恢复和节流
    ↓
MoneyHand Extension
在真实浏览器中执行动作
~~~

- **Extension**：稳定执行通用浏览器动作；
- **基础 Skill**：统一管理连接与任务运行；
- **专属 Skill**：定义具体网站和业务工作流。

> **一只通用的抓钱手，可以支撑无数个专属行动助手。**

## 快速开始

1. 从 [GitHub Releases](https://github.com/npcworkspace-cmyk/npc-moneyhand/releases) 安装 MoneyHand Extension；
2. 下载便携 Skill，或克隆仓库并运行 <code>npm run skill:install</code>；
3. 在安装后的 Skill 根目录运行：

~~~text
node scripts/moneyhand.mjs --connect
~~~

MoneyHand 会自动连接 Extension、按需唤醒浏览器并完成验收，通过后即可执行任务。

### 给新 Agent 的固定规则

1. 安装 <code>skills/npc-moneyhand</code>；
2. 在 Skill 根目录立即运行一次连接命令；
3. 连接和验收通过后，当前对话已有任务就直接执行，没有任务才询问用户；
4. 只遵循返回结果中的 <code>nextAction</code>。

正常接入不扫描端口、不修改控制器、不安装其他浏览器框架，也不自行发明替代方案。完整规则见 [Agent 快速开始](./docs/AGENT_QUICKSTART.md)。

## 本地与边界

- Extension 与 Agent 只通过本机地址通信，不需要远程服务或单独安装 daemon；
- 不导出密码、Cookie、授权信息或浏览器 Profile；
- 不绕过 CAPTCHA、账号控制或网站限制；
- 页面可见不等于获得数据使用授权；
- 专属 Skill 不复制控制器、不启动第二个连接服务，也不把专项逻辑塞进 Extension。

MoneyHand 面向兼容 Chromium Extension API 的桌面浏览器，基础 Skill 需要 Node.js 20+。Windows + Chromium 是当前主要实机验证环境；macOS 与 Linux 应在目标电脑完成自动验收后再用于正式任务。

## 文档

- [Agent 快速开始](./docs/AGENT_QUICKSTART.md)
- [架构与边界](./ARCHITECTURE.md)
- [Agent 与 CLI 接入](./docs/AGENT_INTEGRATION.md)
- [故障排查](./docs/AGENT_TROUBLESHOOTING.md)
- [专属 Skill 组合规范](./skills/npc-moneyhand/references/skill-composition.md)

## License

[MIT](./LICENSE)
