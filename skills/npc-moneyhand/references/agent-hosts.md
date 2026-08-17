# Agent host handoff

MoneyHand is an Agent Skills folder plus a zero-dependency Node.js controller. The portable
contract is the folder itself, not a host-specific plugin. Keep the entire `npc-moneyhand/` tree
together so `SKILL.md`, `scripts/`, `references/`, and `assets/` retain their relative paths.

## Runtime contract

Every host needs all of the following:

- Node.js 20 or newer.
- Permission to read this Skill directory and run a local process.
- A user-loaded MoneyHand extension in a supported Chromium Profile.
- A task owner that can keep one controller process alive and stop it when the task ends.

The portable Skill archive intentionally excludes extension source and installation files. When
preflight reports `summary.extensionFound === false`, direct the user to
`https://github.com/npcworkspace-cmyk/npc-moneyhand/releases` to download the exact
`npc-moneyhand-extension-1.0.0.zip` asset. The user extracts and loads it through the browser's
extension page. Do not silently download it, copy it into a Profile, or modify browser policy. If a
verified installation is only disabled, ask the user to enable it instead of installing a duplicate.
Rerun preflight after that human action.

Merely displaying or injecting `SKILL.md` cannot scan the computer or control a browser. The Agent
must actually execute the commands below. MoneyHand does not install a daemon or background service;
the controller is a task-owned process, and starting it does not launch a browser.

From the Skill directory, every host follows the same baseline:

```text
node scripts/preflight.mjs --json
node scripts/moneyhand.mjs --describe
node scripts/moneyhand.mjs --host 127.0.0.1 --port 19846
```

The first command is the bounded, read-only browser and extension scan. The second emits one offline
machine-readable descriptor without binding a port. Run the third only when the preflight reports a
complete scan and at least one enabled extension matching the tree declared by this trusted Skill
package. That package-relative integrity match and browser configuration are on-disk evidence, not
independent publisher authentication or a live connection; only the later
`npc-moneyhand/2` handshake proves readiness. Use an absolute script path if the host cannot set its
working directory to the Skill directory.

Preflight JSON contains local absolute paths. Do not paste the raw report into a remote Agent or
shared log; keep it local or redact Skill, browser, Profile, extension, and warning paths first. The
scanner has no network client and rejects UNC, Windows device namespaces, and POSIX `//` roots, but
it cannot distinguish mapped drives or mounted NFS/SMB filesystems from local storage.

## Native Skill hosts

Copy or link the complete `npc-moneyhand` directory into one of the documented roots. A project root
is preferable when the Skill should travel with one repository; a user root makes it available across
projects. Restart or open a new Agent session when a host does not hot-reload newly added Skills.
Here `~` means the current user's home directory on Windows, macOS, or Linux; resolve it through the
host runtime instead of hard-coding a platform-specific drive or account name.

| Host | Documented native route | Invocation |
| --- | --- | --- |
| Codex | Project: `<repo>/.agents/skills/npc-moneyhand`; user: `~/.agents/skills/npc-moneyhand` | Ask for `npc-moneyhand`, or explicitly select/mention the Skill. |
| Claude Code | Project: `<repo>/.claude/skills/npc-moneyhand`; user: `~/.claude/skills/npc-moneyhand` | `/npc-moneyhand` or a matching natural-language task. |
| CodeBuddy Code | Project: `<repo>/.codebuddy/skills/npc-moneyhand`; user: `~/.codebuddy/skills/npc-moneyhand` | `/npc-moneyhand` or a matching natural-language task, subject to its shell approval. |
| Tencent WorkBuddy | In the desktop Skills panel, choose Add Skill and import the local Skill package; Tencent does not publish one cross-edition filesystem root. | Select the installed Skill or ask for MoneyHand, subject to local-file and process permissions. |
| Hermes Agent | User tree: `~/.hermes/skills/npc-moneyhand` (a category level is also supported) | Start a new session, then use `/npc-moneyhand` or ask Hermes to load it. |
| Pi | User: `~/.pi/agent/skills/npc-moneyhand` or shared `~/.agents/skills/npc-moneyhand`; project: `<repo>/.pi/skills/npc-moneyhand` or `<repo>/.agents/skills/npc-moneyhand` | `/skill:npc-moneyhand`, or launch with `pi --skill <absolute-skill-path>`. |
| OpenClaw | Workspace: `<workspace>/skills/npc-moneyhand`; shared: `~/.openclaw/skills/npc-moneyhand` or `~/.agents/skills/npc-moneyhand` | `openclaw skills install <absolute-skill-directory> --as npc-moneyhand`; add `--global` for the shared managed root. |

These routes make the Skill discoverable; they do not bypass each host's trust, sandbox, executable,
or shell-approval policy. Review the folder as local code before enabling execution.

## Dsh and other hosts

Tencent WorkBuddy documents local Skill import through its UI, but not one filesystem root or one
shell policy shared by every edition. Do not invent a private WorkBuddy directory. `Dsh` is not one
unambiguous, documented Agent product name, so do not claim automatic discovery for it either.

Use the generic handoff whenever a host has no verified native Agent Skills route:

1. Give the Agent the absolute path to the unpacked `npc-moneyhand` directory.
2. Tell it to read `<absolute-skill-path>/SKILL.md` and preserve relative references.
3. Require it to set that directory as its working directory and run the preflight and descriptor
   commands from the baseline above.
4. If it can maintain a child process, let it start the task-owned controller and communicate through
   the documented JSONL or ESM contract. Otherwise, a human or another local process must own the
   controller; text-only access is insufficient.
5. Keep browser installation, browser chrome, native dialogs, and permission prompts with the human.

This same handoff applies to WorkBuddy editions without local process execution, Dsh variants, and any
local Agent that can read files and execute Node.js, even if it has no Skill registry. It does not
claim that every named Agent is available on every operating system; it claims that the MoneyHand
folder and controller are host-neutral wherever those runtime capabilities exist.

## Official references

- Codex Skills: <https://developers.openai.com/codex/skills>
- Claude Code Skills: <https://code.claude.com/docs/en/slash-commands>
- Tencent CodeBuddy Code Skills: <https://www.codebuddy.cn/docs/cli/skills>
- Tencent WorkBuddy Skills: <https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market>
- Hermes Agent, Working with Skills: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md>
- Pi Skills: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md>
- OpenClaw Skills: <https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md>
- Open Agent Skills specification: <https://agentskills.io/specification>
