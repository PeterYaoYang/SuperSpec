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

如果 next 返回用户确认、审查或验证事项，停止当前 apply 推进，并按 next 交给对应工作项或用户确认处理。处理完成前不要继续下一个 task，也不要进入下一阶段；任务完成时说明改动、RED/GREEN 或 no-TDD 证据和下一步；发现范围、验收或用户可见行为变化时，停止实现并说明要回 propose。

## 普通 task 执行

只执行 `tasks.md` 中顶格 checkbox 行里的 `<task_id>`，例如 `1.1` 或 `TASK-001.1`。Markdown 标题只是分组；普通 bullet 只是说明，不单独成为工作流执行单元。

每个 task 的标准循环：

1. **计划核对**：执行 `task-start` 前，确认当前 task 是 `tasks.md` 顶格任务，并能对应 `design.md` 的实现方向和 `proposal.md` 的 `## Impact` 受影响原因。缺少映射、需要新增能力/验收/影响范围时先停止，交回 propose，不写 RED。
2. **任务开始**：`superspec transition task-start --change "<change>" --task <task_id>`。
3. **读取 attempt_id**：从 task-start 返回结果或当前活跃 task attempt 中读取。
4. **RED**：写测试前确认测试意图能对应 `test-contract.md` 的 `test_id` 或 `business-invariants.md`；缺少对应关系时先停止，交回 propose。运行后确认失败，并用 `superspec record test-run --change "<change>" --input -` 登记。
5. **实现**：根据任务写代码，保持范围小。`design.md` 不锁死字段名、函数名、SQL 或局部写法。
6. **GREEN**：运行测试确认通过，并登记 test-run。
7. **完成 task**：`superspec transition task-complete --change "<change>" --task <task_id>`。

no-TDD 任务（`tdd_required:false` + `no_tdd_reason`）跳过 RED/GREEN，但仍必须有清楚的完成证据。

`tasks.md` 不写 RED/GREEN 命令、断言或预期输出。RED/GREEN 的真实证明来自 apply 阶段实际执行后登记的 `record test-run`。

如果 task id 以 `REVIEW-FIX-` 开头，或任务行带 `review_fix_of:<job_id>#<problem_id>`，把它当作普通 task 执行，不另起流程。它只表示该任务来自代码审查问题：实现范围只限对应问题；RED 或 characterization 要证明问题存在，GREEN 要证明问题已修复；完成前还要登记已完成任务的 GREEN 回归，或等价更大范围回归。修复中发现计划文档需要变化时，停止扩大实现，交回主流程处理。

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
- `covers_task_ids` 可选，只在回归或等价场景中填写到同一份 test-run JSON，用来说明这次测试覆盖了哪些已完成任务；省略表示不声明覆盖关系。
- `command`、`cwd`、`exit_code` 和目标测试身份必须能说明目标测试确实运行。
- 退出码本身不等于证明；环境错误或构建失败不算 RED 或 GREEN。
- 缺少 `attempt_id`、只靠 `task_structure_digest` 匹配的 test-run 只能作为弱引用，不作为强证明。
- 其他可选字段只有在有明确来源时再填；不要为通过校验编造。

## Guardrails

- 只改当前 task 范围相关的实现或测试文件。
- 需要判断影响范围或改动原因不自明时，参考 `proposal.md` 的 `## Impact`，但不要把它当作路径白名单。
- 编码时发现未列入影响范围的文件，如果从 diff 或引用链能直接解释为同一任务下的局部引用、测试辅助或机械连带改动，可以继续。
- 如果发现新增能力、用户可见行为、明显新增影响范围或原因不自明，停止扩大实现并报告给主流程；不要在 apply 阶段补改 `proposal.md`。
- 用户在 apply 期间或 apply 后补充最新业务规则、产品口径、验收标准、示例规范、兼容策略、影响范围，或说明需求源已更新时，停止实现并交回主流程使用 `superspec-propose` 更新计划文档；交回时说明变化来源、变化内容、影响范围和建议处理方式。
- 不修改 `proposal.md`、`design.md`、`specs/**` 或 `.superspec/**`。
- active attempt 期间不要修改 `tasks.md` 中除 `task-complete` 自动勾选目标 checkbox 外的内容。
- 不跳过 RED 直接写 GREEN。
- 不手改 tasks.md 复选框；`task-complete` 会自动补丁。
- 不跳过 transition。
