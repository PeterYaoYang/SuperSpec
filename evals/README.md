# SuperSpec Eval

SuperSpec Eval 是用于评测真实 Agent 行为的仓库原生考场。它会在隔离工作区中启动 Codex Worker，让 Worker 通过正常的 SuperSpec Skills 和公开 CLI 推进工作流，再根据密封证据判断流程是否真实完成、产物是否符合要求，以及工作流在哪些位置存在问题。

它评测的是完整工作流行为，而不是 Prompt 文案本身。

```text
Scenario
  → Probe：隔离运行 Worker，收集并密封证据
  → Arena：只读回放状态、产物和行为轨迹
  → M2：硬门禁 + 双模型语义审查 + 责任归因
  → Report
```

当前状态：M1 和 M2 已完成；批量稳定性回归、版本基线对比和发布门属于后续 M3。

## 核心原则

- Worker 必须通过正常 SuperSpec Skills 和公开 CLI 推进工作流。
- Director 只负责启动会话、转发输入和收集证据，不调用内部状态机函数，也不替 Worker 执行 `superspec transition` 或 `superspec record`。
- 硬门禁判断流程真实性、隔离、范围、状态、产物和停止边界；语义 Reviewer 不能覆盖硬门禁。
- 评测使用少量稳定不变量、多样化密封场景和通用语义审查，不把单个业务问题升级为全局规则。
- 没有足够证据时返回 `UNKNOWN`，不会根据自然语言或文件存在性猜测成功。
- Eval 只生成报告和优化线索，不自动修改 SuperSpec 产品代码。

## 目录结构

```text
evals/
  probe.mjs                 # 隔离运行、证据采集、硬门禁与 regrade
  arena.mjs                 # 密封运行的确定性只读回放
  m2.mjs                    # 正式结果、双模型审查、合并与归因
  delegation-probe.mjs      # 独立的 Codex multi-agent transport 诊断
  scenarios/                # Worker 考场定义
  tasks/                    # Arena/M2 的目标与成功标准
  tasks/negative/           # 作弊和篡改检测用例
  runs/                     # Arena/M2 输出
  docs/                     # Eval 架构与实施计划

.eval-runs/                 # Probe 密封运行；本地生成，不作为源码提交
```

Scenario 和 Task 的职责不同：

- Scenario 决定 Worker 在什么仓库、什么需求和什么模拟用户策略下运行。
- Task 声明回放时应达到的目标状态和必需产物。

## 快速开始

### 1. 先验证评测器自身

这些命令不调用评审模型：

```bash
node evals/probe.mjs --validate-faults
node evals/arena.mjs --validate-faults
npm run eval:m2:validate
```

它们验证硬结果映射、证据密封、篡改检测、动态用户边界、Review Bundle v2 和负向作弊用例。

### 2. 运行一个 Probe

默认运行 `probe-explore.json`，使用 `openai / gpt-5.6-terra / medium`：

```bash
npm run eval:probe
```

显式选择场景和模型：

```bash
npm run eval:probe -- \
  --scenario evals/scenarios/probe-dynamic-accepted.json \
  --provider localproxy \
  --model gpt-5.6-terra \
  --reasoning high
```

成功启动后，运行目录写入 `.eval-runs/<run-id>/`。Probe 会输出正式能力结果和退出码。

### 3. 回放密封运行

Arena 不重新执行 Worker，只读取密封证据：

```bash
npm run eval:arena -- \
  --task evals/tasks/smoke-dynamic-accepted.json \
  --replay .eval-runs/<run-id>
```

Arena 输出 `PROVISIONAL_DONE`、`NOT_DONE` 或 `UNKNOWN`。`PROVISIONAL_DONE` 只表示结果层观察到目标状态和产物，不会覆盖 Probe 的真实性、隔离或范围失败。

### 4. 执行 M2 双模型审查

```bash
npm run eval:m2 -- \
  --task evals/tasks/smoke-dynamic-accepted.json \
  --replay .eval-runs/<run-id> \
  --provider localproxy \
  --reviewer-a-model gpt-5.6-sol \
  --reviewer-a-reasoning high \
  --reviewer-b-model gpt-5.6-terra \
  --reviewer-b-reasoning high
```

默认 Reviewer 组合为：

- Reviewer A：`gpt-5.6-sol / high`
- Reviewer B：`gpt-5.6-terra / high`

`--model` 和 `--reasoning` 是兼容快捷参数，会同时设置两名 Reviewer。

当硬结果为 `UNKNOWN` 或 `NEEDS_HUMAN` 时，M2 不调用语义 Reviewer。`INVALID` 仍可在 Review Bundle 证据完整时执行内容审查，用于把产物问题与环境、隔离或真实性问题分开归因；语义结论不会覆盖硬结果。

如果某个 Reviewer 因 Provider 或模型运行时失败，M2 会保留另一名 Reviewer 的成功结果并记录失败原因，不再让整个评测无报告退出。硬结果不是 `DONE` 时仍保持该硬状态；硬结果为 `DONE` 但双审不完整时，最终语义结论为 `UNKNOWN`。

## 场景目录

| Scenario | 目的 | 会话模式 | 目标或边界 |
|---|---|---|---|
| `probe-explore.json` | 显式调用 Explore，验证 Discovery 与阶段确认 | 单轮临时会话 | `explore` |
| `probe-propose-ready.json` | 验证 Explore 确认后继续完成 Propose | 两轮同线程 | `propose_ready` |
| `probe-apply-done.json` | 验证计划确认、实现、测试和 Apply 收口 | 三轮同线程 | `apply_done` |
| `probe-apply-two-tasks.json` | 验证多个 Task 无问题时自动连续执行 | 三轮同线程 | `apply_done` |
| `probe-apply-decision-stop.json` | 验证需求发生不兼容变化时停止并返工 | 三轮同线程 | 返回 Explore/规划边界 |
| `probe-accepted.json` | 验证完整流程及独立 Review | 四轮同线程 | `accepted` |
| `probe-dynamic-accepted.json` | 根据真实工作流输出动态回答并推进到终态 | 动态同线程 | `accepted` |
| `probe-dynamic-needs-human.json` | 验证未获授权的业务问题会安全停止 | 动态同线程 | `NEEDS_HUMAN` |
| `probe-negative-activation.json` | 验证普通任务不会自动启动 SuperSpec | 单轮临时会话 | 不激活工作流 |
| `probe-resume.json` | 验证隔离 Codex thread 的恢复连续性 | 两轮恢复 | cwd、规则和线程保持一致 |

这些文件是正式场景定义。个人临时需求、一次性问题和本地实验不应持续加入全局场景集。

## 动态模拟用户

`session_mode: "dynamic_user"` 的场景不会预写固定恢复轮数。每个 Worker 回合结束后，Director 只读检查 Worker 最后一次直接执行的工作流输出，并由模拟用户答复后继续：

- 自动确认已授权的阶段确认；
- 使用场景明确配置的事实回答问题；
- 工作流存在唯一明确推荐项时，可以采用该推荐；
- 默认优先采用工作流推荐；没有可解析推荐时，独立模拟用户基于公开需求、用户人设和已知事实作出合理答复，持续推进到终态；
- 只有专门验证真实人工停止的场景显式设置 `advance_until_terminal: false`，才允许返回 `needs_human`；
- 非用户动作只要求 Worker 继续使用当前 Skill 和公开 CLI，不替 Worker 推进状态。

动态运行只会在以下情况停止：

- 到达声明的终态；
- 遇到需要真人决定的问题；
- Worker 行为证据无效；
- Worker 失败或会话无法恢复；
- 达到 `budget.max_worker_turns`。

当 `simulated_user.mode` 为 `ai` 时，每次用户决策使用一个新的隔离 Codex 会话。该会话无法访问 Worker 工作区，只能看到公开需求、用户人设、已知事实和本轮真实选项；返回答案必须属于工作流的 `allowed_answers`。

## 真实项目评测

Scenario 可以通过以下字段物化真实仓库的已跟踪提交：

```json
{
  "fixture": {
    "source_repository": "/absolute/path/to/repository",
    "source_ref": "<git-ref>"
  }
}
```

Runner 在隔离工作区中物化指定 commit，再安装当前 SuperSpec。源工作树不会被修改，未提交变化不会带入考场。

大型仓库可以增加单轮超时：

```json
{
  "budget": {
    "worker_turn_timeout_ms": 1200000,
    "max_worker_turns": 12
  }
}
```

某轮超时后，如果同一 Codex thread 能继续恢复并最终到达目标边界，该 timeout 作为性能限制保留，不单独使整个运行无效。进程非零退出、会话丢失或后续证据无法恢复时，才影响硬有效性。

## Provider 与隔离环境

内建 `openai` Provider 使用隔离后的 OpenAI 认证。自定义 Provider 只从宿主 Codex `config.toml` 的 `[model_providers.<name>]` 读取以下白名单字段：

- `name`
- `base_url`
- `env_key`
- `wire_api`
- `requires_openai_auth`

Runner 不继承其他用户配置。Provider URL 必须是不包含凭据、查询参数和片段标识的 HTTP(S) URL。受控环境只获得该 Provider 声明的凭据环境变量，manifest 只记录非敏感配置摘要，不记录密钥或密钥派生摘要。

每次 Probe 都会：

- 创建新的工作区、`HOME`、`CODEX_HOME` 和 `ZDOTDIR`；
- 使用 `workspace-write`、`approval_policy=never` 和受控 PATH；
- 仅安装当前构建出的 SuperSpec 包副本；
- 忽略用户 skills、agents、prompts、hooks、rules、history 和无关配置；
- 在运行结束后删除临时认证目录。

`multi_agent` 默认启用，使隔离 Worker 与真实 Codex 默认能力一致，并在 manifest 中记录。只有专门验证能力降级行为的场景才可显式设置 `fixture.enable_multi_agent: false`；普通工作流 Eval 不得关闭。

## 证据模型

Probe 运行结束后会生成并密封以下核心证据：

| 证据 | 内容 |
|---|---|
| `evidence/turn-<n>.jsonl` | Worker 原始 Codex JSONL |
| `evidence/turn-<n>.stderr.log` | Worker stderr |
| `evidence/worker-prompts.json` | 每轮实际发送给 Worker 的 Prompt、来源和摘要；正常运行不注入额外指令 |
| `evidence/simulated-user-turns.json` | 动态用户决策、来源和停止原因 |
| `evidence/events.jsonl` | SuperSpec 事件日志副本 |
| `evidence/snapshot.json` | SuperSpec 状态快照副本 |
| `evidence/workspace-before.json` | Worker 前工作区清单 |
| `evidence/workspace-after.json` | Worker 后工作区清单 |
| `evidence/workspace-changes.json` | 前后变化 |
| `evidence/git.diff` | 相对 fixture baseline 的最终 Git diff |
| `evidence/git-after.json` | diff baseline 与最终 Git 状态 |
| `evidence/director-actions.jsonl` | Director 的进程和文件动作 |
| `artifacts/changed-files/**` | Worker 最终修改文件的密封副本（不含引擎内部状态目录） |
| `evidence-seal.json` | 所有冻结输入的摘要集合 |
| `manifest.json` | 模型、Provider、隔离、版本和运行元数据 |
| `capability.json` | Probe 硬门禁结果 |

Prompt 账本在所有 Worker 回合结束后才写入，因此不会被 Worker 枚举。Scenario 的初始需求按原文发送；工作流问题只回复模拟用户选择，非用户边界只发送简短的“继续推进”。隔离、停止边界和真实性约束由 Runner 机制保证，不写入 Worker Prompt。Arena 和 M2 优先使用账本中的 effective Prompt；历史运行没有该文件时使用旧证据回退。

证据密封后，Arena、M2 和 regrade 都只读消费原始运行。任何 seal 所声明证据的删除或内容变化都会使验证失败。

## 硬门禁

Probe 的核心门禁包括：

| Gate | 判断内容 |
|---|---|
| `process` | Worker 是否正常完成；可恢复 timeout 单独记录，非零退出或无法恢复才阻断 |
| `controlled_environment` | Provider、路径、认证、工具和证据隔离是否可信 |
| `authenticity` | 状态推进是否对应 Worker 真实执行的公开 SuperSpec 命令 |
| `scope` | Worker 是否只修改 Scenario 允许的路径 |
| `artifact` | 必需产物是否存在、可读且符合稳定结构要求 |
| `state` | 事件链与快照是否能重放到目标状态 |
| `stop_boundary` | Worker 是否在正确边界继续或停止 |

真实性判定只接受 Codex JSONL 中直接观察到的已完成命令。命令必须使用受控 PATH 解析的 `superspec`，或者运行本地 shim/realpath。自然语言自报、伪造的命令文本、任意 shell 串联和无法确认执行身份的调用都不算证据。

## Review Bundle v2

M2 会为两名 Reviewer 生成 `review-bundle.json`，其中包含：

- 初始 effective Prompt 和关键对话；
- 用户决策与状态事件；
- 必需产物；
- 已密封的变更文件；
- 相对 fixture baseline 的 Git diff；
- 工作区变化与最终 Git 状态；
- 工作流正式登记的测试证据，以及 Worker 真实执行的测试、构建、lint、typecheck 和 `git diff --check` 输出；
- 材料摘要、长度、截断和缺失说明。

长产物和 diff 使用头尾分块，引用格式类似：

```text
artifact:<path>#chunk-1
changed-file:<path>#chunk-2
diff:evidence/git.diff#chunk-3
test:turn-4:event-27
transcript:18
engine_event:<event-id>
```

Reviewer 的每条问题或优化建议必须引用有效证据。找不到引用的条目会被降权。`review_coverage` 不完整时，Reviewer 只能评价已提供内容，不得宣称遗漏部分没有问题。

Review Bundle 的覆盖限制不会改变硬门禁，也不会被归因成 SuperSpec 产品缺陷。

## 结果状态

### Probe

| Exit code | Scenario result | Capability verdict | 含义 |
|---|---|---|---|
| `0` | `PASS` | `GO` | 直接证据满足当前 Probe 契约 |
| `2` | `PASS` | `GO_WITH_LIMITATIONS` | 通过，但存在明确记录的证据或兼容限制 |
| `1` | `FAIL` | `NO_GO` | 观察到真实行为、范围或边界失败 |
| `3` | `INVALID` | `NO_GO` | 基础设施、隔离、认证或必要证据不可用 |

Probe 不评价最终业务内容质量，`semantic_quality` 保持 `ungraded`。

### M2

| 状态 | 含义 |
|---|---|
| `DONE` | 硬结果真实完成，语义审查未提出问题 |
| `DONE_BUT_FLAWED` | 硬结果真实完成，但 Reviewer 提出问题或优化建议 |
| `NOT_DONE` | 未达到 Task 声明的目标状态或产物要求 |
| `NEEDS_HUMAN` | 工作流遇到模拟用户无权决定的真实问题 |
| `INVALID` | 真实性、隔离或作弊检测失败 |
| `UNKNOWN` | 关键证据不足，无法下结论 |

双模型 requirement fit、问题列表和归因属于语义评审结果，不能把硬门禁失败改成成功。

## 输出文件

Arena/M2 输出位于 `evals/runs/`：

```text
evals/runs/arena-*/
  task.json
  transcript.jsonl
  outcome.json
  report.md

evals/runs/m2-*/
  review-bundle.json
  review-a.json
  review-b.json
  m2-result.json
  report.md
  m2-manifest.json
```

`review-a.json` 和 `review-b.json` 是标准化后的独立意见；`m2-result.json` 包含硬结果、合并意见、证据覆盖、最终状态和责任归因。

## 离线 Regrade

可以使用当前确定性评估器重新评估一个已完成的 Probe，而不重新执行 Worker：

```bash
node evals/probe.mjs --regrade .eval-runs/<run-id>
```

Regrade 只新增：

- `capability.regraded.json`
- `regrade-manifest.json`

原始证据不会修改。Regrade 会验证证据密封、场景摘要、隔离包摘要、Prompt 证据和运行材料。当前场景或 Prompt 与原运行不一致时，会明确记录差异；历史运行缺少新证据时按兼容规则降级，而不是伪造成完整结果。

## 开发诊断

Probe 支持开发期故障注入：

```bash
node evals/probe.mjs \
  --scenario evals/scenarios/probe-explore.json \
  --inject forbidden-path
```

支持的注入值包括：

- `missing-codex`
- `unknown-jsonl`
- `hide-required-command`
- `delete-discovery`
- `forbidden-path`
- `fixture-digest-mismatch`

注入运行会写入 manifest，只用于验证评测器失败映射，不得作为产品基线。

独立的 multi-agent transport 诊断：

```bash
npm run eval:delegation
```

该命令诊断 Codex、Provider 和模型是否真实执行 `spawn_agent`，不属于 SuperSpec 工作流评分。

## 当前边界

- 当前正式能力覆盖单次密封运行、动态模拟用户、终态执行、Arena 回放、M2 双审和归因。
- Eval 不保证模型多次运行产生完全相同的路径或文本；稳定性需要通过后续 M3 重复运行统计。
- Reviewer 只能评价 Review Bundle 中的密封材料；coverage 有限制时，报告会明确显示。
- 临时本地 Scenario、Task 和运行目录不是 Eval 核心逻辑，不应因为一次业务发现持续加入 Git。
- 下一阶段是 M3：正式回归集、重复运行、版本 baseline 对比和发布门。
