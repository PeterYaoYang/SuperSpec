---
name: superspec-explore
description: "1.新需求刚开始时用：先把目标、范围、风险和现有代码事实弄清楚，产出探索记录（`discovery.md`）；这一步只探索，不写正式方案，也不改代码。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Explore

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、字段名、阶段门名、task/test id、代码标识符保留原文。
- 用户可见文案不得使用“裁决”描述用户动作；统一说“确认”“范围取舍”“处理方式选择”或“用户确认记录”。
- 不把内部证据种类、reason code、JSON 字段大全直接转述给用户；需要诊断时才引用原文。
- 普通 workflow 命令使用 `--format agent`；`--format json` 只用于诊断，不作为默认上下文。

## 命令执行 / Shell

- Windows PowerShell 中使用 `.cmd` shim：`superspec.cmd ...`、`openspec.cmd ...`；不要运行 `superspec.ps1` 或 `openspec.ps1`。
- 其他 shell 使用文档中的 `superspec ...`、`openspec ...` 命令。

## 阶段职责

Explore 只做需求澄清、代码事实调查、范围边界和风险记录。产物是 `openspec/changes/<change>/.superspec/artifacts/discovery.md`；不写 `proposal.md`、`specs/**`、`design.md`、`tasks.md`，也不改实现代码。

## 产物格式

- discovery.md 必须按 SuperSpec discovery 模板的结构填写，保留全部段落：`调查范围` / `现有实现事实` / `隐性合约` / `风险与歧义` / `待确认问题` / `Subagent Evidence`；不得自创或删减段落骨架。
- 第一条必跑命令 `superspec check workflow-packet --change "<change>" --gate explore_complete --format agent` 的返回里带 `discovery_template` 与 `discovery_rules`：按其中的模板骨架和填写规则产出，而不是自由发挥，这样无论哪个模型产物结构都一致。

## 第一条必跑命令

```text
superspec init --scope project --format agent
```

随后创建或打开 OpenSpec change，并读取当前上下文：

```text
openspec list --json
openspec status --change "<change>" --json
superspec check check-init --change "<change>" --format agent
superspec check workflow-packet --change "<change>" --gate explore_complete --format agent
```

遇到 `block` 就停止，按检查结果的下一步提示处理；不要绕过检查。

## OpenSpec 边界

- 直接使用 OpenSpec CLI surface，不读取 repo-local `openspec-*` skill 文本。
- 用 `openspec list --json` 和 `openspec status --change "<change>" --json` 确认 change 结构、artifactPaths 和当前状态。
- OpenSpec 负责 change 结构和后续 artifact 语义；本阶段只补 SuperSpec discovery 证据。
- 如果发现需要正式方案、规格、设计或任务，先写入 discovery，再交给 `superspec-propose`。

## 专用代理边界

需求审查由本仓库的 `critic` 专用代理完成。生成审查提示时使用检查命令的输出，而不是把披露协议常驻在 skill 正文：

```text
superspec check review-packet --change "<change>" --gate explore_complete --role critic --round 1 --format prompt
```

主流程整理审查问题时读取主线程提示信息：

```text
superspec check review-packet --change "<change>" --gate explore_complete --role main-thread --round 1 --format agent
```

第二轮及以后的审查，必须由检查命令把上一轮的问题注入提示；不要手写历史问题清单。

## 用户确认边界

- 关键范围、非目标、验收标准、业务语义或设计边界问题必须面向用户说明并等待明确确认。
- 探索结论、范围边界和进入 propose 的授权必须等待用户确认后再记录 evidence。
- discovery.md 必须含 `## 待确认问题` 段（标题含「确认」字样即可，如「待确认问题」「需要用户确认的问题」）。每条问题用 `- [ ]`（未决）或 `- [x]`（已确认）标记；也可在已确认项写「已确认：」。**该段只要还有 `- [ ]` 或「仍需确认/待确认」项，`explore_complete` 检查就不会通过**，不得记录人工确认，也不得进入 propose。
- 用户看到的文字要用中文业务语言；内部 JSON 名只写进证据、命令输出或诊断片段。

## 完成检查

```text
superspec check workflow-packet --change "<change>" --gate explore_complete --format agent
```

只有检查结果显示通过后，才进入 `superspec-propose`。
