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

进入执行前，先用 `openspec instructions apply --change "<change>" --json` 读取 apply 阶段约束，再执行 `superspec transition start-apply --change "<change>"`。

每个任务的循环：

1. **task-start**：`superspec transition task-start --change "<change>" --task "<TASK-ID>"`
2. **拿到 attempt_id**：从 task-start 的返回结果或 `snapshot.json` 中读取当前活跃 attempt 的 `attempt_id`
3. **RED**：写测试，跑测试确认失败，`superspec record test-run --change "<change>" --input <red.json>`
4. **实现**：写代码让测试通过
5. **GREEN**：跑测试确认通过，`superspec record test-run --change "<change>" --input <FILE>`
6. **task-complete**：`superspec transition task-complete --change "<change>" --task "<TASK-ID>"`

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

当前限制：

- 不要同时保留多个 active attempt；同一任务必须先完成或明确失败当前 attempt。
- 测试证据不按 `task_id` 或 `attempt_id` 绑定时，不要拿来完成任务。
- RED/GREEN 是流程纪律，不是引擎校验项；引擎只登记你提交的测试记录。
- 当前 CLI 没有 return-to-propose / reopen surface；不要假装存在回退到 propose 的命令。

## Guardrails

- 只改 tasks.md 里本任务范围相关的文件
- 不跳过 RED 直接写 GREEN
- 退出码 0 ≠ 测试通过——semantic_status 才是证据
- 环境错误 / 构建失败不算 RED 或 GREEN
- 不手改 tasks.md 复选框——task-complete 会自动补丁
- 不跳过 transition
- 不要发明当前分支没有的 `superspec check` / `apply_worker_chain` / `apply_isolation`
