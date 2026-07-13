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

1. **计划核对**：执行 `task-start` 前，确认当前 task 是 `tasks.md` 顶格任务。task 带 `执行依据:` 块时，以它为主要执行上下文；没有执行依据的历史 task 对应 `design.md` 的实现方向和 `proposal.md` 的 `## Impact` 受影响原因。缺少映射、需要新增能力/验收/影响范围时先停止，交回 propose，不写 RED。
2. **任务开始**：执行 next 下发的 task-start 命令。
3. **读取执行依据快照**：task-start 的返回结果包含本次任务尝试 ID（`attempt_id`，登记测试时要用）和执行依据快照（五字段在启动时刻的定格版本）。返回结果带快照时，实现和验收以它为准；返回结果标明是历史任务（`legacy_contract`）时，即使 `tasks.md` 里有执行依据文本也不采纳为引擎契约，按原有方式回读 `proposal.md`、`design.md` 和 `test-contract.md`，test-run 走历史规则。
4. **RED**：执行依据声明了测试时，测试必须对应其中的 `TEST-xxx`（登记其他 TEST 会被拒绝）；没有执行依据的历史 task 确认测试意图能对应 `test-contract.md` 的 `test_id`，缺少对应关系时先停止，交回 propose。运行后确认失败，并用 `superspec record test-run --change "<change>" --input -` 登记。
5. **实现**：根据任务写代码，保持范围小。`design.md` 不锁死字段名、函数名、SQL 或局部写法。
6. **GREEN**：运行测试确认通过，并登记 test-run。执行依据声明多个测试时，每个声明 TEST 都要有 GREEN；普通 `tdd_required:true` task 还要求至少一个 TEST 形成同 TEST 先 RED 后 GREEN，其余可以只有 GREEN 作为回归覆盖。
7. **完成 task**：执行 next 下发的 task-complete 命令。实现中发现改动明显超出 `执行依据:` 的 `边界`、`设计` 或 task 描述暗示的影响范围、但仍服务于当前 task 时，在该命令后追加 `--input -` 登记范围扩大说明（见「范围扩大说明」一节）；范围扩大改变了用户可见能力、验收标准或规范时，不要用范围扩大说明掩盖，停止实现交回 propose。

no-TDD 任务（`tdd_required:false` + `no_tdd_reason`）不要求 RED/GREEN 配对，但仍必须有清楚的完成证据。注意：如果该任务的 `执行依据:` 声明了 `测试`，每个声明 TEST 仍需登记一次通过证据才能完成，否则 task-complete 会被拒绝（特征化任务即 `no_tdd_reason:characterization`——为固化既有行为而写保护测试的任务——用特征化通过状态登记，其余用普通通过状态，取值见「test-run 输入」）。

`tasks.md` 不写 RED/GREEN 命令、断言或预期输出。RED/GREEN 的真实证明来自 apply 阶段实际执行后登记的 `record test-run`。

如果 task id 以 `REVIEW-FIX-` 开头，或任务行带 `review_fix_of:<job_id>#<problem_id>`，把它当作普通 task 执行，不另起流程。它只表示该任务来自代码审查问题：实现范围只限对应问题；RED 或 characterization 要证明问题存在，GREEN 要证明问题已修复；完成前还要登记已完成任务的 GREEN 回归，或等价更大范围回归。修复中发现计划文档需要变化时，停止扩大实现，交回主流程处理。

## test-run 输入

`record test-run` 优先从 stdin 登记 JSON：

```json
{
  "test_id": "TEST-XXX",
  "attempt_id": "ATT-TASK-XXX-...",
  "command": "npm test",
  "cwd": "<工作目录>",
  "exit_code": 1,
  "semantic_status": "expected_failure"
}
```

证据规则：

- task 带执行依据时，示例中的六个字段全部必填，且 `test_id` 必须属于执行依据声明的测试。没有执行依据的历史 task 沿用旧规则：至少需要 `test_id` 和 `task_structure_digest`（当前 task 结构版本）。
- `attempt_id` 来自当前 task attempt；新产生的 TDD 证据必须带当前 `attempt_id`。
- `semantic_status` 使用 `expected_failure`（RED，要求 `exit_code != 0`）/ `expected_success`（GREEN，要求 `exit_code == 0`）/ `characterization_pass`（要求 `exit_code == 0`，且只有 `tdd_required:false no_tdd_reason:characterization` 的 task 可以使用）。
- `covers_task_ids` 可选，只在回归或等价场景中填写到同一份 test-run JSON，用来说明这次测试覆盖了哪些已完成任务；省略表示不声明覆盖关系。
- `command`、`cwd`、`exit_code` 和目标测试身份必须能说明目标测试确实运行。
- 退出码本身不等于证明；环境错误或构建失败不算 RED 或 GREEN。
- 缺少 `attempt_id`、只靠 `task_structure_digest` 匹配的旧 test-run 只能作为弱引用，不作为强证明。
- 其他可选字段只有在有明确来源时再填；不要为通过校验编造。

## 范围扩大说明

实现时发现必须扩大影响范围（本次改动明显超出执行依据的 `边界`、`设计` 或 task 描述的暗示），且仍服务于当前 task 时，在 next 下发的 task-complete 命令后追加 `--input -`，从 stdin 传入 JSON（四个字段全部必填，`verification` 为非空字符串数组，格式不合法时引擎会说明原因并拒绝完成）：

```json
{
  "scope_note": {
    "reason": "为什么需要超出原执行依据的边界",
    "changed_area": "实际扩大的代码或行为范围",
    "plan_alignment": "扩大后仍如何服务于当前 task 或原设计",
    "verification": ["TEST-001", "覆盖该变化的其他说明引用"]
  }
}
```

- 这是完成 task 时的一次性说明，task 完成后不能补写；需要说明但没写的，会被代码审查作为问题提出。不要为了通过校验编造字段。
- 范围扩大改变了用户可见能力、验收标准或 OpenSpec 规范时，不适用本机制，交回 propose。

## 测试覆盖豁免

进入审查前，`test-contract.md` 中每个 TEST 要么绑定到某个 task 的 `测试` 字段，要么有用户豁免决策。被阻断提示某个 TEST 未绑定时，先向用户确认原因（不要代替用户决策），再按阻断消息给出的命令和格式登记。注意：计划文档里写了不覆盖理由不等于已豁免，引擎只认已登记的用户决策。

以上两种登记在向用户沟通时都用人话说明（如"这次实现比计划多改了导出列，原因和验证已记录在案"、"测试契约里的 TEST-003 没有任务实现它，请确认是否豁免及原因"），不要原样复述命令、JSON 字段或内部事件。

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
