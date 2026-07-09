# litvault 发布规范

这份文档定义 litvault 以后新增功能、修复问题、调整用户可见行为时的标准发布流程。

## 核心规则

只要有用户可见更新，就必须同时完成：

- 升级版本号。
- 提交到 GitHub。
- 创建 git tag。
- 发布 GitHub Release。

常规发布不走 PR。除非用户明确要求，否则不要创建 Pull Request；发布应直接提交、推送、打 tag，并发布 Release。

## 版本号规则

litvault 使用语义化版本：

- Patch：bug fix、校验逻辑修复、小的 CLI 行为改进、配套文档更新。
- Minor：新增命令、新增用户流程、兼容性的功能增加。
- Major：破坏性 CLI 行为变化、manifest 不兼容、删除命令、需要迁移的数据结构变化。

每次发布必须同步更新两个位置：

- `package.json` 里的 `version`
- `bin/litvault-node.js` 里的 `VERSION`

两个版本号必须完全一致。

## 发布前检查

发布前必须运行：

```bash
npm test
node bin/litvault-node.js --version
git diff --check
```

如果改动涉及 `update` 或安装发布逻辑，还要运行：

```bash
node bin/litvault-node.js update --check
node bin/litvault-node.js update --dry-run --force --ref vX.Y.Z
```

其中 `vX.Y.Z` 替换成即将发布的版本。

## 标准发布流程

从 `main` 开始，并确保本地是最新：

```bash
git switch main
git pull --ff-only origin main
```

完成代码或文档改动，然后升级版本号。

运行发布前检查：

```bash
npm test
node bin/litvault-node.js --version
git diff --check
```

检查最终变更范围：

```bash
git status --short
git diff --stat
```

直接提交到 `main`：

```bash
git add README.md README.en.md package.json bin/litvault-node.js test/smoke.js RELEASE_SPEC.md
git commit -m "Release vX.Y.Z"
```

优先使用明确文件路径。只有确认整个工作区都属于本次发布时，才可以使用 `git add -A`。

推送 `main`：

```bash
git push origin main
```

创建并推送 tag：

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

发布 GitHub Release：

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes-file RELEASE_NOTES.tmp.md
```

发布完成后删除临时 release notes 文件。

## Release Notes 要求

Release notes 面向用户，保持简洁，必须说明：

- 改了什么。
- 为什么改。
- 新增或改变了哪些命令、输出或行为。
- 是否需要用户执行迁移、清理或重新安装。
- 本次发布跑过哪些验证。

示例：

```markdown
## Summary

- Added invalid PDF detection during import and verification.
- Added `prune-invalid-pdfs` to preview and remove invalid PDF records.
- Bumped litvault to 0.1.24.

## Validation

- `npm test`
- `node bin/litvault-node.js --version`
- `git diff --check`
```

## 不走 PR 的约定

常规 litvault 发布：

- 不创建 PR。
- 不把发布停留在功能分支。
- 不只推分支、不打 tag。
- 不只打 tag、不发 GitHub Release。

如果已经误建 PR，但用户要求直接发布，应关闭 PR，切回 `main`，按本规范直接发布。

## 发布后验证

发布后确认 Release 和 tag 存在：

```bash
gh release view vX.Y.Z
git ls-remote --tags origin vX.Y.Z
```

确认指定版本可以安装并输出正确版本号：

```bash
npm install -g github:iihciyekub/litvault#vX.Y.Z
litvault --version
```

## 回滚和修复

如果 tag 或 Release 发错，且确认还没有用户安装：

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
gh release delete vX.Y.Z
```

然后修复问题，重新运行检查，重新创建 tag，并重新发布 Release。

如果该版本可能已经被安装，不要改写 tag。应发布新的 patch 版本。
