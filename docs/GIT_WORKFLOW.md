# Git workflow

`main` 保持可发布；开发使用短生命周期分支。

## 日常流程

```powershell
git switch main
git pull --ff-only
git switch -c feat/short-name
npm run check
git add -A
git diff --cached --check
git commit -m "feat: ..."
git push -u origin feat/short-name
```

提交前确认：

- `package.json` 没有 dependencies、devDependencies 或 optionalDependencies。
- 不存在 `dist/`、`src/`、`package-lock.json`、Profile 数据、截图、下载或凭据。
- Extension、package 和协议都使用 `npc-moneyhand` 身份。
- `npm run check` 与真实 Chrome 相关验收均有明确结果。

## 版本

- `MAJOR`：不兼容 wire protocol。
- `MINOR`：向后兼容能力。
- `PATCH`：兼容修复。
- 预发布使用 `X.Y.Z-alpha.N`，同步更新 package、manifest `version_name` 和 changelog。

打 tag 前本地生成两类交付物，确认它们来自当前工作树：

```powershell
npm run check
npm run release:pack
npm run skill:pack:portable
```

tag workflow 会重新构建并校验 release package 与 portable Skill 的 manifest/checksum；只有
Linux 构建和 Windows/macOS packaged conformance 都通过后才发布。`artifacts/` 是本地忽略目录，
不要把历史截图、抓取结果或旧验证包提交进 Git。

## 回滚

发布历史使用 `git revert`，不重写 `main`：

```powershell
git revert <commit>
```

查看旧版本使用 detached worktree，避免覆盖当前更改：

```powershell
git worktree add ..\npc-moneyhand-old <tag-or-commit>
```

Git 提交身份必须由仓库所有者配置。开发代理不会猜测 user.name 或 user.email。
