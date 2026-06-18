---
name: superspec-propose
description: "调用 superspec transition next 获取下一步命令并执行。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec 计划

## 唯一规则

你不再携带工作流协议。所有状态由 transition engine 管理。

循环：

1. 跑 `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令（next_command / required_job packet / ask_user）
3. 登记结果（`superspec record ...`）
4. 回到 1

## 命令参考

- **查下一步**：`superspec transition next --change "<change>"`
- **提交流转**：`superspec transition <命令> --change "<change>"`（如 explore / propose-ready / start-apply / task-start / task-complete / review-ready / accept / archive）
- **登记结果**：`superspec record job-submit --change "<change>" --job <JOB> --report <FILE>`
- **登记测试**：`superspec record test-run --change "<change>" --input <FILE>`
- **登记决策**：`superspec record user-decision --change "<change>" --input <FILE>`
- **查状态**：`superspec status --change "<change>"`

## 语言

默认简体中文写人类可读内容；命令、路径、字段名保留原文。
