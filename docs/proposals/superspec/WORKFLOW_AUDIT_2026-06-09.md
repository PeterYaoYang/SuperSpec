# SuperSpec 工作流审查报告

> Status: review snapshot
> Date: 2026-06-09
> Scope: 工作流设计、guard/evidence 管控、skills 编排、规范与实现一致性、外部框架对标
> Authority: 本文是审查意见，不是规范源；当前规范源仍是 `docs/proposals/superspec/SPEC.md`。

## 1. 结论

SuperSpec 的主方向成立：保留 OpenSpec 默认 `spec-driven` 正本流程，不 fork OpenSpec schema；把额外质量门禁放在 `.superspec/` sidecar、guard、evidence、RED/GREEN 和 review adjudication 里。这是正确边界。

但当前 v1 必须定位为 **audit-only discipline layer**，不能对外宣称为 mechanical enforcement。也就是说，v1 能让合作型 agent 更难无意识跳步，并能事后发现证据不完整；它不能阻止恶意或失控 agent 先改代码、伪造 evidence、跳过 subagent 或绕过 guard。

当前设计的强项是严谨、可审计、与 OpenSpec 正本解耦；短板是运行时真实性不足、上手成本高、Markdown DSL 脆弱、真实 `.superspec` E2E 样本尚未闭环。

## 2. 当前工作流梳理

用户可见主流程：

```text
project init -> explore -> propose -> apply -> review -> archive
```

### 2.1 Init

目标：安装/检查 SuperSpec 项目级 surfaces。

关键控制点：

- `./scripts/superspec_init` 创建/校验 `.codex/skills/superspec-*`、repo-local role agents/prompts、guard wrapper。
- `check-init` 校验 OpenSpec CLI surface、OpenSpec native Codex skills、SuperSpec role files。
- 当前实现只检查 role agent/prompt 的存在性、TOML `name`、prompt 非空；不校验 checksum 或来源完整性。

证据：

- `scripts/superspec/src/gates.ts:383` `openspec_init_reasons`
- `scripts/superspec/src/gates.ts:406` `superspec_agent_reasons`
- `scripts/superspec/src/project_init.ts`

### 2.2 Explore

目标：只调查和澄清，不写 OpenSpec planning artifacts。

产物：

- `.superspec/artifacts/discovery.md`
- `critic` native-subagent evidence

控制点：

- `superspec-explore` 必须桥接 repo-local `openspec-explore` skill。
- `explore_complete` 要求 discovery 文件存在且有 `critic` evidence。

证据：

- `.codex/skills/superspec-explore/SKILL.md:18`
- `scripts/superspec/src/gates.ts:493`

### 2.3 Propose

目标：生成 OpenSpec planning package，并叠加 SuperSpec sidecar。

OpenSpec 正本 artifact 仍是：

- `proposal.md`
- `specs/**/*.md`
- `design.md`
- `tasks.md`

SuperSpec sidecar：

- `.superspec/artifacts/business-invariants.md`
- `.superspec/artifacts/test-contract.md`

控制点：

- OpenSpec artifacts 必须通过 `openspec instructions <artifact> --change <c> --json` 编写。
- `design_complete` 需要 `architect + critic + test-engineer` evidence 和 human confirmation。
- `invariants_reviewed` 需要 business invariants 结构有效，并经 `critic + test-engineer`。
- `test_contract_drafted` 需要覆盖 specs 的每个 Scenario 和 automated hard invariant。
- `tasks_complete` 需要 tasks 结构化字段、test refs、invariant refs、write scope 等可解析。
- `propose_complete` 聚合所有内部 gate。

证据：

- `.codex/skills/superspec-propose/SKILL.md:18`
- `scripts/superspec/src/gates.ts:489`
- `scripts/superspec/src/gates.ts:597`

### 2.4 Apply

目标：在 OpenSpec apply 指令外层包 RED/GREEN gate。

任务循环：

```text
openspec instructions apply
-> check-task-edit
-> RED evidence
-> implementation
-> GREEN evidence
-> check-task-complete
-> mark task checked
```

控制点：

- `check-task-edit` 在实现编辑前要求 RED 或 characterization evidence。
- `check-task-complete` 在勾选 task 前要求 GREEN 或 alternative/manual verification。
- review 发现问题后，不能直接在 review 阶段回改 `tasks.md`；必须走 `main_adjudication(request_changes)` -> `task_reopen` -> apply 返工。

证据：

- `.codex/skills/superspec-apply/SKILL.md:18`
- `scripts/superspec/src/gates.ts:1002`
- `scripts/superspec/src/gates.ts:1022`
- `scripts/superspec/src/gates.ts:1087`

### 2.5 Review

目标：实现审查、最终验证和主线程裁决合并在一个 review 阶段。

必须 evidence：

- `source_guidance`: `code-reviewer`
- `source_guidance`: `architect`
- `source_guidance`: `critic`
- `verification_review`: `verifier`
- `verification_review`: `critic`
- `final_test`
- `main_adjudication`

控制点：

- `review_complete` 是 allow-only gate。
- `main_adjudication.review_decision:"request_changes"` 是合法 review 输出，但不是 `review_complete` allow。
- 主线程必须用 `loaded_refs` 覆盖 subagent 要求的 `required_load_refs`。
- 主线程必须 adjudicate 所有 `required_claim_ids` 和 blocking finding ids。

证据：

- `.codex/skills/superspec-review/SKILL.md:18`
- `scripts/superspec/src/gates.ts:1185`
- `scripts/superspec/src/gates.ts:1239`
- `scripts/superspec/src/util.ts:84`
- `scripts/superspec/src/util.ts:85`

### 2.6 Archive

目标：使用 OpenSpec 原生 archive，同时保留 `.superspec` evidence。

控制点：

- archive 前必须 `review_complete` allow。
- archive 前必须 human confirmation。
- `check-archive-ready` 在锁内重读 status/evidence/config，再生成 preservation manifest/bundle。
- `openspec archive -y <change>` 后，`check-archived` 到 archive 目录验证 `.superspec` preservation。

证据：

- `.codex/skills/superspec-archive/SKILL.md:18`
- `scripts/superspec/src/core.ts:208`
- `scripts/superspec/src/archive.ts:243`
- `scripts/superspec/src/archive.ts:344`

## 3. 发现的问题

### P0. v1 强制力边界容易被误读

现状：

- `SPEC.md` 明确写 v1 是 audit-only，证据可伪造闭环。
- skills 和 guard 文案大量使用 `must`、`不得`、`block`，容易让用户误以为 v1 已具备物理阻断。

风险：

- 如果对外说 SuperSpec v1 能“防抄近路”，就是过度承诺。
- 实际上模型仍可先改代码，再补假 evidence，guard 会形成自洽指纹。

证据：

- `docs/proposals/superspec/SPEC.md:135`
- `docs/proposals/superspec/SPEC.md:426`
- `docs/proposals/superspec/SPEC.md:437`
- `docs/proposals/superspec/SPEC.md:796`

建议：

- 对外描述统一改为：v1 = audit-only / cooperative agent discipline。
- mechanical enforcement 只留给 v2 hook spike 通过后的能力。

### P0. Evidence 防伪不足

现状：

- role evidence 要求 `execution_mode:"native_subagent"`、`agent_role`、`agent_id` 等字段。
- guard 能拒绝 `execution_mode:"direct"`，但不能证明 native subagent 真的运行过。
- `SPEC.md` 自己也承认 v1 `agent_id` 是 self-reported。

风险：

- 主线程或 agent 可以手写一份结构正确的 role evidence。
- `target_refs[].blob_sha` 能防 drift，不能防伪造。

证据：

- `docs/proposals/superspec/SPEC.md:399`
- `docs/proposals/superspec/SPEC.md:625`
- `scripts/superspec/src/evidence.ts:288`
- `scripts/superspec/src/gates.ts:406`

建议：

- v1 明确标注 `trust:self_reported_native_subagent`。
- v2 使用 `SubagentStart/SubagentStop` runlog 绑定真实 `agent_id`。
- 分发包增加 role agent/prompt checksum manifest。

### P1. Final verification ref 没有强绑定真实运行

现状：

- `verify_reference_reasons` 主要验证 `openspec_validate_ref`、`task_matrix_ref`、`invariant_matrix_ref`、`scope_drift_ref` 是 change root 内可读文件。
- `check_review_complete` 会重新跑 `openspec validate`，这是好事。
- 但 evidence 中引用的 validate log 不一定等于 guard 当场运行的 validate 输出。

风险：

- evidence 可引用旧日志或人工拼接日志。
- `final_test.status:"pass"` 仍是自报，没有 runtime exit code 绑定。

证据：

- `scripts/superspec/src/evidence.ts:144`
- `scripts/superspec/src/gates.ts:1419`
- `.codex/skills/superspec-review/SKILL.md:76`

建议：

- `final_test` 增加 `command`、`exit_code`、`started_at`、`ended_at`、`cwd`、`output_sha256`。
- `openspec_validate_ref` 增加 `validate_command`、`validate_exit_code`、`validate_output_sha256`。
- v2 用 `PostToolUse` 捕获真实 test/validate 输出。

### P1. `required_load_refs` 仍然是主线程自证

现状：

- source guidance 可要求主线程读取关键文件。
- guard 只校验 `main_adjudication.loaded_refs` 覆盖 `(path, blob_sha)`。

风险：

- 这能迫使主线程结构化声明“我读过”，但不能证明实际读过。
- 对抗性 agent 仍可填入正确 blob sha 后跳读。

证据：

- `docs/proposals/superspec/SPEC.md:652`
- `scripts/superspec/src/gates.ts:1409`
- `.codex/skills/superspec-review/SKILL.md:60`

建议：

- v1 仍保留该机制，因为它能显著改善审查纪律。
- 文案不要把它称为 runtime proof。
- v2 若要更强，需要读取动作日志或工具调用 trace。

### P1. Markdown DSL 脆弱

现状：

- tasks、test-contract、business-invariants、invariant matrix 都通过 Markdown table/regex 解析。

风险：

- 表头轻微变体、中文/英文混排、管道符、换行、列表格式变化都可能导致误判。
- 人类可读文档和机器判定混在同一层，后续扩展成本会升高。

证据：

- `scripts/superspec/src/tasks.ts:8`
- `scripts/superspec/src/tasks.ts:85`
- `scripts/superspec/src/invariants.ts:66`
- `scripts/superspec/src/invariants.ts:284`

建议：

- 保留 Markdown 作为人类视图。
- 对关键 gate 数据增加 `.superspec/artifacts/*.json` 或 fenced YAML/JSON canonical block。
- guard 优先读结构化 block，Markdown 表格作为展示层。

### P1. 还缺真实 `.superspec` E2E 样本

现状：

- 当前 `openspec list --json` 只有 `refactor-generic-api-vacations-v1-duration`。
- 该 change 使用 legacy `.irsflow/`，仓库内未发现 `openspec/changes/*/.superspec/*`。

风险：

- guard 单测通过不等于真实 workflow 可用。
- 最重要的验证不是单元测试，而是一个新 change 从 explore 到 archive 真跑一遍。

证据：

- `openspec list --json`
- `find openspec/changes -path '*/.superspec/*'`
- `openspec/changes/refactor-generic-api-vacations-v1-duration/.irsflow/*`

建议：

- 新开一个小但真实的 SuperSpec change。
- 必须完整跑：`explore -> propose -> apply -> review -> archive`。
- 每阶段至少验证一次缺失时 block、补齐后 allow。

### P1. 历史文档和项目记忆存在漂移

现状：

- `DESIGN.md` 顶部标注历史草案，但正文仍有 custom schema、`test-contract` OpenSpec artifact、`review`/`verification` artifact 等旧方案。
- `docs/project-insights/inbox/2026-06-08-superspec-review-roles.md` 仍写 v1 review gate 收敛为 `code-reviewer + critic`。
- 当前 `SPEC.md`、skills、guard 实际要求 `code-reviewer + architect + critic`。

风险：

- 后续 agent 容易读错旧文档，把已废弃方案重新实现。
- “单一规范源”在实践上会被历史文件和 inbox 记忆破坏。

证据：

- `docs/proposals/superspec/DESIGN.md:1`
- `docs/proposals/superspec/DESIGN.md:46`
- `docs/project-insights/inbox/2026-06-08-superspec-review-roles.md:15`
- `docs/proposals/superspec/SPEC.md:617`
- `scripts/superspec/src/util.ts:84`

建议：

- 给历史文档文件名加 `HISTORICAL_` 或移动到 `archive/`。
- 对 inbox 记忆补一条 superseded note。
- 在 `docs/proposals/superspec/README.md` 或 index 中声明当前阅读顺序。

### P2. Role distribution 完整性不足

现状：

- `.codex/agents/{architect,critic,test-engineer,code-reviewer,verifier}.toml` 和 prompts 存在。
- guard 只检查存在、name 匹配、prompt 非空。

风险：

- 同名 prompt 被用户改写后仍可通过。
- 不同项目复制时不可重现。

证据：

- `scripts/superspec/src/gates.ts:406`
- `docs/proposals/superspec/DISTRIBUTION.md`

建议：

- 建立 `.superspec/distribution-manifest.json`。
- 记录每个 skill/agent/prompt/wrapper 的 sha256、版本、managed/preexisting 状态。

### P1. `openspec instructions` 约束仍主要是 skill 纪律

现状：

- `SPEC.md` 和 `superspec-propose` / `superspec-apply` 明确要求 OpenSpec artifacts 与 apply context 必须来自 `openspec instructions`。
- 当前 v1 guard 主要用 `openspec status` / `validate` 兜底 artifact 合法性，不能机械证明 artifact 是经 `openspec instructions` 生成或修订。
- skill smoke 当前更偏正向文本检查：确认 skill 文案包含 `openspec instructions <artifact-id>`、`openspec instructions apply` 等关键词。

风险：

- 合作型 agent 会被 skill 纪律约束；但失控或跳步 agent 仍可徒手写 `proposal.md` / `design.md` / `tasks.md` 后补齐表面 evidence。
- 如果对外说 v1 “强制使用 OpenSpec native engine”，会过度承诺；更准确说法是 v1 “要求并审计使用 OpenSpec native engine”。

证据：

- `docs/proposals/superspec/SPEC.md:629`
- `docs/proposals/superspec/SPEC.md:635`
- `.codex/skills/superspec-propose/SKILL.md:37`
- `.codex/skills/superspec-apply/SKILL.md:38`
- `scripts/superspec/tests/test_superspec_skills.test.ts:188`

建议：

- v1 文案统一使用 “must by workflow discipline / audit expectation”，不要写成 runtime proof。
- v2 若要证明该约束，需要 hook/tool trace 记录 `openspec instructions` 调用与对应 artifact write 的因果关系。
- 在 skill smoke 中增加负向断言：禁止新增“徒手 Write/update OpenSpec artifact”步骤，即使文案仍保留 `openspec instructions`。

### P1. fail-closed 声明有具体实现破口

现状：

- `SPEC.md` 要求 guard 出错时 fail-closed，特别是 git 不可用应 block。
- `dirty_write_scope_red_reasons()` 在读取 dirty worktree 失败时捕获异常并直接返回空 reasons。

风险：

- 当 git 命令不可用、仓库状态异常或 dirty path 探测失败时，部分 write_scope RED 检查会退化为“没有问题”。
- 这与 v1 audit-only 定位不冲突，但与 “guard 自身异常一律 fail-closed” 的实现承诺不一致。

证据：

- `docs/proposals/superspec/SPEC.md:384`
- `docs/proposals/superspec/SPEC.md:391`
- `scripts/superspec/src/git.ts:51`

建议：

- `dirty_write_scope_red_reasons()` 捕获 git 异常时应返回 `git_unavailable` / `dirty_worktree_unavailable` 类 block reason，而不是 `[]`。
- 增加负例测试：mock `dirty_worktree_paths()` 抛错时，`review_ready` 必须 block。

### P1. review diff coverage 对未提交/未跟踪实现文件的证明边界不够清晰

现状：

- review `source_guidance.reviewed_files` 覆盖检查使用 `git diff --name-only base..head`。
- `review_ready` 另有 dirty worktree / untracked files 检查，这是必要补充。
- 但文档没有清楚说明：`reviewed_files` 覆盖的是 base/head diff，不等于天然覆盖所有未提交、未跟踪或工作区临时实现文件。

风险：

- subagent review 可能只按 base/head diff 形成 `reviewed_files`，而遗漏未提交实现文件。
- dirty worktree guard 能挡一部分，但它和 review evidence coverage 是两套机制；如果二者边界不清，使用者会误以为 review evidence 已覆盖全部现场代码。

证据：

- `scripts/superspec/src/git.ts:74`
- `scripts/superspec/src/gates.ts:1228`
- `docs/proposals/superspec/SPEC.md:562`

建议：

- 在 review 阶段文档中明确区分 `committed diff coverage` 与 `dirty worktree attribution`。
- `source_guidance` 生成时应同时读取 base/head diff 与 `git status --short`，并在 output 中声明是否存在 untracked/dirty 文件。
- 若存在未提交实现文件，要求 main adjudication 明确说明这些文件如何被 review 或为什么被排除。

### P1. evidence 输出可读不等于内容有效

现状：

- guard 对 role evidence 会检查字段、`execution_mode`、`target_refs` fresh、`output_ref` 可读等结构条件。
- 但 v1 不能判断 `output_ref` 中的报告是否真正完成了有能力的审查、是否只是空洞模板、是否遗漏关键风险。

风险：

- “结构完整”容易被误读为“审查质量已证明”。
- 这会加重填表式流程：agent 产出字段齐全但内容空洞的 evidence，guard 仍可能通过。

证据：

- `scripts/superspec/src/evidence.ts:288`
- `scripts/superspec/src/evidence.ts:297`
- `scripts/superspec/src/gates.ts:1256`
- `docs/proposals/superspec/SPEC.md:621`

建议：

- v1 文档明确：guard 只校验 evidence schema / freshness / coverage，不证明审查质量。
- role prompt 应要求最小内容标准，如 findings 必须带 source line、claim 必须可 adjudicate、required_load_refs 不能无理由为空。
- 若要机判内容质量，只能加非常保守的结构检查；不要把它包装成 semantic review proof。

## 4. 规范与实现一致性审查

### 已一致的部分

| 主题 | 规范 | 实现 |
|---|---|---|
| 不 fork OpenSpec schema | `SPEC.md` 明确 v1 用默认 `spec-driven` | `check-init` 阻止 `openspec/schemas/superspec` |
| v1 不启用 hooks | `SPEC.md` 把 hooks 放到 v2 | `check-init` 阻止 `.codex/hooks.json` |
| review allow-only | `SPEC.md` 要求 `request_changes` 不满足 allow | `check_review_complete` 对 `request_changes` 返回 block + handoff |
| final verification 合并进 review | `SPEC.md` 说 `check-verify-ready` 是兼容别名 | `check_verify_complete` 直接调用 `check_review_complete` |
| archive 用 OpenSpec native CLI | skill 要求 `openspec archive -y` | guard 只做 archive readiness 和 preservation 检查 |

### 存在漂移或容易误导的部分

| 位置 | 问题 | 影响 |
|---|---|---|
| `DESIGN.md` | 历史草案仍详细描述 custom schema 方案 | 可能误导实现者回到已否决方向 |
| `docs/project-insights/inbox/2026-06-08-superspec-review-roles.md` | 写 review gate 是 `code-reviewer + critic` | 与当前 `code-reviewer + architect + critic` 不一致 |
| skills 文案 | 使用强硬 `must/block` 语言 | 与 v1 audit-only 强制力边界容易混淆 |
| verification evidence | 规范说引用本次 validate 输出 | 实现主要验证 ref 可读，缺运行绑定 |

## 5. 与外部框架对标

### 5.1 OpenSpec

OpenSpec 的优势是 spec-driven artifact graph、`proposal/specs/design/tasks`、`status`、`validate`、`archive` 这些正本能力。它适合管理“要改什么、为什么改、验收是什么”。

SuperSpec 的优势：

- 保留 OpenSpec 正本，不破坏团队公共契约。
- 补 OpenSpec 不管的 review、RED/GREEN、business invariant、evidence gate。

SuperSpec 的劣势：

- 比 OpenSpec 原生流程重很多。
- 如果没有真实 E2E 样本，会让使用者不确定什么时候该用哪个 gate。

参考：

- https://openspec.pro/spec-driven-development/
- https://openspec.pro/best-practices/

### 5.2 Superpowers

Superpowers 的优势是工程执行纪律：brainstorming、planning、TDD、RED/GREEN/REFACTOR、review、finish branch。它更偏 agent 操作习惯和 coding workflow。

SuperSpec 的优势：

- 比 Superpowers 更可审计，证据和 gate 更结构化。
- 更适合团队要求“每个 change 留下可复查 proof”的场景。

SuperSpec 的劣势：

- TDD 证据在 v1 仍是 self-reported，不如 runtime-captured 可信。
- 复杂度明显高于 Superpowers 的使用体验。

参考：

- https://github.com/obra/superpowers

### 5.3 Comet

Comet 的公开定位是把 OpenSpec 和 Superpowers 组合成工作流：OpenSpec 管 WHAT，Superpowers 管 HOW，Comet 管 WHEN/NEXT。

SuperSpec 的优势：

- 对 evidence、review adjudication、archive preservation 的控制更细。
- 更明确区分 audit-only 与 mechanical/runtime-verified。

SuperSpec 的劣势：

- Comet 更像可安装产品化 workflow；SuperSpec 当前更像严谨但重的本地实验框架。
- Comet 的 preset/状态推进心智更轻；SuperSpec 的 gate 面板更强但更难上手。

参考：

- https://github.com/rpamis/comet

### 5.4 GSD

GSD 更偏项目级交付纪律，强调 vision、roadmap、current state、handoff 等长期项目上下文。

SuperSpec 的优势：

- change-local 审查更细。
- 对单个 OpenSpec change 的实现质量控制更强。

SuperSpec 的劣势：

- 缺少项目级 `VISION/ROADMAP/CURRENT_STATE/SHIP_HANDOFF` 这种持续上下文。
- 对“多个 change 如何组成一次交付”管控较弱。

参考：

- https://opengsd.net/products/gsd-core

### 5.5 Spec Kit / openspec-kit 类工具

Spec Kit 类工具强在从 spec 到 plan/tasks/implementation 的脚手架和生态集成。

SuperSpec 的优势：

- 更贴合 OpenSpec brownfield change。
- 更重视 evidence 和 review proof。

SuperSpec 的劣势：

- 分发、模板、CLI 一体化程度不够。
- 当前没有足够用户路径来降低启动成本。

参考：

- https://github.github.com/spec-kit/

### 5.6 OMX / OMC

OMX/OMC 更像 agent orchestration/runtime control plane：团队协作、角色调度、hooks、状态线、目标持久化、运行时约束。它们不是 OpenSpec change workflow 本身。

SuperSpec 的优势：

- 更专注 spec-driven change 的质量闭环。
- 不需要接管整个 agent runtime 就能工作。

SuperSpec 的劣势：

- 如果目标是“防抄近路”，最终必须借 runtime/hook 能力；单靠 sidecar evidence 不够。
- 多 agent orchestration、真实 subagent runlog、工具调用证明这些能力不该在 SuperSpec v1 里硬造。

参考：

- https://oh-my-codex.dev/docs.html
- https://ohmyclaudecode.com/

## 6. 设计取舍判断

### 应该保留

- OpenSpec 正本不 fork。
- `.superspec` sidecar overlay。
- guard-owned state + fingerprint。
- review allow-only。
- `request_changes` 和 `review_complete` 分离。
- archive preservation manifest/bundle。
- v1/v2 强制力分期。

### 应该收敛

- 不要继续扩大 v1 gate 面。
- 不要在 v1 提前加入 hook adapter。
- 不要再引入新的 Markdown 表格 DSL。
- 不要把旧 `.irsflow` 兼容路径混入 SuperSpec live path。

### 应该补强

- 一个真实 `.superspec` E2E change。
- role distribution manifest/checksum。
- final verification output 与真实命令运行绑定。
- git / dirty worktree / review diff 相关 guard 的 fail-closed 语义。
- `openspec instructions` 使用链路的审计或运行时证明边界。
- role evidence 输出内容的最低质量约束。
- 结构化 sidecar 数据源。
- 历史文档和 inbox 记忆的 superseded 标记。

## 7. 推荐优先级

### 第一优先级：把 v1 说清楚

把所有对外文案统一为：

```text
SuperSpec v1 is an audit-only OpenSpec overlay for cooperative agents.
It detects missing discipline and preserves evidence.
It does not mechanically prevent bypasses.
```

### 第二优先级：跑一个真实 change

验收条件：

- 使用 `.superspec/`，不是 `.irsflow/`。
- 每个主阶段都至少跑一次 guard。
- review allow path 和 request_changes path 至少覆盖一个。
- archive 后 `.superspec` preservation 可验证。

### 第三优先级：补 evidence trust 字段

建议每条 evidence 明确：

```json
{
  "trust": "self_reported|runtime_verified|human_confirmed|openspec_fact",
  "proof_limit": "what this evidence cannot prove"
}
```

### 第四优先级：把机器判定从 Markdown 中迁出

保留 Markdown，但把 gate 关键数据迁到结构化 block 或 sidecar JSON/YAML。

### 第五优先级：v2 hook spike

只有在 v1 真实 change 跑通后，再验证：

- `PreToolUse` 是否能可靠 deny `apply_patch`。
- Bash/unified exec 绕过率是否可接受。
- `PostToolUse` 是否能捕获真实 exit code 和 output。
- `SubagentStart/Stop` 是否能提供可绑定的 `agent_id`。

### 第六优先级：补 fail-closed 与审计边界缺口

短期不扩大 v1 能力声明，只补清楚和补安全：

- git/dirty worktree 探测失败必须 block，不能返回空 reasons。
- `openspec instructions` 只能在 v1 表述为 workflow discipline / audit expectation。
- review evidence 的 `output_ref` 可读只代表材料存在，不代表审查质量已被机械证明。
- review 阶段要同时说明 committed diff coverage 与 dirty/untracked attribution。

## 8. 最终评价

SuperSpec 不是“设计错了”，而是“已经很接近一个严肃 workflow control layer，但还不能把纪律层说成强制层”。

如果目标是改善合作型 agent 的执行质量，v1 已经有价值。

如果目标是防止 agent 抄近路，v1 不够，必须等 v2 runtime hook 和真实运行取证。

如果目标是给团队长期使用，当前最大工程任务不是继续加 gate，而是降低心智负担、修复文档漂移、跑通真实样本、把 evidence trust 边界产品化。
