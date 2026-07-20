# Runtime Findings

这里记录 Codex、模型 provider 或 Agent 工具运行时行为，不作为 SuperSpec 产品缺陷或 evaluator 缺陷统计。

## R-001：localproxy / Terra 未执行明确要求的 spawn_agent

- 状态：稳定复现
- 配置：`localproxy / gpt-5.6-terra / high / multi_agent enabled`
- SuperSpec 终态运行：3/3 无可证明的 verifier spawn
- 最小 transport probe：1/1 无 spawn

### 最小复现

运行：

```bash
npm run eval:delegation
```

证据：`.eval-runs/probe-delegation-20260717124406-66740/`

Prompt 明确要求：

- 必须调用一次原生 `spawn_agent`，角色为 verifier；
- child 只返回固定 marker；
- parent 必须等待该 receiver thread；
- 禁止 shell、文件、空 wait、模拟或改写 child 结果；
- spawn 不可用时必须返回失败 marker。

实际结果：

```json
{
  "worker_exit_code": 0,
  "timed_out": false,
  "turn_completed": true,
  "spawn_call_count": 0,
  "receiver_thread_ids": [],
  "child_marker_observed": true,
  "parent_marker_observed": true,
  "pass": false
}
```

完整 JSONL 只有 `thread.started`、`turn.started`、一条普通 `agent_message` 和 `turn.completed`。模型直接输出两个 marker，没有协作工具调用。

### 中断核查

三次 SuperSpec 第四回合和最小 Probe 均正常退出；SuperSpec 三次运行都满足 `exit_code: 0`、`signal: null`、`timed_out: false` 和完整 `turn.completed`。没有主 Worker 中断证据。

stderr 存在 localproxy `/models` 响应与 Codex models manager 预期 schema 不一致的后台刷新错误，但实际响应 turn 正常完成。当前无法证明该后台错误是否会影响 delegation 工具暴露或模型工具选择。

### 当前判断

问题位于以下边界之一，尚未进一步归因：

1. localproxy 未正确传递或执行多 Agent 工具调用；
2. Terra 模型忽略了强制 delegation 指令；
3. Codex CLI 在该 provider/config 下没有把 spawn 工具暴露给模型；
4. 协作事件发生但没有进入 `codex exec --json` 轨迹（最小 Probe 没有任何 wait/spawn 痕迹，当前可能性较低）。

下一步应做 provider A/B：保持 prompt、Codex 版本和模型档位不变，对比 built-in OpenAI provider 的 JSONL；之后再决定是否需要 localproxy 适配或向 Codex runtime 报告。
