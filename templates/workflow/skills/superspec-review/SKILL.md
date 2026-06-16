---
name: superspec-review
description: "4.代码任务做完后用：让 reviewer、architect 和 critic 检查实现，跑最终验证，判断能不能进入归档；有问题就退回修。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Review

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、字段名、阶段门名、task/test id、代码标识符保留原文。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 不把内部证据种类、reason code、JSON 字段大全直接转述给用户；需要诊断时才引用原文。
- 普通 workflow 命令使用 `--format agent`；`--format json` 只用于诊断，不作为默认上下文。

## 命令执行 / Shell

- Windows PowerShell 中使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- 其他 shell 使用文档中的 `superspec ...`、`openspec ...` 命令。

## 阶段职责

Review 合并实现审查、架构审查、SuperSpec critic、final verification 和主线程最终判断。旧 `superspec-verify` / `check-verify-ready` 只是兼容入口，不是独立 user-visible workflow。

## 第一条必跑命令

```text
superspec check check-init --change "<change>" --format agent
```

然后检查 review readiness：

```text
superspec check check-review-ready --change "<change>" --format agent
```

遇到任何返回状态为 `block` 就停止。review 不直接回改 `tasks.md` checkbox。

## 专用代理边界

Review 必须使用本仓库安装的 repo-local native agents（专用代理），不要调用全局 `$code-review`、OMX workflow、主线程自审或普通 markdown 报告替代。

必需入口：

- `.codex/agents/code-reviewer.toml` / `.codex/prompts/code-reviewer.md`
- `.codex/agents/architect.toml` / `.codex/prompts/architect.md`
- `.codex/agents/critic.toml` / `.codex/prompts/critic.md`
- `.codex/agents/verifier.toml` / `.codex/prompts/verifier.md`

每个审查提示都先由检查命令产出：

```text
superspec check review-packet --change "<change>" --gate review_complete --role code-reviewer --round 1 --format prompt
superspec check review-packet --change "<change>" --gate review_complete --role architect --round 1 --format prompt
superspec check review-packet --change "<change>" --gate review_complete --role critic --round 1 --format prompt
```

## Final Verification 边界

只在 allow 评估路径运行 final verification：

```text
openspec validate "<change>"
```

然后执行 test contract 要求的最终测试，启动本仓库 `verifier` 和 `critic` 做验证审查。验证提示也必须由检查命令产出：

```text
superspec check review-packet --change "<change>" --gate review_complete --role verifier --round 1 --format prompt
superspec check review-packet --change "<change>" --gate review_complete --role critic --round 1 --kind verification_review --format prompt
```

verification 只提供 proof/gap，不替代主流程最终判断。

## 主线程最终判断边界

主线程写最终判断前读取：

```text
superspec check review-packet --change "<change>" --gate review_complete --role main-thread --round 1 --format agent
```

`review_complete` 是只允许通过的阶段检查。通过路径由主线程写本轮审查结论（主线程直接写，不携带代理字段）。

`request_changes` 不是 review_complete allow。它必须写清 `request_changes_route`：

- `reopen_tasks`：回 `superspec-apply` 修复既有 task。
- `change_update`：回 propose/change update。

request-changes round 不生成 allow-path verification，也不调用 `check-review-complete`。

## 完成检查

仅 allow path 运行：

```text
superspec check workflow-packet --change "<change>" --gate review_complete --format agent
```

只有检查结果显示通过后，才进入 `superspec-archive`。
