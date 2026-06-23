---
name: superspec-apply
description: "三.按 tasks.md 逐任务实现代码，并按要求完成红/绿 验证"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

你是执行阶段。职责：按 tasks.md 的任务逐个实现——先 RED（测试会失败），再 GREEN（实现到测试通过），然后 task-complete 勾选。

## 驱动方式

所有状态由工作流引擎管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

## 本阶段做什么

每个任务的循环：

1. **任务开始**：`superspec transition task-start --change "<change>" --task TASK-XXX`
2. **拿到执行尝试 ID**：从 task-start 的返回结果或 `superspec status` 中读取当前活跃 attempt 的 `attempt_id`
3. **红灯验证**：写测试，跑测试确认失败，`superspec record test-run --change "<change>" --input <FILE>`
4. **代码实现**：根据任务写代码实现,保证代码不出现过渡设计以及代码质量
5. **绿灯验证**：跑测试确认通过，`superspec record test-run --change "<change>" --input <FILE>`
6. **任务结束标记完成**：`superspec transition task-complete --change "<change>" --task TASK-XXX`

no-TDD 任务（tdd_required:false + no_tdd_reason）跳过 RED/GREEN。

## test-run 输入格式

```json
{
  "test_id": "TEST-XXX",
  "attempt_id": "ATT-TASK-XXX-...",
  "task_structure_digest": "<从 tasks.md 派生的结构指纹>",
  "command": "npm test",
  "cwd": "<工作目录>",
  "exit_code": 1,
  "semantic_status": "expected_failure",
  "target_fingerprint": "<被测文件的 sha256>"
}
```

- `attempt_id`：从 task-start 结果获取，确保 RED/GREEN 绑定到正确的执行尝试
- `semantic_status`：`expected_failure`（RED）/ `expected_success`（GREEN）/ `characterization_pass`
- `task_structure_digest`：tasks.md 复选框归一化后的 sha256（引擎计算，你不需要手动算）

## Guardrails

- 只改 tasks.md 里本任务范围相关的文件
- 需要判断影响范围或改动原因不自明时，参考 `proposal.md` 的 `## Impact`，但不要把它当作路径白名单
- 编码时发现未列入影响范围的文件，如果从 diff 或引用链能直接解释为同一任务下的局部引用、测试辅助或机械连带改动，可以继续
- 如果发现新增能力、用户可见行为、明显新增影响范围或原因不自明，停止扩大实现并报告给主流程；不要在 apply 阶段补改 `proposal.md`
- 不修改 `proposal.md`、`design.md`、`specs/**` 或 `.superspec/**`
- active attempt 期间不要修改 `tasks.md` 中除 `task-complete` 自动勾选目标 checkbox 外的内容
- 不跳过 RED 直接写 GREEN
- 退出码 0 ≠ 测试通过——semantic_status 才是证据
- 环境错误 / 构建失败不算 RED 或 GREEN
- 不手改 tasks.md 复选框——task-complete 会自动补丁
- 不跳过 transition
