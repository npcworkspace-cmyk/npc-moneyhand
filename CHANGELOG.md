# Changelog

## [1.0.0] - 2026-08-17

首个正式版本。

### Included

- 一个 WS-only、零外部依赖的 Chrome MV3 Extension，提供 raw CDP、CDP Input、受限 Chrome API、批处理、有界文本观察和显式截图。
- 一个自包含的 `npc-moneyhand` Agent Skill，提供 ESM、UTF-8 JSONL、CLI、Task Space、语义动作、审批、未知结果恢复和一次性任务模块。
- 默认 raw 快速执行，以及由 Agent 显式开启并带 TTL 的 human 行为模式。
- 显式调用方自适应限流调度器，支持 pilot、并发收缩、`Retry-After`、jitter、cooldown、checkpoint 和挑战停止条件。
- 最近焦点 Profile 路由，以及 `instanceId + bootId` 精确固定的多步骤任务生命周期。
- 两个独立交付物：`npc-moneyhand` Skill tarball 与 Chrome Extension ZIP。

### Boundaries

- 不包含 daemon、桌面自动化产品、MCP 服务、Native Host 或外部运行时依赖。
- 浏览器工具栏、原生窗口、系统认证、密码提示、安全确认和 CAPTCHA 交给人工处理。
- `human` 模式不绕过限流或访问控制；截图只在文字和结构化观察不足时显式使用。

### Verification

- 整仓测试、产品边界审计、严格 operation schema、安装器 provenance、发布包校验和 Python 标准库 Agent 黑盒生命周期。
- 双隔离 Chromium Profile 的 Task Space、语义动作、CDP/Input 与 OOPIF 验收。
- 当前真实 Chrome Profile 的 Extension 握手、状态查询和 `target.list` 只读验证。
