---
name: superspec-archive
description: "5.所有审查和验证通过后用：把完成的 change 归档到 specs，并确认关键证据和历史没有丢失；这一步是流程收尾。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Archive

## 语言规则 / Language

- 默认使用简体中文撰写所有人类可读产物、分析、报告、说明和 OpenSpec 文档正文。
- 保留命令、路径、JSON 字段、gate 名、task/test id、代码标识符和外部 API 名称的原文。
- 当 OpenSpec 模板要求固定标题或字段时，保留模板结构，只将正文内容写成中文。
- 对话窗口里的解释、确认、总结和下一步说明必须使用中文；除命令、路径、字段名、代码标识符外，不要夹带英文说明词。
- 对话窗口、AskUserQuestion 文案、进度更新和最终总结不得裸露内部证据种类、字段名或 reason code；用户确认记录、审查问题记录、审查轮次编号、问题唯一标识等都只用中文业务说法。原始协议名只允许写在证据 JSON、代码、测试、精确命令输出或用户明确要求的诊断片段中。
- 本 skill 文档中的内部协议名只用于落盘证据或运行 guard；写给用户时必须先翻译成中文业务动作，例如“记录用户确认”“记录审查问题”“完成最终审查判断”。
- 向用户转述 guard / archive 输出时，不要直接贴英文 `message`、`next_allowed_actions` 或英文模板标题；应改写为中文，并仅在需要定位内部协议时保留英文 code/command 于反引号中。

## 命令执行 / Shell

- Windows PowerShell 中执行 npm 全局 bin 时，必须显式使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- macOS、Linux、Git Bash、cmd.exe 或其他不会优先拦截 `.ps1` 的 shell 中，继续使用文档中的 `superspec ...`、`openspec ...` 命令。

## 上下文读取纪律 / Context Budget

- guard 可以在本地读取完整 `.superspec/evidence/**/*.json` 并重算 archive 判定；主流程默认不要打开完整 evidence JSON，除非正在排查 guard block、修复 preservation manifest，或用户明确要求诊断原文。
- 主流程默认只读取 guard decision、archive preservation 摘要、OpenSpec archive 输出摘要，以及最终验证 archive 结果所需的最小 manifest 信息。
- raw log、长报告和历史 superseded evidence 默认只作为引用、hash 或摘要保留；不要把全文复制进对话上下文或新的 evidence。

仅在 `review_complete` passes（其中已经包含 final verification）后使用本 skill。

## 边界 / Boundaries

- 通过 native CLI 桥接 OpenSpec archive，不手动重实现 archive。可以读取 repo-local `.codex/skills/openspec-archive-change/SKILL.md` 来获取 selection/status guardrails，但其中手动 `mkdir`/`mv` archive procedure 在这里由 `openspec archive` 取代。
- Archive 仍是 native `openspec archive`：它会移动 change、**更新 main specs（delta->main sync）**，并默认 **validates**。当前 SuperSpec v1 固定使用 `openspec archive -y "<change>"`，不暴露 `--skip-specs` 分支，且不允许 `--no-validate`。
- SuperSpec 只检查 `archive_ready` 和 archived sidecar preservation；不重新实现移动、spec sync 或 validation。
- preservation manifest 必须覆盖 `.superspec/artifacts/business-invariants.md`、`.superspec/artifacts/test-contract.md`、`.superspec/evidence/invariants/`、`.superspec/evidence/test-contract/`、RED/GREEN evidence、review/verification evidence，以及 archive evidence 本身。
- v1 archive control 通过显式 guard checks 和 preservation verification 执行。

## 步骤 / Steps

1. 对 `archive_ready` 最终确认使用 AskUserQuestion，等待明确选择。记录 archive-scoped human-confirmation evidence。当前 v1 不询问也不使用 `--skip-specs`；若 change 不应同步 specs，应先回到 propose/change update 调整 OpenSpec 包，而不是在 archive 阶段跳过。
2. 检查 archive readiness 并生成 preservation manifest：
   ```text
   superspec guard check-archive-ready --change "<change>"
   ```
   生成的 manifest 是 archive 前证据快照，必须能追踪 business-invariants、test-contract 和对应 invariant review evidence 的 sha256。
3. 运行 native OpenSpec archive（移动 change、同步 delta->main specs、执行 validation）：
   ```text
   openspec archive -y "<change>"
   ```
4. 根据 manifest 验证 archived `.superspec/` preservation：
   ```text
   superspec guard check-archived --change "<change>"
   ```

遇到任何 guard `block` 就停止。
