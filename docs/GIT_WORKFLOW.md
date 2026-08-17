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

## 回滚

发布历史使用 `git revert`，不重写 `main`：

```powershell
git revert <commit>
```

查看旧版本使用 detached worktree，避免覆盖当前更改：

```powershell
git worktree add ..\npc-moneyhand-old <tag-or-commit>
```

当前 1.x 安全硬化工作另存于本地 named stash。应用前先在独立分支确认内容；不要在脏工作树上直接 pop。

Git 提交身份必须由仓库所有者配置。开发代理不会猜测 user.name 或 user.email。
