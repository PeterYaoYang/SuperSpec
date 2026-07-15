---
name: superspec-apply
description: "在 SuperSpec Apply 阶段按已批准的 tasks 实现代码并登记真实验证。适用于逐 task 开始、实现、测试和完成。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

按当前 change 的已批准 task 完成小范围实现和真实验证。Apply 只执行已批准计划，不把发现的新需求悄悄带进代码。

## 工作方式

运行 `superspec transition next --change "<change>"`，只执行当前返回的 task、确认、修复或审查事项。开始 task 后，以 task-start 生成的执行快照、写入范围和停止条件为唯一执行契约；不要从 Skill、风险名称或历史经验推断 RED/GREEN。引擎按所选模式冻结并要求验证步骤。

每个 task 使用同一循环：

1. 对照 task 的执行依据，确认要实现的行为、边界和相关测试仍与当前计划一致。
2. 执行 `next` 返回的 task-start 命令，阅读本次尝试的执行快照。
3. 在授权范围内实现最小改动；不要提前运行 change-level review 或修改计划材料。
4. 仅按快照要求执行验证，并用引擎返回的命令登记真实测试结果。测试失败、环境失败和未覆盖目标测试的结果都如实登记。
5. 使用 `task-complete` 完成 task；本 task 的局部、可解释连带改动需要时按返回契约登记范围扩大说明。

不要手改 checkbox、证据或推进结果。

## 何时停止

发现新的用户可见行为、验收、业务规则、影响范围，或发现计划中的数据来源、边界和实现路线不再成立时，停止实现并交回 propose 更新计划。能由当前 task 的引用链直接解释的局部连带改动可以继续；原因不明的扩展不能静默带入。

范围扩大说明只能解释仍服务于当前 task 的局部连带改动，不能掩盖新增能力、改变验收、兼容策略或规范语义。用户在 apply 期间补充这些内容时，先回计划材料处理，再继续实现。

## Guardrails

- 只改当前 task 授权范围内的实现和测试文件。
- 不修改计划材料、`.superspec/**`、审查报告或正式证据。
- 不代替 code-reviewer、verifier 或状态机作流程判断。
