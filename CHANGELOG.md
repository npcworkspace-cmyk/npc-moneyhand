# Changelog

## [1.2.3] - 2026-08-22

- Derive fail-closed completion requirements from bounded task-specific facts with an exact ID set and recursive expected-object matching, while preserving extra measured receipt fields in actual results.
- Add an automatic `runtime:behavior-mode` requirement whenever human behavior is requested.
- Make the runnable task reference and normal-path docs expose one copyable `taskFacts` contract for custom clicks, scrolls, uploads, downloads, or other concrete actions.
- Make `requiredFields` fail closed on blank or otherwise empty values instead of accepting keys whose business data is missing.
- Bind each private task-evidence artifact's declared byte count and SHA-256 to the exact bytes written on disk, including its final newline.
- Tell task authors to preserve verified browser-owned field sources when renaming output keys and to fail incomplete instead of guessing selectors that yield empty business data.
- Make the source-identical multi-page reference emit standard `recordId/title/body/sourceUrl` rows and accept native `taskData.scrollDeltaY`, with pre-window validation plus automatically derived real scroll receipts and completion facts.
- Make intuitive `pages[].pageKey` the primary runnable-reference input while retaining `id` as a fail-closed legacy alias, so a first-time Agent does not need to infer an internal field name.

## [1.2.2] - 2026-08-22

- Treat the complete bounded-file reference as a runnable parameterized task instead of rejecting a valid source-identical copy as an unimplemented template.
- Keep normalized-source rejection for the genuinely blank disposable and specialized lifecycle assets.
- Add fail-closed `args.acceptance` checks for total records, per-page counts, page IDs, and every required field so a copied reference can prove the user's exact result without fragile source edits.
- Make acceptance provenance explicit: Agents omit unknown expected values instead of inventing page IDs, and connection results expose the exact product version and task-routing rule.

## [1.2.1] - 2026-08-22

- Detect unchanged authoring templates by normalized source fingerprint, so Agents edit only `executeTask()` and never remove a sentinel or authoring flag manually.
- Keep unchanged disposable, specialized, and full-example files fail-closed before browser dispatch while accepting implemented legacy copies that still export the old sentinel.
- Add an absolute UTF-8 `--args-file` task input as the shell-safe default across Windows, macOS, and Linux while retaining `--args-json` for programmatic compatibility.

## [1.2.0] - 2026-08-22

- Make `executeTask()` the only editable function in disposable and specialized task templates while preserving the fixed lifecycle and cleanup wrapper.
- Add deterministic URL-safe effect IDs, an explicit terminal/output contract, bounded wait/evaluation rules, and a `pageExpression()` helper that makes literal `${...}` page text safe by construction.
- Add a complete platform-neutral multi-page JSONL/checkpoint/manifest task example with overwrite protection and automated regression coverage.
- Make the complete example genuinely one-page-to-many-records and add a grouped-order helper that prohibits invented per-page cardinalities.
- Require one machine-checkable completion requirement for every explicit user acceptance condition instead of allowing a generic count to hide missing page, order, identifier, or field checks.
- Reject complete claims when a bulk output manifest and its `output-file` evidence disagree on path, format, or count.
- Keep execution-terminal state separate from business outcome so `taskSummary` never labels an incomplete result as successful and points the Agent to its captured visual evidence.

## [1.1.1] - 2026-08-22

- Deduplicate watchdog screenshots by task-activity epoch so one continuous silence cannot trigger an immediate second capture on a busy event loop.
- Acknowledge deadlines that arrive before or during task-module import instead of letting the task miss an already-fired abort signal.

## [1.1.0] - 2026-08-22

- Replace the old multi-step startup with one bounded `--connect` flow and mandatory localhost-only acceptance.
- Add isolated task windows, progress/watchdog events, visual fallback, task journals, recovery summaries, effect receipts, rate gates, and completion evidence.
- Publish stable Latest Release asset names for the portable Skill and Extension so Agents cannot mix current documentation with an older package filename.
- Gate publishing on Windows, macOS arm64, and macOS Intel conformance of the exact release artifact.

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
