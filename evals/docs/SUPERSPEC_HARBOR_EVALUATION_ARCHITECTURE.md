# SuperSpec 工作流评测系统

## Harbor 执行架构

## 1. 定义

本系统是一个可重复运行的 SuperSpec 全流程评测场。每次评测在独立容器中启动 Codex worker，由模拟用户以真实的确认、拒绝和需求补充推进对话；worker 使用 SuperSpec 完成任务，Harbor 在任务结束后执行私有验收并输出可审计的评测结果。

系统评测的是 SuperSpec 工作流的实际使用效果：需求澄清、计划确认、实现、审查、最终验收和需求修改后的继续执行均由 worker 与 SuperSpec 自行完成。

## 2. 系统目标

- 在隔离环境中复现真实用户使用 SuperSpec 的完整过程。
- 保留用户交互、Codex 工具调用、SuperSpec 引擎事件和验收结果之间的证据链。
- 通过私有测试验证最终实现，通过流程证据验证完成过程真实发生。
- 将固定任务集作为 SuperSpec skills 或引擎更新后的回归门。

## 3. 总体架构

```text
                        Harbor Trial
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Codex worker ──调用──► SuperSpec skills + transition engine │
│       │                              │                       │
│       │ MCP ask_user                 │ events.jsonl          │
│       ▼                              ▼                       │
│  模拟用户服务                    工作流产物与代码            │
│                                                              │
└──────────────────────────────┬───────────────────────────────┘
                               │ worker 结束
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Harbor verifier                                               │
│ 私有 API 测试 · SuperSpec 状态检查 · 产物检查 · 证据一致性检查 │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
                  结构化结果、Codex trajectory、评测报告
```

Harbor 是运行环境与验收执行器。SuperSpec 是被测工作流和唯一的状态迁移权威。两者的职责不重叠。

## 4. 角色与权限

| 角色 | 职责 | 可写入的数据 |
|---|---|---|
| Codex worker | 理解用户需求、调用 SuperSpec、执行实现和验证、登记工作流决策与证据 | 工作区、SuperSpec 产物、引擎事件 |
| 模拟用户 | 提供需求、回答澄清、对引擎给出的选项作出确认或拒绝 | 自己的会话历史 |
| Harbor | 创建容器、注入 Skills 和 MCP、保存运行轨迹、启动 verifier | Harbor 运行日志 |
| verifier | 执行私有测试、读取工作流最终状态、生成评分 | 验收结果与报告 |
| 双审与归因器 | 基于脱敏证据评估需求符合度、流程摩擦和优化项 | 审查与归因结果 |

SuperSpec 状态只由 Codex worker 通过 `superspec` 命令生成。模拟用户、Harbor 和 verifier 不持有工作流状态写入能力。

## 5. 交互协议

模拟用户通过 Harbor 注册为 streamable-HTTP MCP server，提供 `ask_user` 工具：

```ts
type AskUserInput = {
  question: string;
  allowed_answers?: string[];
  scope?: string;
  actions?: Array<{
    label: string;
    reason: "none" | "required" | "optional";
  }>;
};

type AskUserOutput = {
  answer: string;
  reason?: string;
  turn_id: string;
};
```

交互遵循以下契约：

1. worker 调用 `superspec transition next` 获取当前唯一可执行路径。
2. 当返回 `path: "ask_user"` 时，worker 将引擎返回的问题、`allowed_answers`、`scope` 和 actions 传给 `ask_user`。
3. 模拟用户从 `allowed_answers` 返回一个精确匹配的答案；选择需要理由的动作时，同时返回理由。
4. worker 使用引擎提供的 `record_argv` 与 `record_input` 执行 `superspec record user-decision --input -`，随后再次调用 `next`。
5. Harbor 记录 MCP 请求、MCP 回复、worker 的工具调用和 SuperSpec 引擎事件，形成完整交互证据。

模拟用户服务运行在独立容器，只包含 persona、响应策略和自身会话历史。它不挂载 worker 工作区、SuperSpec 运行目录、私有测试或验收产物。

## 6. 运行模型

每个任务使用一个 Harbor trial。trial 内的 Codex 会话持续处理全部 SuperSpec 阶段：

```text
需求与澄清
  → explore
  → 用户确认进入 propose
  → propose
  → 用户确认或要求修改计划
  → apply
  → 用户确认进入 review
  → review
  → accepted
```

SuperSpec 的阶段边界由 `superspec transition next` 返回的结果定义。Harbor 不将 explore、propose、apply 或 review 映射为自己的任务步骤，也不替 worker 执行 transition、record 或 job-submit。

## 7. 任务包结构

```text
evals/harbor/
  recipes/
    register-api-full/
      task.toml
      instruction.md
      environment/
        Dockerfile
        docker-compose.yaml
        skills/
          superspec-explore/
          superspec-propose/
          superspec-apply/
          superspec-review/
        user-server/
          Dockerfile
          server.ts
          persona.json
      tests/
        test.sh
        test_registration.mjs
        check_workflow.mjs
  scripts/
    export-run.mts
```

`task.toml` 声明 Codex agent、超时、`skills_dir` 和模拟用户 MCP endpoint。Dockerfile 固定 Node、SuperSpec、OpenSpec 和 fixture 的版本。Harbor 在 agent 会话结束后上传 `tests/` 并启动 verifier；私有测试不属于 worker 镜像内容。

## 8. 用户注册 API 标准任务

### 8.1 用户目标

用户需要一个 TypeScript 用户注册 API。接口接收邮箱和密码，成功注册返回 `201`；重复邮箱返回 `409`。

### 8.2 模拟用户行为

| 交互点 | 用户回复 |
|---|---|
| 需求澄清 | 邮箱按不区分大小写处理；重复邮箱不得创建第二个账号 |
| 探索完成 | `确认进入计划阶段` |
| 首次计划确认 | `留在计划阶段继续完善`；说明“密码最少 12 位，并在方案和测试约定中体现” |
| 再次计划确认 | `确认开始实现` |
| 实现与代码审查完成 | `确认进入最终审查` |

该任务要求 worker 在计划被退回后更新计划材料，再重新获得开始实现的确认。最终实现必须同时满足初始需求和后续补充的密码规则。

### 8.3 私有验收

私有测试验证：

- 合法邮箱和长度至少 12 位的密码返回 `201`；
- 邮箱规范化后仍保持唯一，重复注册返回 `409`；
- 短密码被拒绝；
- API 行为与 task 约定一致；
- `superspec status --change register-api` 返回 `accepted`；
- 必需的 discovery、计划、任务、测试证据和审查产物存在且非空；
- 运行轨迹包含三次阶段确认，其中计划阶段包含一次 `stay` 与一次后续 `advance`。

## 9. 工作流状态与证据

运行期的用户模拟不以 `snapshot.json` 为输入。状态判断通过公开的 `superspec status --change <change>` CLI 完成；该命令基于当前引擎记录重建状态。

`events.jsonl` 是事后证据源。系统将它与 Harbor 生成的 Codex trajectory 对齐：

| 证据 | 证明内容 |
|---|---|
| Codex `unified_exec` 工具调用 | worker 实际调用了 SuperSpec 命令 |
| Codex MCP 工具调用 | worker 在确认点请求了用户回复 |
| `user_decision_recorded` 事件 | 回复被 worker 按引擎契约登记 |
| `transition_commit` 事件 | SuperSpec 引擎实际推进了状态 |
| 私有测试结果 | 最终实现满足用户可观察的验收规则 |

每个状态迁移必须有对应的 worker 工具调用；每个阶段确认必须先有对应的 MCP 往返，再有用户决策登记。证据缺失、时序矛盾或状态写入来源不符合角色权限时，运行状态为 `INVALID`。

## 10. 结果模型

| 状态 | 条件 |
|---|---|
| `DONE` | 私有测试、目标完成态、产物检查和证据一致性检查全部通过 |
| `DONE_BUT_FLAWED` | 硬性检查通过，独立评审发现可改进的需求符合度或流程问题 |
| `NOT_DONE` | 未达到 `accepted` 或未满足私有验收 |
| `INVALID` | 状态、确认或证据链不真实，或违反角色权限 |
| `UNKNOWN` | 运行或证据采集不完整，无法可靠判定 |

双审输出需求符合度、问题严重度、流程优化建议和证据引用。归因器将每项问题归入 `task`、`user-sim`、`worker-model`、`workflow-skill`、`workflow-engine` 或 `env`。双审和归因不改变硬性结果。

## 11. 运行产物

每次运行导出以下内容：

```text
runs/<run-id>/
  task.json
  harbor-result.json
  codex-trajectory.json
  engine-events.jsonl
  workflow-status.json
  verifier-result.json
  outcome.json
  liveness.json
  review-a.json
  review-b.json
  attribution.json
  report.md
```

报告引用统一使用：`trajectory:<step>`、`engine_event:<event_id>`、`artifact:<path>`、`verifier:<test>`。每条归因和优化建议必须包含至少一个可解析的证据引用。

## 12. 回归运行

回归集由稳定通过的正向任务和验证证据链的负向任务组成。每次 SuperSpec skills、模板或引擎更新后，系统在固定模型和固定依赖版本下重复运行任务集，并报告：

- `DONE` 比例；
- `INVALID` 识别率；
- 任务耗时、token 消耗和工具调用次数；
- 用户确认次数、拒绝后的恢复成功率；
- 与基线相比的结果退化。

正向任务出现结果退化，或负向任务未被识别为 `INVALID`，均构成回归失败。

## 13. 运行入口

```bash
harbor run \
  -p evals/harbor/recipes/register-api-full \
  --agent codex \
  --model <固定模型> \
  --n-concurrent 1
```

Harbor 负责本地 Docker trial 的生命周期。`export-run.mts` 将 Harbor 结果、Codex trajectory、SuperSpec 事件和 verifier 结果整理为标准运行产物与报告。
