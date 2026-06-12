# SuperSpec Workflow Context Packet-First Merged Design

> 状态：Draft
> 目标：在不改变当前 full workflow 语义的前提下，显著降低默认模型上下文负载，并把上下文压缩路径收敛到一条可验证、可渐进迁移的实现方案。
> 关系：本设计融合 [WORKFLOW_CONTEXT_BUDGET_REDUCTION_DESIGN.md](./WORKFLOW_CONTEXT_BUDGET_REDUCTION_DESIGN.md) 与 [CONTEXT_LIGHT_FULL_WORKFLOW_DESIGN.md](./CONTEXT_LIGHT_FULL_WORKFLOW_DESIGN.md)；它保留前者的落地路径与硬约束，吸收后者的 packet shape、selector 精度与 full-path coverage 要求。

## 1. 结论

本轮合并后的正式方向是：

1. 采用 **packet-first**，但首期 packet 命令面落在现有 `superspec guard` 子命令树下，而不是立刻扩成新的顶层 `superspec workflow/evidence` 家族。
2. workflow skill、role prompt、agent TOML 收敛成薄包装层；详细 gate 协议、review contract、required loads、verbatim disclosure 需求全部由 CLI 生成 packet 提供。
3. `review-packet` 同时输出：
   - `--format agent`：给模型的紧凑任务包
   - `--format prompt`：给 `prompt_ref` 落盘的可读 reviewer prompt
4. round>1 reviewer prompt 继续内嵌由 `render_finding_ledger` 生成的 deterministic ledger block；这条 contract 不退化、不摘要化、不改成只给 JSON path。
5. OpenSpec bridge 迁移放到 packet 稳定、skill/prompt 瘦身完成之后，再作为单独阶段改造；在那之前，不能半删除 repo-local OpenSpec skill 依赖。
6. `evidence scaffold/validate`、reference pack、顶层 `superspec workflow next` 这类更大命令面不作为首期必需项；只有在 packet-first 已落地后仍存在明显机械负担时，再单独立项。

简化说：**先把“协议真相”从长文案搬进 guard 生成 packet，再瘦身文本表面；不要反过来。**

## 2. 问题定义

当前上下文过重，主因不是 gate 多，而是**同一套协议被重复写在多个静态 surface 中**。默认上下文通常会反复带上这些内容：

- workflow stage intent 和 sequencing
- guard 结果解释规则
- evidence schema 字段与禁区
- disclosure loop 规则
- review / adjudication 绑定要求
- block / reroute / reopen 分支逻辑
- OpenSpec bridge skill 的额外阶段说明

这带来两个直接问题：

1. `explore` / `propose` / `review` 在真正进入 change facts 之前，就先消耗了大量固定上下文。
2. 协议真相一部分在代码、一部分在 skill prose、一部分在 prompt / TOML，漂移风险持续存在。

## 3. 现状证据与基线口径

### 3.1 真实约束在代码里，不在 skill prose 里

当前关键 contract 已经主要实现于代码：

- gate 与前置链：`src/gates.ts`
- evidence schema、`prompt_ref` 可读非空：`src/evidence.ts`
- disclosure、round 连续性、ledger 注入校验：`src/disclosure.ts`
- CLI 与已公开命令面：`src/cli_args.ts`、`src/cli.ts`、`superspec.ts`

这说明真正应被压缩的是**模型默认读取的文本 surface**，而不是状态机本身。

### 3.2 workflow skills 里存在稳定重复面

当前五个 `superspec-*` workflow skill 都包含大量重复段落，例如：

- `## 语言规则 / Language`
- `## 命令执行 / Shell`
- `## 上下文读取纪律 / Context Budget`
- “普通 workflow 命令使用 `--format agent`”
- 用户可见文案如何翻译内部协议名

这些重复目前还被 `tests/test_superspec_skills.test.ts` 显式锁定，因此瘦身不能只改文档，必须同步改测试。

### 3.3 OpenSpec bridge 目前仍是运行时硬依赖

当前 `check-init` / `project_init` / 项目级安装仍要求 repo-local OpenSpec skills 存在且 frontmatter 合法。运行时硬依赖集合是：

- `openspec-explore`
- `openspec-propose`
- `openspec-apply-change`
- `openspec-archive-change`

因此“先删 bridge 文本，再说迁移”的路线当前不可行。

### 3.4 `prompt_ref` 与 round>1 ledger 是硬约束

role evidence 的 `prompt_ref` 现在已经被当成审计合同：

- 必须能解析到 change root 内
- 必须可读
- 必须非空

与此同时，round>1 reviewer prompt 必须逐字包含工具渲染的 ledger block；guard 会直接比对渲染结果。

这意味着 reviewer prompt 的生成必须有**一等工具面**，不能继续靠 skill/prompt 文本手拼，也不能简化成“见历史 ledger”。

### 3.5 静态 surface 基线需要区分两个口径

当前仓库里可以统计出两种有意义的静态上界：

1. **install/source static upper bound**
   - `templates/workflow/skills/<name>/SKILL.md`
   - `templates/workflow/prompts/*.md`
   - `adapters/codex/agents/*.toml`
   - `.codex/skills/<name>/SKILL.md`
2. **runtime-required static subset**
   - 上述前三类
   - 再加四个当前 runtime 真正要求的 OpenSpec bridge skill

这两种口径都只是静态上界，不等于真实单轮会话装载量。真实优化目标必须额外测量 materialized packet / prompt / loaded surface。

## 4. 设计目标

### 4.1 目标

- 保持当前用户可见 workflow：`init -> explore -> propose -> apply -> review -> archive`
- 保持当前 full gate semantics 不变
- 显著降低默认模型上下文负载，优先压缩 `explore` / `propose` / `review`
- 把 workflow routing、review contract、required loads、disclosure exactness 从 skill prose 收敛到 CLI 生成 packet
- 保留 disclosure、evidence、audit、archive preservation 的 fail-closed 语义
- 建立上下文成本的可回归指标，而不是只看文件长度

### 4.2 非目标

- 不减少 gate 数量
- 不改变 OpenSpec artifacts 的 canonical ownership
- 不弱化 `review_complete` allow-only 语义
- 不把 `prompt_ref` 改成不可读结构
- 不在第一步就删除 repo-local OpenSpec bridge
- 不在本设计里引入 lightweight preset 语义变化

## 5. 不可破坏约束

1. **状态机语义真相仍在代码里。**
   - `src/gates.ts`、`src/evidence.ts`、`src/disclosure.ts`、`src/state.ts` 仍是状态机语义的唯一真相源。
   - packet 是生成层，不是第二套手写规范。

2. **OpenSpec 仍是 proposal/specs/design/tasks 的 artifact 真相源。**
   - 正式方案产物继续通过 `openspec instructions` 生成。

3. **`prompt_ref` 仍是可读、非空文本。**
   - reviewer prompt 不能退化成“只给 JSON path”。

4. **round>1 ledger 注入 contract 必须保留。**
   - reviewer prompt 必须包含 `render_finding_ledger(...)` 的 deterministic block。

5. **pinned refs 与 exact selectors 不降级。**
   - 需要逐字 finding、decision binding、required loads 的地方，packet 只能给精确引用，不能只给摘要。

6. **现有 mutating guard path 仍是 state / ledger / archive preservation 的唯一写者。**
   - 新 packet 首期必须只读。

7. **OpenSpec bridge 迁移必须整链切换。**
   - `check-init`
   - `project_init`
   - `init_cli`
   - install/update manifest
   - docs
   - tests
   必须同一阶段改完，不能拆半。

## 6. 合并后的设计原则

### 6.1 先缩协议真相的装载面，再缩文本表面

如果先直接删 skill / prompt 文案，而没有 CLI packet 兜底，协议只会从“长文本”变成“分散短文本”，不是真正收敛。

### 6.2 让 guard 负责机械协议，模型负责语义执行

`CLI / guard` 负责：

- 当前 gate / route 识别
- allow / block 解释
- next action / next command
- must-read refs / exact selectors
- required roles / evidence kinds
- reviewer prompt 文本生成

`Model` 负责：

- 写 artifact 内容
- 理解需求与代码
- 处理 findings / claims
- 选择可辩护的 disposition
- 与用户沟通并记录确认

### 6.3 packet 分双层输出

必须同时支持：

- **agent packet**：紧凑、结构化、面向执行
- **prompt packet**：可读、可审计、可落盘到 `prompt_ref`

### 6.4 full-path coverage，而不是 happy-path only

首期 packet 不能只覆盖顺利路径。至少要覆盖：

- disclosure path
- `request_changes -> reopen_tasks`
- `change_update`
- `task_reopen`
- `task_reopen_resolved`
- apply-side gate family（至少覆盖 task edit / task complete / reopen）
- `review_standing_authorization`
- `verify_failure_handling`
- `scope_expansion`
- `human_confirmation`

## 7. 统一方案

### 7.1 首期命令面：挂在现有 `superspec guard` 下

首期新增命令：

```text
superspec guard workflow-packet --change "<change>" --gate "<gate>" [--task-id "<task-id>"] --format agent
superspec guard review-packet --change "<change>" --gate "<gate>" --role "<role>" --round <n> --format agent
superspec guard review-packet --change "<change>" --gate "<gate>" --role "<role>" --round <n> --format prompt
superspec guard ledger-render --change "<change>" --gate "<gate>" [--round <n>]
```

设计理由：

- 与当前 `superspec -> guard` 路由一致
- 首期不必改造顶层 CLI help / fallback /分发文档
- 能最大化复用现有 `dispatch` 与 guard code
- reviewer prompt 与 ledger 生成都可以直接挂在 disclosure/evidence 真实 contract 上
- `review-packet` 不只服务 repo-local role lanes，也服务 `main-thread` 的 `main_review_digest` / `main_adjudication` 写作输入，避免主线程继续依赖长 prose 记忆 contract

实现约束：

- 这三类新命令在 phase 1 必须是**严格只读**。
- 在 `src/core.ts` 中，它们必须在 `record_supersede_ledger_events(...)`、state write、archive materialization 之前短路返回；不能只是“命令名看起来像读取”，但仍沿用现有会写 state/ledger 的路径。
- 当 `gate` 属于 task-scoped apply gate（`task_edit`、`task_complete`、`task_reopen`）时，`workflow-packet` 必须要求 `--task-id`，否则无法与当前 task-specific guard reality 对齐。

CLI 输出层约束：

- 现有 decision commands 继续维持全局 `--format {json,agent,user}`。
- packet commands 不应复用 `printDecision()` 的 decision-only 输出管线。
- `review-packet --format prompt` 是 packet-surface 的专用输出模式，不是把全局 decision format 扩成第四种。
- phase 1 必须显式修改 `src/cli.ts` / `src/util.ts`，为 packet commands 增加独立的 parse/print 分支与 stdout contract。

### 7.2 顶层 `superspec workflow next` 作为后续可选 ergonomics

`superspec workflow next` 的交互语义是合理的，但它不应抢在 guard packet 之前落地。只有在 `guard workflow-packet` 已稳定、测试覆盖完整后，才考虑提供顶层别名或更友好的 wrapper。

### 7.3 packet 输出 shape

#### 7.3.1 基础类型

```ts
type pinned_ref = {
  root: "repo" | "change";
  path: string;
  blob_sha: string;
};

type finding_selector = {
  evidence_id: string;
  finding_uid: string;
  evidence_ref: pinned_ref;
};

type decision_selector = {
  evidence_id: string;
  decision_scope_key: string;
  evidence_ref: pinned_ref;
};
```

#### 7.3.2 `workflow-packet --format agent`

```ts
type workflow_packet = {
  stage: string;
  current_gate: string;
  task_id?: string;
  status: "allowed" | "blocked";
  top_blockers?: string[];
  blocker_count?: number;
  has_more_blockers?: boolean;
  next_action: string;
  next_command?: string;
  must_read_refs: pinned_ref[];
  must_read_verbatim_findings?: finding_selector[];
  must_read_verbatim_decisions?: decision_selector[];
  diagnostic_command?: string;
};
```

用途：

- skill 进入阶段时默认只读这份包
- block path 默认看摘要与 next step
- 需要 exact disclosure / decision binding 时再根据 selector 定位原文
- 当 `current_gate` 是 task-scoped apply gate 时，packet 必须带 `task_id`，并且其 `must_read_refs` / `next_action` / blockers 都以该 task 的真实上下文为准

Phase 1 收敛要求：

- `workflow_packet` 首期只承诺输出**当前 guard 代码能直接结构化导出的最小字段集**。
- 如果某字段需要从长 prose、字符串 next-actions、或新的一套手写映射中推导，不能强塞进首期 packet。
- `must_write_artifacts`、`required_subagent_roles`、`evidence_skeleton_kinds` 这类更“工作流编排化”的字段，只能在抽出共享 helper 后再进入 packet，或明确放到 phase 2。

#### 7.3.3 `review-packet --format agent`

```ts
type review_packet = {
  consumer: "role" | "main-thread";
  gate: string;
  role: string;
  round: number;
  target_refs: pinned_ref[];
  source_refs: pinned_ref[];
  required_load_refs?: pinned_ref[];
  required_claim_ids?: string[];
  must_read_verbatim_findings?: finding_selector[];
  must_read_verbatim_decisions?: decision_selector[];
  required_output_kind: string;
  output_contract_fields: string[];
  required_review_scope?: string[];
  stop_conditions: string[];
};
```

用途：

- role prompt 不再内嵌长 schema prose
- main thread 不再从长 prompt 记忆 required loads / claims / disclosure exactness
- review lane 使用 packet 明确当前轮最小任务包

补充规则：

- 当 `role` 是 repo-local reviewer role（如 `critic`、`architect`、`verifier`）时，`review-packet` 输出该 lane 的最小任务与 evidence contract。
- 当 `role` 是 `main-thread` 时，`review-packet` 输出主线程当前需要编写的 contract：
  - propose/disclosure gates：`main_review_digest`
  - final review：`main_adjudication`
- 若后续需要 `fixed_field_values` 之类的 richer packet 字段，前提是先把对应固定值抽成 check 与 packet 共用的 helper；phase 1 不要求一次把所有机械字段都塞进 packet。

#### 7.3.4 `review-packet --format prompt`

这不是 JSON skeleton，而是**最终 reviewer prompt 文本**。要求：

- 可读
- 可直接落盘为 `prompt_ref`
- round 1 输出最小化正文
- round > 1 自动插入 deterministic ledger block
- 文本主体只保留角色目标、当前轮输入、输出 contract、停止条件

### 7.4 `ledger-render` 的职责

`ledger-render` 继续作为 round>1 reviewer prompt 的唯一 ledger 生成器。其输出必须与 `render_finding_ledger(...)` 对齐，避免出现“skill prose 里有一版说明，guard 比对的是另一版”的情况。

### 7.5 packet 直接由现有真相源生成

这里要区分两层“真相”：

1. **state-machine truth**
   - `src/gates.ts`
   - `src/evidence.ts`
   - `src/disclosure.ts`
   - `src/state.ts`
2. **packet / CLI surface truth**
   - 上述 state-machine truth
   - 再加 `src/core.ts`、`src/openspec.ts`、`src/util.ts`
   - 因为它们决定了 change context 读取、命令分发、route normalization、只读命令的输出边界与打印管线

packet surface 不是新的语义真相源，但它的实现与输出 contract 必须复用这层 CLI surface truth。

packet 数据必须从以下代码读取，而不是维护第二套文档化枚举：

- `src/core.ts`
  - change context 读取
  - command dispatch
  - 只读命令与写路径的真正分叉点
- `src/gates.ts`
  - gate 前置链
  - next actions
  - route phase
  - OpenSpec / SuperSpec init 健康面
- `src/evidence.ts`
  - role evidence / main adjudication / verification contracts
  - `prompt_ref` / `output_ref` / pinned refs 校验
- `src/disclosure.ts`
  - review targets
  - round numbering
  - digest binding
  - ledger render
- `src/openspec.ts`
  - gate / route normalization
  - OpenSpec floor 与 route clamp 相关逻辑
- `src/state.ts`
  - 现有 state / ledger write contract
  - read-only packet 命令必须绕过的写路径边界
- `src/util.ts`
  - evidence kind 集合
  - required role 集合
  - safe agent render 边界

必要时允许新增：

- `src/packet_schema.ts`
- `src/packet_render.ts`
- `src/packet_measure.ts`

但这些只能是**生成与渲染层**，不能再复制状态机判断。

实现要求：

- packet surface 必须优先复用现有 read/evaluate helpers，而不是从 `gates.ts` 输出后再在新层二次拼装路由真相。
- 只读 packet 命令的 stop line 必须以 `src/core.ts` 的实际分发与写路径为准，而不是只在设计层声明“理论上只读”。
- 如果某个 packet 字段在当前仓库里只能靠解析字符串、复制 long prose、或新建并行枚举才能得到，那么该字段不属于首期 packet；要么先抽共享 helper，要么后移到 phase 2。

## 8. surface 瘦身方案

### 8.1 Thin workflow skills

五个 `superspec-*` workflow skill 收敛为薄包装，只保留：

- 本阶段职责
- 第一条必跑命令
- 与 OpenSpec 的交互边界
- 用户确认边界
- native subagent 边界
- 遇到 guard `block` 立即停止

从 skill 中移除：

- 完整 evidence schema 清单
- disclosure loop 的长 prose
- route matrix 大段说明
- review / adjudication 字段大全
- 大量重复的 block handling 文案

### 8.2 Thin role prompts

role prompt 只保留：

- 角色身份
- 读写边界
- 输出风格
- “先读取 review-packet”的硬规则

详细输出 contract 由 `review-packet` 注入，不再常驻 prompt 正文。

### 8.3 Thin agent TOML

agent TOML 只保留：

- role name / description
- prompt binding
- 最小 developer instructions

不再承载大段重复协议解释。

## 9. OpenSpec bridge 迁移策略

### 9.1 现阶段结论

在 packet-first、skill 瘦身、prompt 瘦身完成之前，不迁移 OpenSpec bridge。

### 9.2 后续迁移目标

迁移完成态应当是：

- workflow packet 直接指向需要使用的 OpenSpec CLI surface
- `check-init` 不再因为缺 repo-local OpenSpec skill 文本而 block
- `project_init` / `superspec init --scope project` 不再强制回补 `.codex/skills/openspec-*`

### 9.3 迁移时必须同时修改

- `src/gates.ts`
- `src/project_init.ts`
- `src/init_cli.ts`
- `src/util.ts`（尤其是 `REQUIRED_OPENSPEC_CODEX_SKILLS` / CLI surface truth 常量）
- `docs/SPEC.md`
- `docs/DISTRIBUTION.md`
- `adapters/codex/install-map.json` 与相关 manifest/install truth
- install manifest / install engine tests
- skill smoke tests

只删 `check-init` 的 block 条件，不改安装链路，属于明确禁止的半迁移。

## 10. 明确延后的内容

### 10.1 `evidence scaffold/validate`

这条能力是合理增强，但不作为首期必需项。

原因：

- 它主要解决“机械字段生成与校验重复”，不是“默认上下文过重”的根因
- 提前引入会扩大 CLI surface、测试面与 adoption 成本
- packet-first 成功后，再看是否仍需要把 evidence 机械字段进一步下沉给 CLI

结论：作为可选 Phase 5，不进入首期收敛目标。

### 10.2 reference pack

长协议迁移到 reference pack 的思路可保留为备用，但它不应在 phase 1 成为新的 `check-init` 硬依赖。

原因：

- 它会引入新的安装/校验/manifest surface
- 如果 references 仍被安装并强校验，静态 surface 虽然“默认不读”，但维护面并未真正减少

结论：phase 1 不做。只有当 thin skill + packet 之后仍需要保留较长的离线说明材料，才考虑把 references 作为非默认、非 gate-blocking 的附属材料。

## 11. 上下文指标与度量

必须把以下指标做成可回归测试或固定测量脚本：

- `fixed_surface_chars_install_upper_bound`
- `fixed_surface_chars_runtime_required_subset`
- `materialized_workflow_packet_chars`
- `materialized_review_packet_chars`
- `materialized_review_prompt_chars`
- `ledger_block_chars`
- `representative_loaded_surface_chars`

### 11.1 代表场景

至少固定以下代表场景：

- `explore_complete`
- `proposal_reviewed`
- `design_complete`
- `test_contract_drafted` 或 `invariants_reviewed`
- `apply_ready`
- `review_complete` allow path
- `archive_ready`
- 一个 round>1 reviewer prompt
- 一个 `request_changes -> reopen_tasks` path
- 一个 `task_reopen -> task_reopen_resolved` path
- 一个 `scope_expansion` 或其他 apply-side user confirmation path

### 11.2 口径要求

所有“降低 50%”的验收都只能针对：

- 固定文本 surface
- materialized packet
- reviewer prompt 文本

不能把 ledger block 成本藏到 `prompt_ref` 里再宣称达标。

## 12. 分阶段改造计划

### Phase 0：补测量

输出：

- 基线测量脚本或测试
- 固定代表场景报告
- install upper bound 与 runtime-required subset 的双口径报表

### Phase 1：落 `guard` packet surface

输出：

- `workflow-packet`
- `review-packet`
- `ledger-render`
- `src/cli.ts` / packet stdout contract 分支
- `src/util.ts` / packet print helpers 与 packet-specific format handling
- `src/cli_args.ts` / guard parse/help 更新
- `docs/SPEC.md` 中 guard command surface 更新
- `tests/test_superspec_guard.test.ts` 的命令面与帮助输出更新

要求：

- 全部只读
- packet commands 不走旧的 `printDecision()` 输出管线
- 覆盖 full-path，而不是只做 happy path
- round>1 prompt 继续通过 ledger 注入校验
- task-scoped apply packet 必须支持 `--task-id`
- 首期覆盖的 gate family 至少包含 `explore_complete`、`proposal_reviewed`、`design_complete`、一个 Phase 3 propose gate、`apply_ready`、`task_edit`、`task_complete`、`task_reopen`、`review_complete`、`archive_ready`
- 首期 packet shape 只包含当前代码能直接结构化导出的最小字段集；更 rich 的 orchestration fields 以后续 helper extraction 为前提
- `main-thread` consumer 的 digest / adjudication packet 单独有 contract tests

### Phase 2：瘦身 workflow skills

输出：

- 五个 skill 改成薄包装
- 安装产物同步更新
- skill tests 从“锁定长文案”迁移到“锁定 wrapper 行为”

### Phase 3：瘦身 role prompts 与 agent TOML

输出：

- prompts 改成 packet-driven
- TOML 去掉重复协议
- reviewer lane contract 继续通过 guard / schema 测试

### Phase 4：OpenSpec bridge 迁移

输出：

- 从 repo-local OpenSpec skill bridge 迁移到 OpenSpec CLI surface
- `check-init` / `project_init` / install / docs / tests 全部同步切换

### Phase 5：可选增强

仅在前四阶段落稳且确认仍有必要时，再评估：

- `evidence scaffold/validate`
- 顶层 `superspec workflow next`
- 非默认 reference pack

## 13. 测试要求

### 13.1 Parity tests

必须验证 packet 与既有 guard reality 一致，至少覆盖：

- `proposal_reviewed` disclosure path
- `apply_ready`
- `review_complete` allow path
- `archive_ready`
- `request_changes -> reopen_tasks`
- `task_reopen -> task_reopen_resolved`
- apply-side task edit / task complete 至少一条代表路径
- `verify_failure_handling`
- `scope_expansion`
- packet commands 在运行前后不改变 `.superspec/ledger.jsonl`、`.superspec/superspec-state.json`、archive preservation 相关产物

### 13.2 Width tests

必须防止 packet 自己重新膨胀成第二个长协议面。需要测试：

- 字段白名单
- 摘要长度上界
- 不把完整 schema prose 塞回 packet

### 13.3 Contract tests

必须继续覆盖：

- `prompt_ref` 可读非空
- round>1 ledger 注入
- `required_load_refs -> loaded_refs` 精确匹配
- `main_adjudication` allow-only / request_changes route 语义
- OpenSpec bridge 迁移前后的 init health surface
- packet commands 的 stdout / exit-code contract 与 decision commands 分离
- packet commands 的非变更合同：必须在 `record_supersede_ledger_events(...)`、state write、archive preservation materialization 之前短路，且有显式回归测试锁定这一点
- `consumer=main-thread`、`gate in disclosure gates` 时，`review-packet` 输出 `main_review_digest` contract
- `consumer=main-thread`、`gate=review_complete` 时，`review-packet` 输出 `main_adjudication` contract
- 上述两类 main-thread packet 必须单独锁定 `required_load_refs`、`required_claim_ids` 与 finding coverage；若后续引入 `fixed_field_values`，再为其单独补 contract tests

对于 disclosure / ledger，不能只保留“代表路径覆盖”。下列 fail-closed 合同在 packet-first 之后仍必须逐项有回归锁点：

- `review_complete` 禁止 `main_review_digest`
- `review_standing_authorization` schema / binding
- finding identity fields 不得改写
- material finding `summary` 必须 verbatim
- `user_review_decision` / baseline / standing authorization 绑定
- `accepted_deviation` clean-round acknowledgement
- disposition `route` legality
- review round continuity / digest chain continuity
- round>1 ledger 注入
- round budget exhaustion

这些锁点可以迁移测试位置，但不能退化成“只测一条 happy-path parity”。

### 13.4 Skill tests migration

现有 skill smoke tests 需要**分两类迁移**，不能一次性整体放松：

#### 13.4.1 可在 phase 2 迁出的重复文案锁点

这类可以从 skill 正文里迁出，只要已有等价 packet / user-facing invariant 测试接住：

- `## 语言规则 / Language`
- `## 命令执行 / Shell`
- `## 上下文读取纪律 / Context Budget`

#### 13.4.2 在 bridge/review/disclosure 迁移完成前不得提前删除的锁点

以下锁点在 phase 2/3 **不得因为 thin skill / thin prompt 而提前删除**；只有等价 contract tests 或 phase 4 bridge 迁移完成后，才允许迁走：

- 显式 bridge 文本路径
- review 阶段 repo-local native agents 约束
- `check-init` / `openspec validate` / `review_complete` allow-only
- `main_adjudication` 作者边界与 request-changes route contract
- disclosure / ledger 的 fail-closed user-facing protocol anchors

换句话说：skill 文本可以变薄，但这些合同的**测试锁点不能先变薄**。

改为锁定：

- skill 是 thin entrypoint
- 调用了正确 packet command
- 遇到 block 停止
- 仍维持必要的 user-facing 不变量
- bridge/review/disclosure 旧锁点在删掉前，必须已经有等价的新测试面接住

## 14. 验收标准

本设计完成时，至少满足：

1. 默认加载任一 `superspec-*` skill 不再把完整 schema / route / review contract prose 拉进上下文。
2. `workflow-packet --format agent` 足以驱动下一步普通执行。
3. `review-packet --format prompt` 足以生成可落盘、可校验的 `prompt_ref`。
4. round>1 reviewer prompt 继续通过 ledger 注入校验。
5. `review_complete`、`proposal_reviewed`、`design_complete` 等关键 gate 语义不回归。
6. OpenSpec bridge 删除前，init / install / docs / tests 已整链迁移。
7. 固定 surface、materialized packet、reviewer prompt 三类预算都有可回归数据。

## 15. 明确拒绝的替代方案

### 15.1 只 slim 技能文案，不做 packet

拒绝原因：

- 协议真相仍分散
- reviewer prompt / ledger 生成仍无一等入口
- 长期仍会继续膨胀

### 15.2 先上顶层 `superspec workflow next`

拒绝原因：

- 当前公开 CLI surface 明显以 `guard` 为中心
- 顶层命令面改动更大
- 首期收益不如直接在现有 `guard` 子树内落 packet

### 15.3 先删 OpenSpec bridge

拒绝原因：

- 当前 runtime / init / tests 仍把 bridge 当硬依赖
- 会制造“运行协议与安装协议脱节”的半迁移状态

### 15.4 把 reviewer prompt 变成只给 JSON path

拒绝原因：

- 直接违反 `prompt_ref` 可读、非空合同
- 直接破坏 round>1 ledger 注入校验路径

### 15.5 把 reference pack 做成新的默认硬依赖

拒绝原因：

- 可能把上下文优化做成新的安装与维护负担
- 在 packet-first 之前没有必要

## 16. 最终建议

正式实施时，以本设计为准：

1. 先补测量
2. 在 `superspec guard` 下落 packet
3. 再瘦身 skills
4. 再瘦身 prompts / TOML
5. 最后迁移 OpenSpec bridge

这条顺序的核心价值是：**上下文会先变短，而且不会把状态机真相、`prompt_ref` 合同和安装协议拆成几份互相漂移的东西。**
