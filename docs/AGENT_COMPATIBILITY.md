# 兼容、升级与回滚

运行时能力以本机 `moneyhand --describe`、`moneyhand.listening` 和 Extension `hello` 为准。README 版本号不能代替现场发现。

## 当前兼容矩阵

| 交付物 | 版本 | 协议 | 最低运行环境 |
| --- | --- | --- | --- |
| `npc-moneyhand` Skill | `1.0.0` | `npc-moneyhand-control/1`、`npc-agent-jsonl/1` | Node.js 20+ |
| Chrome Extension | `1.0.0` | `npc-moneyhand/2` | Chrome/Chromium 125+ |

两者来自同一仓库 Release。最安全的组合是相同 Git commit 或相同 release manifest；不承诺跨任意未发布提交的私有 API 兼容。

## 硬兼容规则

1. Skill 与 Extension 必须精确声明 wire `npc-moneyhand/2`。
2. Agent adapter 必须发现 control `npc-moneyhand-control/1`、`args` envelope、startup/stopped event 和 operation catalog。
3. `127.0.0.1` 与 `::1` 是不同 listener；Extension 保存的 host 必须匹配控制台。
4. `instanceId + bootId` 只固定当前 Profile boot。Extension reload、Chrome restart 或 Profile 替换后重新建 Task Space。
5. semantic snapshot/ref、审批令牌和 unknown-outcome ACK 不跨 boot 复用。
6. descriptor/catalog 不匹配时 fail closed；不要用旧字段继续写操作。
7. 一个端口只属于一个 Agent 任务，不支持多个独立 controller 竞争同一端口。
8. 页面外表面只支持 human takeover，不因操作系统不同而自动添加本地输入后端。

## 平台边界

| 层 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Skill 控制台 | Node.js 20+ | Node.js 20+ | Node.js 20+ |
| Extension | 桌面 Chrome/Chromium 125+ | 同左 | 同左 |
| 浏览器页面控制 | CDP、Chrome API、CDP Input | 同左 | 同左 |
| 浏览器外/桌面表面 | 人工接管 | 人工接管 | 人工接管 |

“纯 JavaScript”不能证明每个平台、CPU 架构、浏览器分发版和真实账号都已验收。CI、本地一次性 Profile 和用户当前 Profile 是不同证据层。

## 推荐升级顺序

升级前结束当前任务并保留未知结果清单。不要在可能已派发写操作时热替换。

1. 记录 Git commit、`moneyhand --describe` 和 Extension 版本。
2. 运行 `npm run check`；如交付 package，再运行 packaged acceptance。
3. 停止当前 controller，确认 `moneyhand.stopped` 和 stdout EOF。
4. 更新 `npc-moneyhand` Skill。
5. 在 `chrome://extensions` reload 同一 Release 的 `extension`；同一 Profile 不要同时启用两个版本。
6. 启动新 controller，先做 `--describe`、`status`、`wait` 和 `target.list` 只读探针。
7. 重新创建 Task Space，再验证语义动作、human TTL/reset 和 rate controller。
8. 最后恢复有账号影响或高频的任务。

若第 4–7 步失败，先停止新 controller，再恢复匹配的一对旧 Skill/Extension。未知动作未核查前不要因为回滚而重放。

## Skill 安装管理

默认目标依次是 `NPC_AGENT_SKILLS_DIR`、`CODEX_HOME/skills`、`~/.codex/skills`。也可显式传 `--target`。

~~~text
node scripts/install-skill.mjs --action status --mode copy --target "<skills-directory>"
node scripts/install-skill.mjs --action install --mode copy --target "<skills-directory>"
node scripts/install-skill.mjs --action migrate --mode copy --target "<skills-directory>"
node scripts/install-skill.mjs --action update --mode copy --target "<skills-directory>"
node scripts/install-skill.mjs --action remove --mode copy --target "<skills-directory>"
~~~

`migrate` 只接受能严格识别为本仓同源 link 的旧 `npc-moneyoperator` 入口（悬空的已退休
源码 junction 也按精确 link target 识别）。它先 recoverable rename 旧入口，再安装统一 Skill；
未知目录或手工/第三方 copy 一律拒绝且不改动。

行为：

- `install` 不覆盖已有路径；
- `link` 适合仓库开发，Windows 使用 junction，POSIX 使用 symlink；
- `copy` 是独立快照；
- `update` 先 staging，再把旧 copy 移到返回的 backup 路径；
- `remove` 把受管理安装移动到 recoverable path，不直接删除；
- `rollback` 只接受前一步返回的精确受管理路径：

~~~text
node scripts/install-skill.mjs --action rollback --mode copy --target "<skills-directory>" --backup "<exact-backup-path>"
~~~

安装器只管理带有效 provenance 的 copy。未知同名目录、手工 copy 或断开的 link 都不会被强行接管。

## Extension 升级与回滚

开发者模式中的 Extension 指向一个目录：

1. 停止 controller；
2. 切到准确 commit/tag 或独立 worktree；
3. 在 `chrome://extensions` reload 对应 `extension`；
4. 核对显示版本和保存的 loopback endpoint；
5. 启动匹配 Skill；
6. 先只读验证。

不要用破坏性 Git 命令覆盖有未提交工作的 checkout。Extension reload 会改变 `bootId`；旧 Space、ref 和 unknown ACK 必须废弃。

## 专项 Skill 兼容

专项 Skill 应声明：

- 所需 control/wire protocol；
- 所需 operation 和 Extension method；
- effect 与审批要求；
- rate scope、stop signals、checkpoint 版本；
- 输出 schema。

专项 Skill 只复用当前任务的 MoneyHand controller。若它要求另一个 listener、另一个 Peer 或页面外自动输入，则与本架构不兼容。

## Agent 宿主判定

兼容与否取决于能力，不取决于 Agent 品牌：

- 能否在用户电脑启动 Node 20+；
- 能否持续 drain UTF-8 stdout 并写 stdin；
- 能否访问 loopback；
- 能否在任务结束回收进程；
- 能否把高影响确认和结果未知反馈给用户。

只有远程 MCP/聊天、无法访问本机进程或 Chrome Extension 的宿主，需要自己的受控本地适配层；本项目不会为此恢复常驻 daemon。
