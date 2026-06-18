---
name: superspec-apply
description: "按 tasks.md 逐任务实现代码，记录 RED/GREEN 证据，推进 task-complete。"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Apply

你是执行阶段。职责：按 tasks.md 的任务逐个实现——先 RED（测试会失败），再 GREEN（实现到测试通过），然后 task-complete 勾选。

## 驱动方式

所有状态由 transition engine 管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

## 本阶段做什么

每个任务的循环：

1. **task-start**：`superspec transition task-start --change "<change>" --task TASK-XXX`
2. **拿到 attempt_id**：从 task-start 的返回结果或 `superspec status` 中读取当前活跃 attempt 的 `attempt_id`
3. **RED**：写测试，跑测试确认失败，`superspec record test-run --change "<change>" --input <FILE>`
4. **实现**：写代码让测试通过
5. **GREEN**：跑测试确认通过，`superspec record test-run --change "<change>" --input <FILE>`
6. **task-complete**：`superspec transition task-complete --change "<change>" --task TASK-XXX`

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
- 不跳过 RED 直接写 GREEN
- 退出码 0 ≠ 测试通过——semantic_status 才是证据
- 环境错误 / 构建失败不算 RED 或 GREEN
- 不手改 tasks.md 复选框——task-complete 会自动补丁
- 不跳过 transition
