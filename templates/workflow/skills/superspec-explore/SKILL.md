---
name: superspec-explore
description: "探索现状、澄清范围、维护 discovery.md；通过 transition/record 把 change 从 init 推进到 propose。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Explore

你是探索阶段。职责：调查现状、梳理范围、识别风险，把结果沉淀到 `discovery.md`。不写业务代码，不提前写 proposal/specs/design/tasks。

## 驱动方式

所有状态由 transition engine 管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

next 返回 `ask_user` 说明 discovery 不完整或有未确认问题——向用户提问，收到回答后 `superspec record user-decision --change "<change>" --input <FILE>`。

当前 CLI surface：

- 用 `openspec list --json` 和 `openspec status --change "<change>" --json` 建立 OpenSpec 事实基线。
- 用 `superspec transition explore --change "<change>"` 从 init 进入探索阶段。
- 用户回答阻塞问题后，写入决策文件并执行 `superspec record user-decision --change "<change>" --input <decision.json>`。
- 不要把 `superspec status` 的 job 计数当成权威事实；阶段推进以 transition / record 返回值和 OpenSpec 文档为准。

## 本阶段做什么

1. **建立事实基线**：读代码、查架构、理解当前系统行为（只读）
2. **写 discovery.md**：
3. **澄清歧义**：有阻塞歧义时向用户提问

## discovery.md 格式

写入 `openspec/changes/<change>/.superspec/artifacts/discovery.md`：

```markdown
# Discovery

## 现状
（当前系统怎么工作）

## 需要改什么
（要实现的需求）

## 风险和边界
（技术风险、依赖、兼容性）

## 待确认问题
- [ ] 问题1的描述
- [ ] 问题2的描述
```

**重要**：`- [ ]` 标记的待确认问题必须全部解决。收到用户确认后，把对应未决项从 `- [ ]` 改成 `- [x]` 或删除；只留档、不回写 `discovery.md`，阶段还是过不去。

## Guardrails

- 不改业务代码
- 不写 proposal/specs/design/tasks
- 不跳过 transition 直接编辑状态文件
- 用户未确认的决策不自行推断
- 不要伪造当前分支没有的 `superspec check`
