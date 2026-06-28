---
name: superspec-review
description: "四.执行代码审查和最终验证，推进 accepted"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Review

你是审查阶段。目标是按工作流引擎返回的下一步，完成代码审查、最终验证、accept 和归档确认。这个阶段用来提高实现质量，不用来增加额外审批负担。

## 驱动方式

所有状态由工作流引擎管理，按这个循环执行：

1. `superspec transition next --change "<change>"` 获取下一步。
2. 执行返回的命令，或处理返回的工作项/用户确认。
3. 登记结果。
4. 回到第 1 步。

如果 next 返回待完成工作项，先完成工作项；如果 next 返回用户确认，先让使用者决策；完成前不要 accept 或 archive。对用户说明时使用自然语言，不默认复述内部 JSON 字段或完整工作项说明。

## review-ready 语义

`review-ready` 是 transition 命令，不是状态。它会根据当前状态执行不同动作：

| 当前状态 | 动作 |
|---|---|
| `apply` | 所有 task 已完成时推进到 `apply_done` |
| `apply_done` | 执行代码审查 |
| `review` | 执行最终验证 |

在 `apply_done`：

- 有代码类改动时，`review-ready` 创建或等待代码审查工作项。
- 没有代码类改动时，`review-ready` 直接进入 `review`，不启动子代理；内部会记录跳过原因。
- 代码审查通过后，再次执行 `review-ready` 进入 `review`。
- 代码审查通过后不要再增加持续代码变化拦截；流程内如果需要改代码，必须回 apply，修完后重新走代码审查。

在 `review`：

- `review-ready` 创建或等待最终验证工作项。
- 最终验证工作项会绑定方案文档和当前已登记的执行证据版本。
- 最终验证通过后，如果绑定文档或已登记执行证据版本变化，下一次 `review-ready` 会创建新的最终验证工作项。
- 不要根据风险参数自行跳过最终验证；按 next 和 `review-ready` 返回结果执行。

## 工作项处理

如果 next 返回代码审查或最终验证工作项：

1. 读取工作项说明（job packet）。
2. 启动对应独立角色执行只读审查或验证。
3. 按工作项说明中的提交命令提交 JSON 报告，优先从 stdin 提交。

```bash
superspec record job-submit --change "<change>" --job <JOB> --report -
```

文件路径模式仅作为备用。报告登记沿用现有事件和原始报告归档机制；不要新增追溯字段或自定义原始报告文件类型。

代码审查结果处理：

- 代码审查通过：再次执行 `review-ready`，进入 `review`。
- 报告格式不符合要求，或没有给出可处理的问题：状态停在 `apply_done`，下一轮代码审查工作项说明会带上拒绝原因；按原因修正报告生成方式或审查口径后再执行。
- 连续两次报告不符合要求或没有可处理问题时，next 会要求先修正报告生成方式、模板或审查口径，避免无限重试。
- 发现纯代码实现问题：按 next 提示执行 `reopen --to apply --review-fix <job_id>#<problem_id> --reason "<reason>"`，由引擎追加审查修复任务。
- 发现方案/需求文档问题或混合问题：next 会先返回用户确认。记录使用者选择后，回到计划阶段执行 `reopen --to propose --review-finding <job_id>#<problem_id> --reason "<reason>"`；确认文档方向不变并回到实现阶段执行 `reopen --to apply --review-fix <job_id>#<problem_id> --reason "<reason>"`。

最终验证结果处理：

- 最终验证通过：执行 `superspec transition accept --change "<change>"`。
- 最终验证未通过：报告会保全原始报告引用和问题列表。按报告中的问题修复或回退；不要直接 accept。

## accept 和 archive

- 只有状态为 `review`，且 `next` / `review-ready` 要求的审查或验证已满足时，才执行 accept。
- accepted 后不要自动 archive，等待用户明确确认。

## Guardrails

- 审查阶段只读，不改业务代码。
- 不绕过 `next` / `review-ready` 要求的代码审查或最终验证。
- 主流程不重审代码，只复核代码审查报告是否可登记、问题是否可分流、回退和闭环证据是否存在。
- 不在 accepted 后自动 archive。
- 审查和验证报告必须引用真实文件、事件或测试证据，不编造。
- 不跳过 transition。
