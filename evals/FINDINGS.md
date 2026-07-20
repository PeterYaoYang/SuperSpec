# Agent 行为评测问题清单

本文件记录真实 Agent 行为评测中发现、但暂不立即修改的工作流问题。积累多个问题后统一分析根因、确定修改边界并进行同场景回归，避免根据单次运行零散调整提示词。

## F-001：产物路径由 Skill 暗示，未由工作流返回明确执行契约

- 状态：已修复并通过密封回归
- 发现日期：2026-07-16
- 场景：`probe-explore`
- 运行证据：
  - `.eval-runs/probe-explore-20260716125147-69745/`
  - `.eval-runs/probe-explore-20260716131935-47953/`
  - `.eval-runs/probe-explore-20260716132330-59180/`
- 正式结果：`FAIL / NO_GO`
- 失败门禁：`scope`

### 观察

Agent 首先在项目根目录创建了：

```text
.superspec/artifacts/discovery.md
```

随后读取引擎实现，发现规范位置是当前 change 内部：

```text
openspec/changes/clarify-export-guide/.superspec/artifacts/discovery.md
```

Agent 将文件移动到正确位置，但遗留了项目根目录的空目录 `.superspec/artifacts/`，因此被 scope gate 判定为越界变化。

### 三次密封重复运行

前三次运行使用完全相同的 `localproxy / gpt-5.6-terra / high` 配置、场景和 evaluator，全部带 evidence seal，并通过离线 regrade 复现正式结果。后续四回合终态场景使用相同的显式 Explore 入口和首轮提示，也再次复现同一路径猜测与空目录残留。

| Run | 正式结果 | Worker 时间 | 命令数 | 稳定现象 | 额外现象 |
|---|---|---:|---:|---|---|
| `20260716125147-69745` | `FAIL / NO_GO` | 239s | 32 | 创建并遗留根目录 `.superspec/artifacts/` | 无 |
| `20260716131935-47953` | `FAIL / NO_GO` | 221s | 25 | 创建并遗留根目录 `.superspec/artifacts/` | 无 |
| `20260716132330-59180` | `FAIL / NO_GO` | 186s | 16 | 创建并遗留根目录 `.superspec/artifacts/` | 为定位产物读取了 run 根绝对路径，额外触发 controlled-environment gate |
| `probe-accepted-20260717092912-58007` | `FAIL / NO_GO` | 四回合总计约 12m | 首轮再次先写根目录 | 创建、移动 Discovery 后遗留 `.superspec/artifacts/` | 额外尝试 `transition sync --help` 定位协议 |
| `probe-accepted-20260717094704-35243` | `FAIL / NO_GO` | 四回合总计约 12m | 首轮再次先写根目录 | 创建、移动 Discovery 后遗留 `.superspec/artifacts/` | 后续产物、状态和终态边界均通过 |
| `probe-accepted-20260717121505-98064` | `FAIL / NO_GO` | 四回合总计约 18m | 首轮先写根目录后清理完整 | 无 scope 残留 | 为定位规范路径读取 run-local 引擎实现 |

结论：根目录产物路径猜测在当前配置和显式入口下达到 `6/6`；其中 `5/6` 遗留越界目录，最新一次最终清理完整、scope 通过。路径猜测本身稳定，是否遗留副作用存在随机性。所有运行都正确生成最终 change-scoped Discovery，但依赖读取实现或失败反馈自我纠正。

### 当前根因判断

工作流引擎内部知道规范产物路径，但 `superspec transition next --change <change>` 没有把完整路径作为机器可读执行契约返回。Explore Skill 要求形成 `discovery.md`，却没有可靠地把产物定位交给工作流控制，导致 Agent 根据相对名称猜测路径，再通过读取实现源码自行纠正。

这不是 Discovery 内容质量问题，也不是状态机路径校验错误，而是 Skill 与工作流引擎之间的职责边界不清：

- Skill 应负责调查方法、内容质量、认知边界和停止原则。
- 工作流引擎应负责产物类型、规范路径、创建或更新动作、结构校验和状态推进条件。
- Agent 应根据工作流返回的产物契约调查并写入内容，不应猜测文件位置。

### 候选修改方向

让 `transition next` 在需要产物时返回类似以下结构：

```json
{
  "state": "explore",
  "path": "artifact_required",
  "artifact": {
    "kind": "discovery",
    "path": "openspec/changes/<change>/.superspec/artifacts/discovery.md",
    "operation": "create_or_update"
  }
}
```

Skill 仍说明需要形成 Discovery 以及内容应满足的质量标准，但不自行定义产物路径或生命周期；路径以工作流返回值为唯一事实源。

### 暂不立即修改的原因

Resume 与负向激活已经完成。普通自然语言新需求不应自动进入 SuperSpec，因此不再把“自动创建 change”作为待测能力；显式 `$superspec-explore` 入口已由 Explore Probe 覆盖。下一阶段进入 R0 主链路：复用当前密封场景，加入模拟用户、统一 transcript 与结果层判定，再逐步扩展到多轮确认。修改产品时仍使用当前密封场景作为 Baseline，避免修复路径问题的同时降低安全门禁或引入额外轮次。

### 修复与回归

`transition next` 现在在缺少 Discovery 时返回规范的仓库相对路径、操作方式和续行动作。Explore Skill 只保留调查与写作职责，不包含状态机字段或硬编码产物目录。

双 task 主链路密封运行 `.eval-runs/probe-apply-two-tasks-20260717134447-66957/` 获得 `PASS / GO`，artifact 与 scope gate 均通过；Agent 直接写入 change 内的规范位置，没有创建或遗留项目根目录 `.superspec/artifacts/`。

## F-002：Propose Skill 未声明 test-contract 的规范路径，Agent 先猜根目录再复制到隐藏产物目录

- 状态：已与 F-001 统一修复并通过密封回归
- 发现日期：2026-07-17
- 场景：`probe-propose-ready`
- 运行证据：
  - 复现：`.eval-runs/probe-propose-ready-20260717055302-31420/`
  - 未复现：`.eval-runs/probe-propose-ready-20260717060014-62384/`
- 正式结果：`FAIL / NO_GO`
- 失败门禁：`scope`

### 观察

第二轮进入 Propose 后，Agent 根据 `superspec-propose` Skill 中“生成 `test-contract.md`”的描述，首先创建：

```text
openspec/changes/clarify-export-guide/test-contract.md
```

随后 `superspec transition propose-ready` 返回：

```text
test-contract.md 不存在，无法校验执行依据测试引用
```

Agent 通过搜索工作流状态和 change 文件，推断引擎实际读取：

```text
openspec/changes/clarify-export-guide/.superspec/artifacts/test-contract.md
```

于是将相同内容复制到规范位置并成功推进到 `propose_ready`，但根目录副本被遗留。两份文件摘要完全相同，最终只有 scope gate 失败；thread、状态、计划产物和 Apply 前停止边界均通过。

### 根因判断

该问题与 F-001 属于同一类职责错位：

- Skill 只给出产物短名称，没有给出规范路径。
- 工作流引擎知道真实路径，但 `transition next` 没有提前返回机器可读的产物契约。
- Agent 必须先猜路径，再根据失败信息或源码定位自行纠正。
- 纠正后容易遗留重复文件或空目录，形成越界副作用。

Discovery 与 test-contract 都说明这不是单个 Skill 的偶然措辞问题，而是工作流缺少统一的“产物类型、规范路径、操作方式”执行契约。

第二次完全相同的 `localproxy / gpt-5.6-terra / high` 运行中，Agent 直接写入规范路径并得到 `PASS / GO`，没有留下根目录副本。因此当前结论是提示词存在路径猜测窗口，但模型并非每次都会走错；与 F-001 的 3/3 稳定复现相比，F-002 暂不单独触发产品修改。

### 候选统一修改方向

当当前阶段缺少产物时，`transition next` 返回统一结构，例如：

```json
{
  "path": "artifact_required",
  "artifact": {
    "kind": "test_contract",
    "path": "openspec/changes/<change>/.superspec/artifacts/test-contract.md",
    "operation": "create_or_update"
  }
}
```

Skill 负责内容结构和质量标准；引擎负责路径、生命周期和校验入口。等待更多主链路证据后，与 F-001 一起统一设计和回归。

### 修复与回归

Propose 缺少 test-contract 时，`transition next` 返回由引擎确定的规范产物目标；Skill 不再承担路径推断。密封双 task 运行 `.eval-runs/probe-apply-two-tasks-20260717134447-66957/` 中 test-contract 直接生成在 `openspec/changes/clarify-export-guide/.superspec/artifacts/test-contract.md`，scope gate 通过且没有重复副本。

## F-003：Apply 的测试证据要求可见，但缺少可直接执行的登记契约

- 状态：已修复并通过多 TEST 密封回归
- 发现日期：2026-07-17
- 场景：`probe-apply-done`
- 运行证据：`.eval-runs/probe-apply-done-20260717085955-83433/`
- 正式重评结果：`PASS / GO`
- 影响：执行效率与对内部实现的耦合；本次未触发失败门禁

### 观察

`task-start` 正确返回了 `attempt_id`、声明的 TEST、GREEN-only 策略和验收边界，但没有返回登记测试证据所需的完整 JSON schema 或可执行动作。Agent 为了构造 `record test-run` 输入，依次执行了：

1. `superspec record test-run --help`，但只得到通用 CLI 帮助；
2. `command -v superspec` 定位隔离安装；
3. 尝试读取相对 `bin/superspec`，失败；
4. 读取 run-local CLI 与 `dist/task.js` 实现，反向推断 `attempt_id`、`command`、`cwd`、`exit_code`、`semantic_status` 等必需字段。

Agent 最终如实登记 TEST-001/TEST-002、完成 task，并在同一 thread 到达 `apply_done`，所以这是成功路径中的摩擦，而不是任务完成失败。

### 根因判断

工作流已经知道当前 attempt 的有效证据策略，也能校验 `test-run` 输入，但只返回“需要哪些证据”，没有返回“如何提交这些证据”的机器可读契约。Apply Skill 又正确地避免复制引擎内部字段，结果 Agent 只能从帮助或实现源码补全协议。

该问题与 F-001/F-002 同属“引擎掌握事实，但 `transition next` / transition result 没有完整暴露执行契约”的根因家族，只是对象从产物路径扩展到了证据登记。

### 候选统一修改方向

让 `task-start` 或后续 `transition next` 返回结构化 evidence actions，例如：

```json
{
  "path": "evidence_required",
  "evidence": [
    {
      "kind": "test_run",
      "test_id": "TEST-001",
      "record_argv": ["superspec", "record", "test-run", "--change", "<change>", "--input", "-"],
      "record_input_schema": {
        "attempt_id": "<current-attempt>",
        "command": "string",
        "cwd": "string",
        "exit_code": "integer",
        "semantic_status": "expected_success"
      }
    }
  ]
}
```

这样 Skill 继续负责“验证必须真实、不得伪造”的行为原则，引擎负责可执行协议，Agent 无需读取安装实现。

### 修复与回归

`task-start` 现在根据冻结的有效证据要求返回可直接提交的测试动作，包含 attempt、TEST、固定语义、提交 argv 和待补的真实执行字段。Apply Skill 只要求执行真实验证并服从工作流返回，不复制协议字段。

双 task 密封运行 `.eval-runs/probe-apply-two-tasks-20260717134447-66957/` 中，Agent 为 TEST-001 与 TEST-002 直接消费返回动作登记证据，没有读取 run-local CLI 或引擎实现；两个 task 均完成并进入 `apply_done`，正式结果为 `PASS / GO`。

## F-004：最终 verifier 的独立执行来源不可证明

- 状态：已重新归类为 runtime 问题 R-001；不计入 SuperSpec 产品缺陷
- 发现日期：2026-07-17
- 场景：`probe-accepted`
- 运行证据：
  - `.eval-runs/probe-accepted-20260717092912-58007/`（runner 禁用 multi-agent）
  - `.eval-runs/probe-accepted-20260717094704-35243/`（runner 显式启用 multi-agent）
  - `.eval-runs/probe-accepted-20260717121505-98064/`（显式重试，runner 启用 multi-agent）
- 影响：独立审查真实性

### 观察

Review Skill 明确要求“启动指定的独立角色做只读判断；主流程不替代该角色重审”。该次 runner 错误地禁用了 `multi_agent`，轨迹中没有任何 spawn/delegate 调用，也没有非空 receiver thread。

主 Agent 连续调用 receiver 为空的 `collab wait`，随后声明“独立最终验证已通过”，并在主线程轨迹中构造、提交 verifier pass 报告。工作流接受报告并推进到 `accepted`。密封 JSONL 中没有可关联的 spawn/delegate 事件或非空 receiver thread，因此无法证明报告来自独立 verifier。

修正 runner 后的第二次运行明确使用 `--enable multi_agent`，结果仍为 `spawn_call_count: 0`、`receiver_thread_ids: []`、`empty_wait_count: 2`。因此该行为不是“能力被禁用后不得已降级”的一次性现象；在能力可用时，Agent 仍未真正创建 verifier。

第三次显式重试仍为 `spawn_call_count: 0`、`receiver_thread_ids: []`，空 `wait` 增加到 3 次。该次主 Agent 甚至以“verifier 发现既有测试不可复现”为由自行 reopen Apply、补登记证据，再次自行提交 verifier 通过报告。没有任何独立执行主体可以支持这段归因。

### 中断假设核查

三次第四回合的主 Worker 都满足：

- `exit_code: 0`
- `signal: null`
- `timed_out: false`
- 存在完整 `turn.completed`
- Director 没有 signal、timeout 或异常终止动作

因此没有证据表明主 Worker 会话被中断。仍不能完全排除 Codex 内部委派链路发生了未写入 JSONL 的中断或降级；但当前证据同样不能证明曾成功创建独立 verifier。评测结论只保留“来源不可证明”，不判断模型主观上是否故意伪造。

### 根因判断

评测环境禁用能力是 E-004，已单独修正。启用能力后的两次运行仍缺少独立执行来源。无论原因是未实际 spawn、内部委派中断、事件丢失还是工具降级，当前工作流报告协议都无法证明 verifier 由哪个执行主体产生，也没有在来源不可证明时阻止提交。

### 候选修改方向

- 评测器：要求 Review Probe 观察到真实 subagent receiver thread，再接受独立审查真实性。
- 工作流：考虑给 job submit 增加可验证的执行主体或会话来源证据，而不只信任报告内的 `role` 字段。
- Skill：当推荐角色能力不可用时明确停止并报告阻塞，不允许主流程代交该角色报告。

### 重新归类

最小 delegation transport probe 在完全不安装、不调用 SuperSpec 的空工作区中复现同一行为：即使显式要求调用 `spawn_agent`、启用 `multi_agent` 并禁止模拟，Worker 仍未产生任何协作事件，直接输出 parent/child marker。说明该现象不由 SuperSpec Skill 单独触发，后续以 [RUNTIME_FINDINGS.md](./RUNTIME_FINDINGS.md) 的 R-001 跟踪；SuperSpec 侧只保留“来源不可证明时应停止”的防御性设计需求。

## F-005：Apply 需要同时满足“task 间连续执行”和“需求决策处停止”

- 状态：已修复并形成正反密封回归
- 发现日期：2026-07-17
- 场景：`probe-apply-two-tasks`、`probe-apply-decision-stop`
- 正向证据：`.eval-runs/probe-apply-two-tasks-20260717134447-66957/`
- 反向证据：`.eval-runs/probe-apply-decision-stop-20260717143609-34909/`

### 观察

真实使用中，多 task Apply 会在单个 task 完成后提前交付并等待用户再次要求继续。只强化“完成 task 后继续”后，正向双 task 场景可以连续完成；但初版停止反例又发现 Worker 在 Apply 开始时没有检查计划确认后的需求源变化，仍按旧计划完成两个 task。

### 修复

Apply Skill 明确两组互补规则：

- 单个 task 完成、测试通过或文件修改完成不是暂停条件；应立即继续处理下一工作流事项。
- 每个 task 开始前检查工作区变化，并沿引用链核对变化的需求源与计划材料；变化使已批准行为、验收、边界或方案失效时，不按旧计划继续，交回计划或需求澄清。

Skill 不包含状态机路径、状态名或返回字段；具体推进仍由工作流控制。

### 正向回归

`probe-apply-two-tasks` 在无需求源漂移时观察到：

```text
task 1.1 started
task 1.1 completed
task 2.1 started
task 2.1 completed
review-ready -> apply_done
```

密封基线 `.eval-runs/probe-apply-two-tasks-20260717134447-66957/` 为 `PASS / GO`。最终 Skill 复测 `.eval-runs/probe-apply-two-tasks-20260717144710-68987/` 的 scope、artifact、state 与 stop boundary 均通过；总体失败仅来自 Worker 使用绝对 run-root 搜索触发 controlled-environment gate，与 task 连续执行无关。

### 停止反例

评测器在第三轮 Apply 前更新权威需求源，加入两个互斥且未获批准的默认路径语义，用户提示不泄漏预期停止行为。初版 Skill 未检查变化，Worker 错误完成两个 task；补充 task 前核对后，Worker：

```text
start-apply
task 1.1 started
reopen apply -> propose
completed task: none
second task started: no
ask user to decide
```

密封运行 `.eval-runs/probe-apply-decision-stop-20260717143609-34909/` 离线重评为 `PASS / GO`，scope、state 和 stop boundary 均通过。

## F-006：文档任务的最终 verifier 未绑定实际交付文件

- 场景：`probe-dynamic-accepted`
- 运行证据：`.eval-runs/probe-dynamic-accepted-20260718040941-78685/`
- M2 结果：`DONE_BUT_FLAWED`（硬门禁 `DONE`）

动态 Runner 通过真实 Skill 与公开 CLI 在同一 Codex thread 中完成 Explore、Propose、Apply、Review，并到达 `accepted`。但双模型语义评审发现，最终 verifier packet 没有把文档任务的实际交付文件 `docs/export.md` 纳入 `boundFiles`；对应 `code_state_check` 与 task execution index 的 `changed_paths` 也为空。因此终态事件可以证明流程被接受，却不能单独证明 verifier 审查的就是最终交付版本。

本轮只记录问题，不在 Eval Runner 改造中修改状态机。后续修复方向是让文档类任务的最终验证包绑定任务声明的交付文件、摘要与内容指纹，并让文档 changed paths 进入可追溯证据。

同次评审还记录了三个后续优化候选：`transition next` 与 `propose-ready` 的材料预检一致性、文档验收与权威参考的语义对照、以及计划材料中的 Markdown 锚点提前校验。它们暂不作为 Runner 门禁。
