---
name: superspec-apply
description: "三.按 tasks.md 逐任务实现代码，并按要求完成红/绿验证"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

你是执行阶段。目标是按 `tasks.md` 的可执行 task 完成实现：先 RED，再 GREEN，然后用 `task-complete` 标记完成。

## 驱动方式

所有状态由工作流引擎管理，按这个循环执行：

1. `superspec transition next --change "<change>"` 获取下一步。
2. 执行返回的命令。
3. 登记结果。
4. 回到第 1 步。

如果 next 返回用户确认、审查或验证事项，停止当前 apply 推进，并按 next 交给对应工作项或用户确认处理。处理完成前不要继续下一个 task，也不要进入下一阶段。对用户说明时使用自然语言，不默认复述内部 JSON 字段或完整工作项说明。

## 普通 task 执行

只执行 `tasks.md` 中顶格 checkbox 行里的 `<task_id>`，例如 `1.1` 或 `TASK-001.1`。Markdown 标题只是分组；普通 bullet 只是说明，不单独成为工作流执行单元。

每个 task 的标准循环：

1. **设计核对**：执行 `task-start` 前，确认本任务符合 `design.md` 的实现方向。缺少方向时先停止，不写 RED。
2. **任务开始**：`superspec transition task-start --change "<change>" --task <task_id>`。
3. **读取 attempt_id**：从 task-start 返回结果或当前活跃 task attempt 中读取。
4. **RED**：写测试，运行后确认失败，并用 `superspec record test-run --change "<change>" --input -` 登记。
5. **实现**：根据任务写代码，保持范围小。`design.md` 不锁死字段名、函数名、SQL 或局部写法。
6. **GREEN**：运行测试确认通过，并登记 test-run。
7. **完成 task**：`superspec transition task-complete --change "<change>" --task <task_id>`。

no-TDD 任务（`tdd_required:false` + `no_tdd_reason`）跳过 RED/GREEN，但仍必须有清楚的完成证据。

`tasks.md` 不写 RED/GREEN 命令、断言或预期输出。RED/GREEN 的真实证明来自 apply 阶段实际执行后登记的 `record test-run`。

## 审查修复任务

代码审查发现纯实现问题后，主流程会通过 `reopen --to apply --review-fix <job_id>#<problem_id>` 回到 apply，并由引擎追加审查修复任务。

审查修复任务的 task id 格式为 `REVIEW-FIX-<job_id>#<problem_id>`。任务行里的 `review_fix_of:<job_id>#<problem_id>` 是机器追溯标记，只用于让最终验证找到对应的代码审查问题；它不是新需求。

执行审查修复任务时：

- 只修对应代码审查问题，不扩大需求或方案范围。
- 仍执行 `task-start`、RED/characterization、GREEN、`task-complete`。
- RED 应证明该问题在修复前确实存在；无法写 RED 时，必须有等价 characterization 证据。
- GREEN 应证明该问题已修复。
- 完成前必须跑所有已完成任务的 GREEN 回归，或等价更大范围回归。
- 回归也必须通过 `record test-run` 登记，并说明覆盖了哪些已完成任务。

如果修复过程中发现 proposal/design/tasks/test-contract 本身需要变化，停止扩大实现，向主流程报告需要回 propose；不要在 apply 阶段直接改计划文档。

## test-run 输入

`record test-run` 优先从 stdin 登记 JSON：

```json
{
  "test_id": "TEST-XXX",
  "attempt_id": "ATT-TASK-XXX-...",
  "task_structure_digest": "<当前 task 结构版本>",
  "command": "npm test",
  "cwd": "<工作目录>",
  "exit_code": 1,
  "semantic_status": "expected_failure"
}
```

证据规则：

- `record test-run` 入库至少需要 `test_id` 和 `task_structure_digest`；RED/GREEN 完成判定优先核对当前 `attempt_id`。
- `attempt_id` 来自当前 task attempt；新产生的 TDD 证据必须带当前 `attempt_id`。
- `semantic_status` 使用 `expected_failure`（RED）/ `expected_success`（GREEN）/ `characterization_pass`。
- `command`、`cwd`、`exit_code` 和目标测试身份必须能说明目标测试确实运行。
- 退出码本身不等于证明；环境错误或构建失败不算 RED 或 GREEN。
- 缺少 `attempt_id`、只靠 `task_structure_digest` 匹配的 test-run 只能作为弱引用，不作为强证明。
- 其他可选字段只有在有明确来源时再填；不要为通过校验编造。

## Guardrails

- 只改当前 task 范围相关的实现或测试文件。
- 需要判断影响范围或改动原因不自明时，参考 `proposal.md` 的 `## Impact`，但不要把它当作路径白名单。
- 编码时发现未列入影响范围的文件，如果从 diff 或引用链能直接解释为同一任务下的局部引用、测试辅助或机械连带改动，可以继续。
- 如果发现新增能力、用户可见行为、明显新增影响范围或原因不自明，停止扩大实现并报告给主流程；不要在 apply 阶段补改 `proposal.md`。
- 用户在 apply 期间或 apply 后补充最新业务规则、产品口径、验收标准、示例规范、兼容策略或影响范围时，停止实现并交回主流程使用 `superspec-propose` 更新计划文档。
- 不修改 `proposal.md`、`design.md`、`specs/**` 或 `.superspec/**`。
- active attempt 期间不要修改 `tasks.md` 中除 `task-complete` 自动勾选目标 checkbox 外的内容。
- 不跳过 RED 直接写 GREEN。
- 不手改 tasks.md 复选框；`task-complete` 会自动补丁。
- 不跳过 transition。
