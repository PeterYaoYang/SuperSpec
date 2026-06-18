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
2. 执行返回的命令（next_command / required_job / ask_user）
3. 登记结果
4. 回到 1

next 返回 `ask_user` 说明 discovery 不完整或有未确认问题——向用户提问，收到回答后 `superspec record user-decision --change "<change>" --input <FILE>`。

## 本阶段做什么

1. **建立事实基线**：读代码、查架构、理解当前系统行为（只读）
2. **写 discovery.md**：当前系统怎么工作 + 需要改什么 + 风险边界 + 开放问题（用 `- [ ]` 标记未确认项）
3. **澄清歧义**：有阻塞歧义时向用户提问，收到回答后 record user-decision

## Guardrails

- 不改业务代码
- 不写 proposal/specs/design/tasks
- 不跳过 transition 直接编辑状态文件
- 用户未确认的决策不自行推断
