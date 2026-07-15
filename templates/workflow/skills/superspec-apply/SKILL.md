---
name: superspec-apply
description: "三.按 tasks.md 逐任务实现并登记验证结果"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

你是执行阶段。目标是按 `tasks.md` 的可执行 task 完成实现、登记真实验证结果，并用 `task-complete` 标记完成。

## 使用方式

先运行 `superspec transition next --change "<change>"`，并把输出当成当前的一组工作项。它会给出要开始/完成的 task、需要的确认或审查；逐项处理，不要自行推断或描述内部流程。

- 收到 task：按下文完成一个 task，再重新获取下一步。
- 收到确认或审查：暂停编码，先处理该事项。
- 发现范围、验收或用户可见行为变化：停止实现，说明发现和影响，让引擎给出重新计划的动作。

## 普通 task 执行

只执行 `tasks.md` 中顶格 checkbox 行里的 `<task_id>`，例如 `1.1` 或 `TASK-001.1`。Markdown 标题只是分组；普通 bullet 只是说明，不单独成为工作流执行单元。

每个 task 的标准循环：

1. **计划核对**：执行 `task-start` 前，确认当前 task 是 `tasks.md` 顶格任务。task 带 `执行依据:` 块时，以它为主要执行上下文；没有执行依据的历史 task 对应 `design.md` 的实现方向和 `proposal.md` 的 `## Impact` 受影响原因。缺少映射、需要新增能力/验收/影响范围时先停止，交回 propose，不写 RED。
2. **任务开始**：执行 next 下发的 task-start 命令。
3. **读取执行快照**：task-start 的返回结果包含本次任务尝试 ID（`attempt_id`，登记验证时要用）和执行依据快照。实现与验证以该快照为准；不要根据风险模式、task 标记或历史经验自行选择验证步骤。
4. **实现并验证**：根据任务写代码，保持范围小；执行引擎要求的验证并用 `record test-run` 登记真实结果。缺少可执行验证或发现计划不再适用时，停止并交回计划处理。
5. **完成 task**：执行 next 下发的 task-complete 命令。实现中发现改动明显超出 `执行依据:` 的 `边界`、`设计` 或 task 描述暗示的影响范围、但仍服务于当前 task 时，在该命令后追加 `--input -` 登记范围扩大说明（见「范围扩大说明」一节）；范围扩大改变了用户可见能力、验收标准或规范时，不要用范围扩大说明掩盖，停止实现交回 propose。

## 结果登记

验证结果、范围扩大说明和测试覆盖豁免都按引擎当前返回的命令与输入契约登记；不要在 Skill 中猜测字段、复用旧输入或编造证据。向用户说明时只说实际改动、原因、验证与需要的业务确认，不复述内部 JSON。

## Guardrails

- 只改当前 task 范围相关的实现或测试文件。
- 需要判断影响范围或改动原因不自明时，参考 `proposal.md` 的 `## Impact`，但不要把它当作路径白名单。
- 编码时发现未列入影响范围的文件，如果从 diff 或引用链能直接解释为同一任务下的局部引用、测试辅助或机械连带改动，可以继续。
- 如果发现新增能力、用户可见行为、明显新增影响范围或原因不自明，停止扩大实现并报告给主流程；不要在 apply 阶段补改 `proposal.md`。
- 用户在 apply 期间或 apply 后补充最新业务规则、产品口径、验收标准、示例规范、兼容策略、影响范围，或说明需求源已更新时，停止实现并交回主流程使用 `superspec-propose` 更新计划文档；交回时说明变化来源、变化内容、影响范围和建议处理方式。
- 不修改 `proposal.md`、`design.md`、`specs/**` 或 `.superspec/**`。
- active attempt 期间不要修改 `tasks.md` 中除 `task-complete` 自动勾选目标 checkbox 外的内容。
- 不手改 tasks.md 复选框；`task-complete` 会自动补丁。
- 不手写复选框或推进结果；只执行 `next` 当前返回的命令。
