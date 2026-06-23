---
name: superspec-explore
description: "一.探索现状、澄清范围"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Explore

你是探索阶段。职责：调查现状、梳理范围、识别风险，把结果沉淀到 `discovery.md`。不写业务代码，不提前写 proposal/specs/design/tasks。

## 驱动方式

所有状态由工作流引擎管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

next 返回 `ask_user` 说明 discovery 不完整或有未确认问题。若 scope 是 `explore_discovery`，先检查并填写 discovery 草稿，不要把草稿占位内容直接转问用户；只有真实阻塞问题才向用户提问，收到回答后优先用 `superspec record user-decision --change "<change>" --input -` 从 stdin 登记 JSON 内容；文件路径模式仍可作为 fallback。

本技能默认走完整审查路径。探索完成后，`explore → propose` 会先创建 `critic` 工作项，由 Critic 角色审查需求澄清记录。审查完成后优先通过 `superspec record job-submit --change "<change>" --job <JOB> --report -` 从 stdin 登记 JSON 报告内容；文件路径模式仍可作为 fallback。

## 本阶段做什么

1. **建立事实基线**：读代码、查架构、理解当前系统行为（只读）
2. **写 discovery.md**：首次进入 explore 时引擎可能已创建草稿；必须用真实事实替换草稿标记和占位内容
3. **澄清歧义**：有阻塞歧义时向用户提问

## 探索分工

主会话负责广度：理解用户需求、提出探索问题、汇总 discovery、判断哪些问题必须问用户。

涉及多个文件、模块、入口或文件类型时，使用 `explore` subagent 做只读深扫。以下情况也应使用：

- 当前行为不清楚
- 涉及状态机、公共 API、数据格式、测试策略、权限、迁移或发布流程
- 影响范围可能大于用户表述

可跳过 subagent 的场景：

- 纯文档
- 明显 typo
- 单文件机械小修
- 明确无代码影响的需求

跳过时在 discovery 中说明原因。`explore` subagent 只输出代码/文档事实、文件行号锚点、隐性约束、影响范围候选、风险和需要主流程确认的问题；不写方案、不写业务代码、不替主流程做决策。

## discovery.md 格式

写入 `openspec/changes/<change>/.superspec/artifacts/discovery.md`：

如果文件已经存在并包含 `<!-- superspec:discovery-draft -->` 或“待探索后...”占位文本，说明它是引擎生成的草稿。完成探索后必须删除草稿标记并替换所有占位内容，否则引擎会继续阻止推进。

```markdown
# Discovery

## 当前代码事实
- src/path.ts:10 当前系统怎么工作

## 需求理解
（用户目标和当前实现之间的差异）

## 影响范围候选
- src/path.ts:10 可能受影响的代码表面和相邻风险

## 风险和边界
（技术风险、依赖、兼容性；尽量绑定代码或文档锚点）

## 待确认问题
- [ ] 问题1的描述
- [ ] 问题2的描述
```

**重要**：`- [ ]` 标记的待确认问题必须全部解决（用户确认后改为 `- [x]` 或删除），否则工作流引擎会阻止推进到 propose。
只有 `## 待确认问题` 段落内的 `- [ ]` 表示阻塞确认项。其他段落列事实、风险或影响范围时使用普通 bullet，不要用 checklist。

代码影响型需求的 `当前代码事实`、`影响范围候选`、`风险和边界` 应尽量包含 `path:line` 锚点。纯文档、配置或新文件任务没有代码锚点时，写明 `N/A` 理由并引用相关文档、配置或需求来源。

## Guardrails

- 不改业务代码
- 不写 proposal/specs/design/tasks
- 不跳过 transition 直接编辑状态文件
- 用户未确认的决策不自行推断
- 完整审查路径下不跳过 `critic` 角色审查
