# 贡献指南

本项目采用基于 PR 的协作流程。所有改动都通过短命特性分支提交到受保护的 `main`，经 CI 与 Code Review 通过后合并。

## 分支模型

- `main` 为受保护分支，禁止直接 push，只能通过 PR 合并。
- 每个改动从最新 `main` 切一条**短命特性分支**，命名格式：`<类型>/<简述>`。
- 分支生命周期尽量短，合并后立即删除。

```bash
git switch main
git pull --ff-only
git switch -c feat/council-ppc-gate
```

类型与 Conventional Commits 的 type 保持一致（见下）。

## 提交信息（Conventional Commits）

格式：

```
<type>(<scope>): <subject>

<body 可选>

<footer 可选，如 Closes #123>
```

允许的 type：

| type       | 用途                   |
| ---------- | ---------------------- |
| `feat`     | 新功能                 |
| `fix`      | 修复 bug               |
| `docs`     | 文档变更               |
| `refactor` | 重构（非功能、非修复） |
| `test`     | 测试相关               |
| `chore`    | 杂项（依赖、脚手架等） |
| `build`    | 构建系统或外部依赖     |
| `ci`       | CI 配置与脚本          |

示例：

```bash
git commit -m "feat(council): 增加 PPC 阈值熔断器"
git commit -m "fix(memory): 修复 mailbox 并发写入丢失"
```

## PR 规范

- **小而聚焦**：单个 PR 改动控制在 **< 400 行**，只做一件事。
- **关联 Issue**：在 PR 描述里写 `Closes #<issue>`，合并后自动关闭对应 Issue。
- **本地先验证**：提 PR 前在本地跑通校验。

  ```bash
  pnpm verify
  ```

- **改契约要 @ 依赖方**：修改公共接口 / 类型 / 协议时，在 PR 中 @ 受影响的方向负责人（参见 `.github/CODEOWNERS`）。

## Code Review 规范

- Reviewer 在 **24 小时内**给出首次反馈。
- 合并前至少需要 **≥1 个 approve**。
- 评论区分级别：
  - **blocking**：必须解决才能合并（正确性、契约、安全问题）。
  - **nit**：建议性优化，作者可自行决定是否采纳。

## 合并策略

- 以 **Squash merge** 为主，保持 `main` 历史线性整洁。
- 合并前先 **rebase 到最新 `main`**，解决冲突并确保 CI 绿。

  ```bash
  git switch main
  git pull --ff-only
  git switch feat/council-ppc-gate
  git rebase main
  ```

- 合并后**删除特性分支**（远端与本地）。

  ```bash
  git branch -d feat/council-ppc-gate
  git push origin --delete feat/council-ppc-gate
  ```

## 完整闭环（8 步）

1. **认领 Issue**：在 issue 列表挑选并 assign 给自己。
2. **切分支**：从最新 `main` 切 `<类型>/<简述>` 短命分支。
3. **写码 + 测试**：实现功能并补齐测试，提交遵循 Conventional Commits。
4. **push**：将分支推送到远端。
5. **开 PR**：填写描述，写 `Closes #<issue>`，@ 受影响依赖方。
6. **CI + review**：等待 CI 通过并获得 ≥1 approve，处理 blocking 评论。
7. **squash merge**：rebase 到最新 `main` 后 squash 合并。
8. **Issue 自动关闭**：合并触发 `Closes #<issue>`，删除特性分支，闭环完成。
