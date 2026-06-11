# SuperSpec 工作流规范源 v0.4

> 状态：v0.4 草案（待评审定稿）。
> 本文是 **单一规范源**。当前 v1 正式定位为 **audit-only discipline layer**：面向合作型 agent 的 OpenSpec overlay，用于检测流程纪律缺失、保留 evidence、降低无意识跳步概率；它不宣称 mechanical enforcement，也不能机械阻止绕过、伪造 evidence 或跳过 guard。v1 保持 OpenSpec 默认 `spec-driven` schema，不 fork/替换 OpenSpec artifact graph；同步产出 `.codex/skills/superspec-*`、guard 脚本与 sidecar 模板。`.codex/hooks.json` 与 hook adapter 属于 v2，必须在 v1 跑通后再做。
> 名称正式定为 **SuperSpec**（技术标识统一用小写 `superspec`：目录/CLI/dotfile/skill 名/状态文件，常量用 `SUPERSPEC_*`，驼峰标识符用 `SuperSpec`）。
> 用户可见主流程固定为：project init（`superspec-init` / 仓内开发入口 `superspec_init.ts`）-> `explore -> propose -> apply -> review -> archive`。`review` 阶段内含 final verification；`check-verify-ready` / `verify_complete` 仅作为兼容入口，不是独立用户可见主阶段。OpenSpec 的 `proposal/specs/design/tasks` 四件套全部属于 SuperSpec `propose` 阶段内部产物；`test-contract` 是 propose 内部 sidecar，不是主阶段。

## 0. 文档状态与版本关系

| 文档 | 角色 |
|---|---|
| `SPEC.md`（本文） | v0.4 单一规范源，**取代** `docs/history/DESIGN.md` / `docs/history/DUAL_TRACK_REFACTOR_PLAN.md` 作为实施依据 |
| `docs/history/DESIGN.md` | v0.1 原始设计稿，保留为历史与对照（其"零平行状态机"与 custom schema 方向已被本文修正） |
| `docs/history/DUAL_TRACK_REFACTOR_PLAN.md` | gpt5.5 双轨状态层方案，其 L1–L3 状态/证据骨架被本文采纳，保留为对照 |

本文相对前两稿的关键变更：

0. **明确 v1 定位**：v1 是 `audit-only discipline layer` / `cooperative agent discipline`，不是机械强制层；`must` / `block` / `不得` 等词在 v1 语境下表示 guard 结构判定与流程纪律，不表示运行时不可绕过。
1. **翻案"零平行状态机"**：v0.1 主张 SuperSpec 完全不持有状态、全靠 `openspec status` 现场推导，导致流程把控力不足。v0.2 引入 **guard-owned 受控状态**（来自双轨方案），区分"可被重新校验的受控状态"（合法）与"可覆盖 OpenSpec 事实的漂移状态"（非法）。
2. **规划 L4 Codex Hook 强制层（v2）**：已确认 Codex CLI 0.136.0 支持 hooks 框架与 `PreToolUse` deny 接口；真实物理 deny、绕过率和时延必须等 v1 跑通后做 R-1 spike，再决定是否升级为"物理拦截 + 运行时取证 + 事后稽核"三道防线。
3. **补入成熟控制面**：规模分级（hotfix/tweak preset）、脏工作区协议、人审阻塞点、单一 transition writer、fingerprint 防漂移。
4. **纠正 schema 扩展边界**：不再把 `test-contract` 做成 OpenSpec custom artifact；OpenSpec 继续使用默认 `proposal/specs/design/tasks` 流程，`test-contract`、多角色审查、红绿灯证据作为 SuperSpec sidecar gate。
5. **补齐 critic 对抗审查的剩余 blocker/major**：M5 红绿灯适配、test-contract 兑现校验、§8.4 diff 机制、guard fail-closed、evidence 内容指纹。
6. **纠正阶段划分**：`design` / `test-contract` / `tasks` 不再作为用户可见主阶段；它们统一收进 `propose` 内部 gate，避免 SuperSpec 阶段名和 OpenSpec artifact 名互相误导。
7. **收敛 review/verify 表面**：v1 用户可见 skill 保持 5 个（`superspec-explore/propose/apply/review/archive`），项目初始化由 `superspec-init`（仓内开发入口 `superspec_init.ts`）完成；final verification 合并到 `superspec-review`，旧 `check-verify-ready` 仅作为兼容别名。

### 0.1 已确认边界（已测事实 + 官方接口 + 待实测项）

| 边界 | 验证方式 | 影响 |
|---|---|---|
| Codex 0.136.0 **支持 hooks 框架**，`PreToolUse` 文档声称可返回 `permissionDecision:"deny"`（接口存在） | `codex --version`（版本已确认）+ 官方文档 developers.openai.com/codex/hooks | L4 接口存在；**deny 的真实行为未实测，见 R-1** |
| 官方文档显示 `PostToolUse` 可拿到 Bash 命令真实 `exit_code` 与 `tool_response` | 官方文档 | v2 可用于自动生成 RED/GREEN evidence；v1 不依赖、不验收 |
| 官方文档显示 `SubagentStart/SubagentStop` 提供真实 `agent_id`/`agent_type` | 官方文档 | v2 可用于运行时核验 subagent evidence；v1 不依赖、不验收 |
| Codex hook 失败/返回不支持字段时默认 **continue tool call（fail-open）** | 官方文档 | guard-as-hook 必须自捕获异常、主动 `exit 2` 才能 fail-closed |
| `PreToolUse` 是 guardrail 非完整边界，`unified_exec` 流式 shell 拦不全 | 官方文档原文 | 残留逃逸必须诚实记录，禁止夸大"严格强制" |
| `openspec status --change <c> --json` ≈ 2.6KB；核心字段 `artifacts[].status = done/ready/blocked` + `missingDeps` | `wc -c` 实测 | guard 在脚本内部消化，判定结果才回模型；v2 hook 也复用同一精简输出，不占主上下文 |
| `openspec schema init --artifacts` 仅接受内置 `proposal,specs,design,tasks`，且 schema 命令标 experimental | `schema init --help` 实测 | v1 不把 SuperSpec 建在 custom schema 上；`test-contract` 改由 sidecar + guard 管控 |
| 默认 `spec-driven` 下 `openspec archive` 会随 change 目录迁移并保留 `.superspec/` 隐藏目录 | R-2 spike：`/tmp/superspec-archive-spike.PveD8g`，OpenSpec 1.4.1，archive 后 `.superspec/config.yaml`、`superspec-state.json`、`artifacts/test-contract.md`、`evidence/dummy.json` 均保留 | v1 可把 `.superspec/` 放在 change root；仍需回归测试和 preservation manifest 防未来行为变化 |

---

## 1. 背景与目标

### 1.1 四个痛点（来自实践）

1. **design 不够细致**：质量靠主观，缺强制完备性维度。
2. **test 太简单**：覆盖不足，无强制覆盖矩阵，开发后问题多。
3. **任务拆分无串并行**：tasks 平铺，无依赖/并行组/写范围标注。
4. **缺多视角对抗**：单一视角生成，无对抗审查/code review，大迭代时实现与需求易偏离。

### 1.2 两套旧草稿的强项与硬伤

- `yourflow`（`.yourflow/` + 分片 JSON）：**强项** 强制 Subagent Execution Boundary（主线程只编排，审查/调查必须 subagent 带证据）；**硬伤** `state.json.current_phase` 是不受约束的平行状态机。
- `workflow`（`.ai-workflow/` + `workflow_guard.py`）：**强项** 可执行 guard 硬门禁、独立 code review、rollback/invalidation schema；**硬伤** 无 subagent 约束（主线程可自审）、`gate-ledger` 也自立 stage。

### 1.3 设计目标

- **G1** 在 OpenSpec 原生流程上加阶段、加验证：需求澄清更全面、设计更完备、测试更严格、实现后有 code review。
- **G2** 每阶段引入**多视角对抗审查**（按阶段配不同/多个 subagent 角色）。
- **G3** 测试严格遵循 **superpowers 风格红绿灯**（RED→GREEN→REFACTOR + Iron Law）。
- **G4** 扫描/调查交给 **subagent 带证据回传**，主线程只编排与确认（保护主上下文）。
- **G5** **单一规范源**，不再有多套各自维护的工作流。
- **G6**（分期目标）v1 明确只做 **audit-only discipline layer**：通过 guard、sidecar evidence、指纹和 review adjudication 规范合作型 agent；真正的 mechanical enforcement / runtime-verified 取证只属于 v2 hook，且必须在 R-1 spike 证明可靠后才可声明。

---

## 2. 第一原则与状态哲学

### 2.1 单一真相源

> **可验证事实 = OpenSpec status（artifact 存在性/依赖）+ 工作区文件 + append-only evidence。这是唯一真相源。**

### 2.2 受控状态合法，漂移状态非法

状态本身不是问题——没有状态，恢复、暂停点、用户决策、task 会话、review disposition 都难管理。问题在于状态**能否被重新校验**：

| 状态类型 | 判定 |
|---|---|
| 能被 OpenSpec status + evidence 重新校验、只由 guard 写入、带指纹 | ✅ 控制工具（合法） |
| 不能被重新校验、可覆盖 OpenSpec 事实 | ❌ 漂移来源（非法） |

这条统一了"要状态控制"与"别漂移"两个看似冲突的诉求。

### 2.3 同步判定公式

```text
effective_allowed = OpenSpec minimum satisfied
                AND SuperSpec evidence gates satisfied
                AND state fingerprints consistent
```

任一不满足即 block。`superspec-state.json` 的任何字段都**不能**单独让推进通过。

### 2.4 四层架构

| 层 | 职责 | 落地物 | 强制力 |
|---|---|---|---|
| **L1 OpenSpec 正本轨** | 原生 `spec-driven` artifact 状态 + apply 任务追踪 | 默认 OpenSpec schema | OpenSpec 原生 |
| **L2 SuperSpec 控制轨** | guard-owned 受控状态 + sidecar artifacts/evidence | `.superspec/superspec-state.json` + `artifacts/` + `evidence/` | 数据契约 |
| **L3 Sync Guard** | 现场对账两轨，算 allow/block，唯一状态写入器 | guard 脚本 | 逻辑判定 |
| **L4 Codex Hook**（v2） | 物理拦截违规工具调用 + 运行时取证 | `.codex/hooks.json` + guard | **v2 目标：物理强制（R-1 通过后）** |

---

## 3. 架构总览

```text
┌──────────────────────────────────────────────────────────────┐
│ L1 OpenSpec Canonical Track                                    │
│ proposal/specs/design/tasks (all produced inside SuperSpec propose)│
│ 唯一阶段真相：openspec status --json                            │
└──────────────────────────────────────────────────────────────┘
                          │ read-only status (guard 自己跑)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ L2 SuperSpec Control Track                                       │
│ superspec-state.json + sidecar artifacts/evidence                 │
│ guard_route_phase 只做命令路由（无进度语义，见 §5.3），          │
│ 绝不做 OpenSpec done 真相                                        │
└──────────────────────────────────────────────────────────────┘
                          │ synchronized recompute
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ L3 Sync Guard  （唯一状态写入器 + 唯一放行器）                   │
│ effective = OpenSpec minimum AND evidence AND fingerprint ok   │
└──────────────────────────────────────────────────────────────┘
                          │ v2: 作为 hook 脚本被调用，判定回传 allow/deny
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ L4 Codex Hook Enforcement（v2 target, gated by R-1）            │
│ PreToolUse(apply_patch/Bash) deny 违规编辑/归档                 │
│ PostToolUse 捕获真实测试输出 → RED/GREEN evidence               │
│ SubagentStart/Stop 记录真实 agent_id → evidence 防伪            │
└──────────────────────────────────────────────────────────────┘
```

> v1 验收范围只有 L1 + L2 + L3（audit-only）。L4 是 v2 overlay，不参与 v1 交付、测试或验收。

---

## 4. L1：OpenSpec 正本轨

### 4.0 增强边界（红线，回应「不能把 OpenSpec 改造成 SuperSpec 流程」）

SuperSpec 的定位是 **overlay（叠加层）**，不是 **replacement（替换层）**：

| 做法 | SuperSpec 是否采用 | 原因 |
|---|---|---|
| 继续使用 OpenSpec 默认 `spec-driven` schema | ✅ 必须 | OpenSpec artifact graph 是团队/工具链的公共契约，SuperSpec 不私有它 |
| 在 change 上用 `openspec status` 读正本进度 | ✅ 必须 | OpenSpec 仍是唯一 artifact 存在性真相 |
| 用 skills 要求更完整的 proposal/design/tasks 内容 | ✅ | 增强在 prompt/纪律层，不写进 OpenSpec schema |
| 用 Sync Guard 加 superspec-only gate（审查、test-contract、RED/GREEN） | ✅ | 「可以比 OpenSpec 多」体现在这里 |
| fork schema / 新增 OpenSpec artifact（如把 `test-contract` 塞进 graph） | ❌ 禁止 | 等于把 SuperSpec 流程烙进 OpenSpec，耦合 schema 演进，且让非 SuperSpec 用户也被迫走 SuperSpec 流程 |
| 改 OpenSpec `requires` 链表达 SuperSpec 阶段 | ❌ 禁止 | 阶段顺序由 guard 的 `effective_allowed` 表达，不靠改 graph |
| 让 SuperSpec state 覆盖 OpenSpec status | ❌ 禁止 | 双轨同步公式不变 |

**判定口诀**：凡是要「多出来的流程/质量/证据」，放 `.superspec/` + guard gate + skill；凡是要判断「OpenSpec 认不认这个文件算 done」，只尊重 OpenSpec 原生四个 artifact，且不改 schema。

> `openspec/schemas/superspec/` 若存在，视为**错误方向的 spike/负例**（演示了「改造 graph」反模式），v1 **不得**安装、不得作为 change 的 `--schema`。实施只认 `spec-driven` + SuperSpec overlay。

### 4.1 正本 artifact 链（不改，但归入 propose）

SuperSpec v1 **不 fork OpenSpec schema，不新增 OpenSpec artifact，不改 OpenSpec instruction/template**。OpenSpec 保持默认 `spec-driven`：

| # | OpenSpec artifact | generates | SuperSpec 归属 | 说明 |
|---|---|---|---|---|
| 1 | `proposal` | proposal.md | `propose` 内部 | 变更 WHY/WHAT、Capabilities、Impact |
| 2 | `specs` | specs/**/*.md | `propose` 内部 | 需求与 `#### Scenario`，继续使用 OpenSpec 原生校验 |
| 3 | `design` | design.md | `propose` 内部 | 高层设计决策，继续作为 OpenSpec 正本 artifact |
| 4 | `tasks` | tasks.md | `propose` 内部 | 实现任务清单，继续由 OpenSpec apply 跟踪 checkbox |

OpenSpec 的 artifact 真相只来自 `openspec status --change <c> --json`。SuperSpec 可以在 skill prompt 中要求更完整的 proposal/design/tasks 内容，但这些要求不写入 OpenSpec schema；是否满足由 Sync Guard 和 review evidence 检查。对外工作流仍是 `project init -> explore -> propose -> apply -> review -> archive`，其中 `propose` 完成后才允许进入 `apply`，final verification 收在 `review` 阶段内。

### 4.2 SuperSpec sidecar artifacts

SuperSpec 自己新增的产物不进入 OpenSpec artifact graph，固定放在 change 内 `.superspec/artifacts/`：

```text
openspec/changes/<change>/.superspec/artifacts/
  discovery.md       # 现状调查与隐性合约
  business-invariants.md # 业务不变量 + source anchors + enforcement level
  test-contract.md   # 测试覆盖矩阵 + 红绿灯契约 + Iron Law
```

其中 `business-invariants.md` 和 `test-contract.md` 是 SuperSpec 的必需 sidecar artifact，不是 OpenSpec 正本 artifact。Sync Guard 负责在进入 apply / task edit / task complete 前校验它们存在、结构有效，并与 `specs/**/*.md`、`tasks.md`、RED/GREEN evidence 交叉一致。

### 4.3 增强 gate 不进 OpenSpec graph

`business-invariants` / `test-contract` / `review` / `verification` / `archive-preservation` 均不进入 OpenSpec pre-apply graph，作为 SuperSpec evidence gate：

```text
.superspec/artifacts/business-invariants.md
.superspec/artifacts/test-contract.md
.superspec/evidence/{discovery,design,invariants,test-contract,tasks,red,green,reviews,verification,archive}/
```

这样保留 OpenSpec 原生职责：OpenSpec 管 change/spec/task 生命周期；SuperSpec 管流程纪律、状态恢复、证据、审查与红绿灯。v2 若 hook 可用，也只把 Sync Guard 挂到 Codex 工具调用前后，仍不改 OpenSpec schema。

---

## 5. L2：SuperSpec 控制轨（状态 + 证据）

### 5.1 目录结构

以下是 change 运行过程中的**稳态布局**。v1 init 不要求一次性创建完整目录：`superspec-init`（仓内开发入口 `superspec_init.ts`）安装/校验项目级 OpenSpec skills、repo-local role surfaces，并以 **manifest-driven 安装引擎**（D4 / 审计 G-1，`src/install_engine.ts`）按 `adapters/codex/install-map.json` 安装 SuperSpec 自身的 workflow skills / prompts / agents / wrappers，写 `.codex/superspec/install-manifest.json`（schema：`schemas/install-manifest.schema.json`；manifest sha256 = managed 基线，用户改过的文件永不覆盖/删除）。`superspec-init --update` 按 manifest 三态升级（未改→滚动、改过→保留 + `*.new`、下架且未改→删除）；`--uninstall [--dry-run]` 只删未被改动的 managed 文件，`.superspec/` 运行数据与 preexisting 文件一律不碰。change 级 `superspec-guard init` 只需创建 `.superspec/superspec-state.json` 与 `.superspec/ledger.jsonl`。`artifacts/`、`evidence/`、`handoffs/`、`reports/`、`raw/` 由后续阶段按需 lazy-create。

```text
openspec/changes/<change>/.superspec/
  config.yaml         # optional change-local SuperSpec 配置（唯一人工可编辑配置名）
  superspec-state.json  # guard-owned 受控状态（唯一 guard 写）
  superspec-state.lock  # 原子写锁
  ledger.jsonl        # append-only 事件索引
  artifacts/
    discovery.md business-invariants.md test-contract.md
  evidence/
    discovery/ design/ invariants/ test-contract/ tasks/
    red/ green/ reviews/ verification/ archive/
  handoffs/           # 机器生成的阶段交接包（带 source/hash）
  reports/  raw/      # subagent 报告原文、测试原始日志
  subagent-runlog.jsonl   # v2 optional：L4 SubagentStart/Stop hook 写入的真实 subagent 启动记录；v1 不要求存在
```

**`.superspec/` 的 git 跟踪策略（审计 H-3/D-2，用户裁决 2026-06-10：交给最终用户选择）**：SuperSpec 将拆分为独立工具（类 openspec 形态）分发；`.superspec/` 是否进宿主仓库的 git **由使用方项目自行决定**，v1 不强制、不自动 commit。必须诚实声明的代价：untracked 状态下 append-only ledger 的载体只是普通文件——误删 / `git clean -fd` 后历史无痕消失，evidence 的"可审计"承诺只在文件存活时成立（删除式洗白在 untracked 形态下不可防）；archive manifest 同理没有外部锚点。**推荐配置（写入使用方文档/init 提示，不由 guard 强制）**：ledger + evidence JSON + archive manifest 入库，`reports/`、`raw/`、`handoffs/` 走 gitignore 并在 evidence 中以 sha256 锚定（schema 已含内容指纹字段，见 §5.5）。未来安装引擎（D4）可在 init 时询问用户选择并生成对应 .gitignore 片段。

### 5.2 配置文件命名规范

SuperSpec 配置文件名必须统一，避免 `.superspec.yaml` / `superspec.yaml` / `superspec.json` / `.superspecrc` / `config.json` 混用：

| 范围 | 唯一路径 | 用途 |
|---|---|---|
| 项目级默认配置（可选） | `.superspec/config.yaml` | preset 默认值、角色矩阵、命令探测、项目级 allow/deny 规则；缺失时使用内置 defaults |
| change 级覆盖配置（可选） | `openspec/changes/<change>/.superspec/config.yaml` | 本 change 的 preset、风险升级、build/test/verify 命令覆盖；缺失时继承项目配置/内置 defaults |
| guard 运行态 | `openspec/changes/<change>/.superspec/superspec-state.json` | guard-owned 派生状态，**不是配置文件**，人工不得编辑 |

读取优先级：change `config.yaml` 覆盖项目 `.superspec/config.yaml`；缺省值来自 SuperSpec 内置 defaults。所有配置必须能被 guard 解析、规范化并写入 `status` 输出；未知字段默认 block，除非显式位于 `x-` 扩展命名空间。

**禁用别名**：不得新增 `.superspec.yaml`、`.superspec.yml`、`superspec.yaml`、`superspec.yml`、`superspec.json`、`.superspecrc`、`.superspec/config.json`。文档、skill、guard、测试统一只使用 `config.yaml`。

### 5.3 superspec-state.json：guard-owned 受控状态

**铁律**：① 只能 Sync Guard 写入；② 判定必须使用 guard 现场读取的 OpenSpec status，调用方传入的 status 快照不得作为判定输入；③ 必须带 status 指纹 + evidence 指纹；④ 指纹失配必须 block（当前实现使用 `state_fingerprint_stale` block reason，并在重算写入后把 `state_freshness` 标为 `recomputed`），**不得放行**；⑤ 任何 skill/agent 不得手写 transition；⑥ 删除 `superspec-state.json` 后 guard 能从 status + evidence **完整重建**。

**禁用状态别名**：不得新增或使用 `.superspec/state.json`、`.superspec/state.lock`、`.superspec/superspec_state.json`、`.superspec/superspec-state.yaml`。运行态状态文件只使用 `.superspec/superspec-state.json`，锁文件只使用 `.superspec/superspec-state.lock`。

```json
{
  "schema_version": 1,
  "change_id": "example-change",
  "guard_version": "superspec-guard@1",
  "updated_at": "2026-06-08T00:00:00Z",
  "openspec": {
    "version": "1.4.1",
    "status_fingerprint": "sha256-of-openspec-status-and-artifact-paths",
    "status_summary": { "proposal": "done", "specs": "done", "design": "done", "tasks": "done" }
  },
  "superspec": {
    "guard_route_phase": "apply",
    "requested_route_phase": "apply",
    "active_gate": "task_edit",
    "preset": "full",
    "preset_upgrade_required": false,
    "state_freshness": "fresh",
    "last_guard_decision": "block",
    "last_block_reasons": ["missing_red_evidence"]
  },
  "computed_from": {
    "openspec_status_command": "openspec status --change example-change --json",
    "openspec_status_fingerprint": "sha256-of-openspec-status-and-artifact-paths",
    "evidence_fingerprint": "sha256-of-evidence-index",
    "tasks_fingerprint": "sha256-of-tasks-md",
    "discovery_fingerprint": "sha256-of-.superspec-artifacts-discovery-md",
    "design_fingerprint": "sha256-of-design-md",
    "business_invariants_fingerprint": "sha256-of-.superspec-artifacts-business-invariants-md",
    "test_contract_fingerprint": "sha256-of-.superspec-artifacts-test-contract-md"
  }
}
```

**命名与语义铁律**：

- 禁止用 `phase` 表示 OpenSpec artifact 状态。`guard_route_phase` 只做**命令路由**权威，**不是** done source。
- **route 无进度语义（审计 H-7，用户裁决 2026-06-10 文档降级）**：`guard_route_phase` 的实然语义是"**最近一次 check 命令的有效路由**"，不是单调的工作流进度指针——重跑早期 gate（如 review 通过后重查某个 propose 内部 gate）会把 route 拉回该 gate 所属阶段。**禁止**把它当恢复书签 / 进度展示 / "走到哪了"的依据；恢复会话时判断进度的唯一正确方式是对目标 gate 重跑 check 命令看 allow/block。v1 不提供 `max_route_reached` 派生字段。
- `requested_route_phase` 记录调用方请求的路由；`guard_route_phase` 是 guard 根据 OpenSpec floor 和判定结果夹紧后的有效路由。
- `status_summary`：最近一次 status 的镜像，**只作展示，不作判定输入**（判定必须现场重跑）。
- `state_freshness` 当前只持久化 `fresh | recomputed`：`fresh` 表示本次写入前指纹未变，`recomputed` 表示本次写入已吸收前一状态之后的 status/evidence/task 指纹变化。过期状态以 `state_fingerprint_stale` block reason 表达，而不是持久化成可继续推进的 `stale` 状态。
- v1 state 不保留 `phase_floor` / `pause_point` / `recovery_bookmark` / `task_sessions` / `review_dispositions` 等扩展字段；如后续需要恢复提示，也只能作为派生展示，不能绕过 guard。

**路由前置映射（只含用户可见主阶段）：**

| guard_route_phase | openspec_minimum（只含 OpenSpec 事实） | superspec_prerequisite_gates |
|---|---|---|
| `init` | change root exists + default OpenSpec artifact graph 可解析 | — |
| `explore` | init passed | — |
| `propose` | OpenSpec change root exists | `explore_complete` before editing OpenSpec planning artifacts；`proposal_reviewed` before editing `specs/**` / `design.md`（artifact entry gate，DISC Phase 2） |
| `apply` | tasks done | `apply_ready`（`propose_complete` 只表示 propose 内部完成；进入实现前还必须有用户 `apply_isolation` 确认，scope 变化时还要 `scope_expansion` 重批） |
| `review` | tasks done；当前 v1 floor route 仍夹到 `apply`，只有 review gate allow 时有效路由才进入 `review` | all task evidence complete + code review + final verification |
| `archive` | tasks done + `openspec validate` pass；当前 v1 floor route 仍先以 `apply` 为 OpenSpec floor，archive route 由 `check-archive-ready` allow 写入 | `review_complete` + archive preservation |

`openspec_minimum` 不满足时，guard 必须 block 并把 route phase 下调，**绝不上调**。当前 v1 的 OpenSpec floor derivation 只从原生 artifact facts 推导到 `apply`：当 `tasks` 已 done 但 review/archive 仍 block 时，`guard_route_phase` 会保守夹回 `apply`；`review` / `archive` 作为有效路由只在对应 gate allow 后写入。`superspec_prerequisite_gates` 只参与 `effective_allowed`，不得写入或冒充 OpenSpec status。

兼容性说明：`proposal_reviewed`、`design_complete`、`test_contract_drafted`、`tasks_complete`、`test_contract_honored` 仍可作为 guard 内部 gate 名存在，但它们的 `guard_route_phase` 一律归一到 `propose`，不是用户可见主阶段。`apply_ready` 也归一到 `propose`，表达"允许从 propose 交给 apply"，不是新的 OpenSpec artifact。`verify_complete` / `check-verify-ready` 兼容旧调用，但等价于 `review_complete` / `check-review-complete`，路由归一到 `review`。

### 5.4 原子写与并发

```text
ordinary check-*:
  read OpenSpec status from CLI (现场) + `.superspec/artifacts/*` + evidence + tasks.md
  compute allow/block decision
  acquire .superspec/superspec-state.lock for state/ledger write
  reject if superspec-state.json is corrupt (state_corrupt, 不覆盖损坏文件)
  re-read inputs in lock; compare fingerprints   # 失配 → block: state_concurrent_update / retry
  write computed_from using the in-lock verified (decision-time) fingerprints   # 不在写入时重算，杜绝"新指纹+旧判定"
  write ledger tmp → fsync → rename ledger.jsonl
  write superspec-state.tmp → fsync → rename superspec-state.json
  release lock

check-archive-ready:
  acquire .superspec/superspec-state.lock
  re-read OpenSpec status/evidence/tasks/config inside the lock
  recompute archive_ready decision
  write state/ledger and preservation bundle as one rollbackable transaction
  release lock
```

当前 v1 只有 `check-archive-ready` 在锁内重读并重判，因为它需要把 state/ledger 与 preservation bundle 作为同一提交单元处理。其它 `check-*` 依赖 guard 自己读取现场事实、stale preflight、CAS 写入和 retry 收敛；若要达到“所有 check 均在锁内重读并重判”的更强并发语义，属于 guard hardening 后续项。

ledger.jsonl append 同样持锁，保证跨进程（并行 subagent）原子。

### 5.5 evidence 基础 schema + 内容指纹

```json
{
  "schema_version": 1,
  "evidence_id": "EV-001",
  "change_id": "example-change",
  "gate": "design_complete",
  "kind": "subagent_report",
  "created_at": "2026-06-08T00:00:00Z",
  "created_by": "agent-or-user",
  "status": "pass",
  "summary": "short summary",
  "refs": [],
  "target_refs": [ { "path": "design.md", "blob_sha": "sha1-of-reviewed-blob" } ]
}
```

- `status ∈ {pass, fail, blocked, superseded}`。回滚 = 追加一条 `superseded` evidence，使现场重算失去 pass，自然 block（无需删文件、无需改状态机）。
- **supersede 授权模型（FIX-6 / 审计 C-2）**：supersede 不是无门槛的证据移除器。带 `supersedes` 的 evidence 必须满足：① 目标 `evidence_id` 在 evidence 集合中存在，否则 block `supersede_target_missing`；② 与目标同 gate，或携带非空 `supersede_reason` 解释跨 gate 回滚的理由，否则 block `supersede_unauthorized`。两项检查在 evidence schema 防线（`evidence_schema_guard`）执行，任何 check 命令都会触发。
- **supersede 事件入 ledger（FIX-6）**：guard 在 dispatch 时把观察到的每一对 `(superseded_by, supersedes)` 以 `evidence_superseded` 事件追加进 `ledger.jsonl`（锁内去重，恰好记录一次；state 损坏时不写）。"某证据被 supersede"这件事本身从此可审计。
- **task_reopen 豁免（FIX-6 文档化）**：`pass_task_reopens` 故意用 find_pass 而非 live_pass——task_reopen 是历史 blocker 记录，若 supersede 能把它移出 live 集合，一条 superseded evidence 就能在没有对应 `task_reopen_resolved` 的情况下抹掉 reopen 义务，违反披露不动点"历史 blocker 不可抹"的规则。supersede 对 task_reopen 的生命周期检查无效。
- **kind 白名单（FIX-7 / 审计 C-3；DISC Phase 1 扩展）**：`kind` 是枚举而非自由字符串。白名单为 guard 实际识别的 kind 集合（`review`、`subagent_report`、`workflow_review`、`source_guidance`、`main_adjudication`、`verification_review`、`final_test`、`test_run`、`alternative_verification`、`manual_verification`、`task_reopen`、`task_reopen_resolved`、`human_confirmation`、`superseded`，以及披露不动点新增的 `main_review_digest`、`user_review_decision`、`review_standing_authorization`，定义于 `util.ts` `EVIDENCE_KINDS`）。未知 kind → block `evidence_unknown_kind`：打错 kind 的 evidence 必须当场报错，不得静默退化为下游 gate 的"莫名缺证据"。
- **审查披露不动点（DISC Phase 1-3 / `src/disclosure.ts`，设计正本 `docs/designs/REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md`）**：多角色审查发现的 material 问题（`scope`/`non_goal`/`acceptance`/`business_semantics`/`design_boundary`）不允许主线程自行消化，必须经 `main_review_digest` 披露给用户并由 `user_review_decision` 裁决。Phase 1 在 `explore_complete` 启用；Phase 2 扩到 `proposal_reviewed`（targets：`proposal.md` + discovery）与 `design_complete`（targets：`proposal.md` + `design.md` + `specs/**/*.md` glob + discovery）；Phase 3 扩到 `invariants_reviewed`（business-invariants + design + specs glob）、`test_contract_drafted`（test-contract + invariants + design + specs glob）、`tasks_complete`（tasks + test-contract + invariants + design + specs glob——**仅**在出现 round-tagged role review 后激活，本 gate 本身不强制 role review）。glob 按 check 时枚举，集合相等 P1-6——digest 之后新增 spec 文件即 stale。`REVIEW_TARGETS_BY_GATE` 为唯一 target 表。`proposal_reviewed` 属于 `DISCLOSURE_REQUIRED_GATES`（与披露机制同生的 gate）：无 round-tagged review + digest 一律 block `missing_review_digest`，不存在 legacy 豁免路径。disposition `route` 收敛为全局枚举 `DISCLOSURE_ROUTES`（含 `return_test_contract_drafted`；schema 外的值 → `review_digest_invalid`），且每个 gate 有合法子集 `DISCLOSURE_ROUTES_BY_GATE`（如 proposal 的 discovery-incomplete 必须 `return_explore`；tasks 的 acceptance 问题必须 `return_test_contract_drafted`；`reopen_tasks` 等越界 route → block `finding_route_invalid`，P1-4）。schema 防线（任何 check 命令触发）：① 携带 `findings[]` 的 role evidence 必须有合法 `review_round_id`（`<gate>-r<N>` 连续编号）且每条 finding 含 `finding_id`/`finding_uid`（`<gate>:<evidence_id>:<finding_id>`）/`finding_type`/`category`/material 时 `decision_scope_key`/原话 `summary`，否则 block `review_finding_invalid`；② `main_review_digest` 必须 `created_by:"main-thread"`、pin target 集合、引用本轮全部 review、串 `previous_digest_refs` 链、每条 disposition 带身份字段 + `route`/`route_reason` + per-disposition proof（`fixed`→artifact/evidence refs、`false_positive`→source_refs、`user_decided`→user_decision_refs），`needs_user_decision` 存在时 status 必须 blocked，`review_complete` 上禁止出现（main_adjudication 是 final review 的披露载体），否则 block `review_digest_invalid`；③ `user_review_decision` 必须 `created_by:"user"`、`decision ∈ {option_a,option_b,option_c,option_d_custom}`、`finding_uids` 精确、`confirmed_refs` pin blob，D 选项必须带 `user_text` + 完整 `structured_decision`，否则 block `user_decision_invalid`；④ `review_standing_authorization` 必须用户创建、显式 allow/deny category、allowed∩excluded 冲突即 block，否则 block `standing_authorization_invalid`。gate 防线（`review_disclosure_reasons`，内联在 gate 判定中）：round 连续性 `review_round_discontinuous`、digest 链 `digest_chain_broken`、最新轮 review/digest 集合相等 stale `review_round_stale`/`review_digest_stale`、缺披露 `missing_review_digest`、本轮 finding 未覆盖 `finding_undisclosed`、append-only ledger 未终态 `finding_unresolved`、待用户裁决 `needs_user_decision_pending`、disposition 身份改写 `finding_identity_mismatch`（P0-2）、material summary 非逐字 `finding_summary_not_verbatim`（P1-1）、material 终态缺用户锚点或 decision 绑定失败（uid/scope_key/material 覆盖/blob/结构序）`user_decision_unbound`、standing auth 越界（category/gate/blocker/过期，excluded 优先）`standing_authorization_unbound`、D 选项消费契约 `artifact_update_required`/`rereview_required`、accepted deviation 未被 clean 轮确认 `accepted_deviation_unacknowledged`（P1-2）、round k>1 prompt 缺工具渲染 ledger 注入 `ledger_injection_missing`（R3，`render_finding_ledger` 逐字校验）、超 3 轮预算未收敛 `round_budget_exhausted`（R5，route=escalate_round_budget）。**Grandfathering（P2-3）**：无 `review_round_id`/`findings[]`/digest 的旧式 evidence 维持原判定口径，不被追溯 block（`proposal_reviewed` 除外；已在真实 change `refactor-vacation-duration-api` explore gate 上验证）。
- **human_confirmation 最小 schema（FIX-7 / 审计 C-3；FIX-8 扩展）**：`kind:"human_confirmation"` 必须满足：① `created_by:"user"`，主线程或 agent 自写确认不能满足人工确认；② `gate` 属于 guard 实际消费 human_confirmation 的 gate 集合（`explore_complete`、`design_complete`、`invariants_reviewed`、`archive_ready`、`preset_upgrade`、`branch_handling`、`apply_isolation`、`scope_expansion`、`verify_failure_handling`，定义于 `util.ts` `HUMAN_CONFIRMATION_GATES`），写到其它 gate 的确认不可达即错误；③ `confirmation_text` 非空（确认了什么必须说出来）；④ 绑定被确认内容的引用——`branch_handling` 用 `confirmed_paths[]`（沿既有豁免语义），其余 gate 用 `confirmed_refs[]`，均要求非空字符串列表；⑤ `apply_isolation` / `scope_expansion` 还必须带 `tasks_structure_hash`，pin 用户批准的 tasks 结构。任一不满足 → block `human_confirmation_invalid`。检查在 evidence schema 防线执行，任何 check 命令都会触发。所有 gate 消费人工确认时只读取 live/pass 且 `created_by:"user"` 的 confirmation。
- 普通 `refs` / `output_ref` / `prompt_ref` 相对 change root；evidence 文件必须位于 `.superspec/` 内。
- `output_ref` 不是单纯存在性证明：指向文件必须非空；role evidence 的 `output_ref` 不得指向自身被审查的 `target_refs` 文件；同一轮 `review_complete` 的 live/pass evidence 不得复用同一个 `output_ref`。
- **propose 期 output_ref 查重 + omnibus 审查范围合同（FIX-11 / 审计 H-1；DISC Phase 2 扩入 proposal）**：五个 propose 审查 gate（`explore_complete`、`proposal_reviewed`、`design_complete`、`invariants_reviewed`、`test_contract_drafted`）逐 gate 套用与 `review_complete` 相同的 output_ref 查重——同 gate live/pass evidence 复用同一 `output_ref`（按 dev:ino 实体判同）→ block `evidence_output_ref_duplicate`。跨 gate 复用同一 `output_ref`（omnibus refresh 形态）不再默认合法：该 evidence 必须显式声明 `review_scope[]` 且覆盖本 gate 的 target artifact（explore→`.superspec/artifacts/discovery.md`、proposal→`proposal.md`、design→`design.md`、invariants→`.superspec/artifacts/business-invariants.md`、test-contract→`.superspec/artifacts/test-contract.md`），否则 block `review_scope_unverified`。一次 omnibus 审查盖几个章，就要在 scope 合同里写几个 target。
- **`prompt_ref` 可读非空（FIX-9 / 审计 C-4）**：role evidence 的 `prompt_ref` 比照 `output_ref` 校验——必须解析在 change root 内（否则 `evidence_unsafe_ref`）、文件可读（否则 block `evidence_prompt_missing`）、内容非空（否则 block `evidence_prompt_empty`）。prompt 从未存在的"委托"声明按伪造处理。
- **`evidence_id` 同 change 内唯一（FIX-9 / 审计 C-4）**：重复 id 会让 refs/supersede/Map 查找静默取"最后写入者"。evidence schema 防线对每个被复用的 id block `evidence_id_duplicate`，并列出冲突文件。
- **全局悬空引用检查（FIX-12 / 审计 D-3）**：evidence 间引用完整性是 guard 通用能力而非 review_complete 特例。任何 `*_evidence_refs` 字段（字符串列表，或 `lane_evidence_refs` 这类 lane→id 映射对象）引用的 `evidence_id` 在本 change 的 evidence 集合中不存在 → block `dangling_evidence_ref`（列出全部缺失 id）。删除 evidence 文件从此触发硬 block，而不是一次 recompute 即恢复的 `state_fingerprint_stale`（"删除式洗白"封堵）。`supersedes` 的悬空由 FIX-6 的 `supersede_target_missing` 覆盖，不重复报。检查在 evidence schema 防线执行，任何 check 命令都会触发；review_complete 既有的 live/pass 级 unknown-ref 检查（更严格）保持不变，两层互补。
- **`test_run` 按运行建档（FIX-10 / 审计 C-5、H-4）**：`kind:"test_run"` 必须满足：① `raw_log_refs[]` 为非空字符串列表，按 change root 解析（修正 H-4 实证的 repo-root 前缀混用，C-7），逃逸 change root → `evidence_unsafe_ref`，文件缺失/不可读/内容为空 → block `test_run_log_missing`；② `result_summary` 非空 → 否则 block `test_run_summary_missing`；③ 声称的 `test_id`（及可选的合并清单 `test_ids[]`）必须以字符串形式出现在至少一份引用日志中（grep 级），否则 block `test_id_not_in_log`。per-test 扇出仍合法，但推荐"一次运行一份证据 + `test_ids[]` 清单"的按运行建档形态。真实 exit code 验证仍属 v2 hook 层（§6.6 天花板不变）：本检查只让伪造从"编一个 JSON"升级为"还得编一份内容对得上的日志"。
- review 契约里的 `pinned_ref = {path, blob_sha}`（用于 `source_refs` / `required_load_refs` / `loaded_refs`）一律以 repo root 解析 `path`；即使目标文件位于 change root 内，也仍然使用 repo-root relative path。
- **`target_refs[].blob_sha`（补 critic M2）**：审查类 evidence 必须记录"被审查内容的 git blob sha"。guard 在依赖 gate 处比对：若活文件 blob ≠ 最新 pass evidence 的 blob_sha → block（`stale_review`），防止"design 评审通过后被改"。注意：blob_sha 是**防篡改（anti-drift）**，**不防伪造（anti-forgery）**——它无法阻止凭空捏造一份 evidence 并填入真实文件的 blob_sha（v1 天花板见 §6.6）。

### 5.6 path/ref 安全（canonicalization）

1. 普通 ref（如 `refs` / `output_ref` / `prompt_ref`）以 change root 解析相对路径；`pinned_ref.path` 以 repo root 解析相对路径 → 2. lexical normalize，拒绝 `..` → 3. resolve realpath → 4. 确认仍在对应 root 内 → 5. OpenSpec artifact ref 必须等于 status 返回的 path → 6. evidence/raw/handoff ref 必须在 `.superspec/` 内 → 任一失败即 block。禁止绝对路径、`..`、跳出对应 root 的 symlink。

---

## 6. L3：Sync Guard

### 6.1 职责

Sync Guard 是**唯一状态写入器 + 唯一放行器**。
允许：读 OpenSpec status/instructions、读写 `superspec-state.json`、append ledger、读 evidence、校验 schema/路径/时序/映射、输出 allow/block。
禁止：写业务代码、生成 OpenSpec artifact、改 tasks.md checkbox、移动 archive 目录、把状态写回 OpenSpec、让 state 覆盖 status、接受手写 transition。

### 6.2 输入来源

guard 必须**自己**执行 `openspec status --change <c> --json`（≈2.6KB，实测）。调用方传入的 status 快照只能 debug，不作判定输入。必要时 `openspec instructions <artifact> --json` / `openspec validate <c>`。

> **主上下文保护**：guard 作为独立脚本（含 hook 子进程）运行，那 2.6KB JSON 在 guard 内部消化，**只有精简判定（allow/block + block_reasons + next_allowed_actions）回到模型**。`*_summary` 字段只放计数/ID，**禁止把原始 status JSON 倒进上下文**。

### 6.3 命令接口

```bash
superspec_guard status        --change <c>
superspec_guard recompute     --change <c> [--force-unlock] [--rebuild-corrupt]
superspec_guard check-init    --change <c>
superspec_guard check-enter   --change <c> --gate <gate>
superspec_guard check-artifact --change <c> --artifact <a>
superspec_guard check-apply-ready   --change <c>
superspec_guard check-task-reopen   --change <c> --task-id <t>
superspec_guard check-task-edit     --change <c> --task-id <t>
superspec_guard check-task-complete --change <c> --task-id <t>
superspec_guard check-review-ready  --change <c>
superspec_guard check-review-complete --change <c>
superspec_guard check-verify-ready  --change <c>  # compatibility alias for review_complete
superspec_guard check-archive-ready --change <c>
superspec_guard check-archived      --change <c>
```

所有 `check-*` 必须由 guard 自己读取 status / evidence / tasks 并重算指纹；调用方不得传入可影响判定的 status 快照。普通 check 在判定后通过 CAS 原子写 state/ledger；`check-archive-ready` 在锁内重读并重判后再提交 state/ledger/preservation bundle。若指纹失配，guard 必须 block/retry/recompute，不能放行。

### 6.4 fail-closed 策略（补 critic 3.4，L4 场景关键）

guard 出错时**一律 fail-closed**（block + 大声记录原因），绝不静默放行：

| 失败 | 行为 |
|---|---|
| `openspec` 不在 PATH / status 解析失败 / 版本字段缺失 | block `openspec_unavailable` |
| git 不可用 / detached HEAD / rebase 中 | block `git_unavailable` |
| `superspec-state.lock` 获取失败 / 指纹竞争 | block `state_concurrent_update` |
| `superspec-state.json` 存在但不可解析为 JSON object（损坏：非预期写入/崩溃截断/手工编辑） | 所有命令 block `state_corrupt`，且**不得覆盖损坏文件**（保留事故现场）；只有显式 `recompute --rebuild-corrupt` 允许重建，重建事件（`state_corrupt_rebuilt`）写入 ledger。注意区分：文件**不存在**（显式删除/首次运行）是合法可重建状态，不 block |
| guard 自身异常（任何未捕获） | **捕获后 `exit 2` + stderr**（见 §7.3，否则 Codex hook fail-open） |

合法的人工放行只能通过显式 `human-override` evidence（记录 who/why/confirmation_text），不能靠 guard 静默降级。v1 的 `human_confirmation` / `human-override` 证据为 `trust:self_reported`：guard 只能校验 evidence 格式、引用和确认文本，不能机械证明用户确实被询问；真实运行时证明属于 v2 hook/runtime 或外部 UI 审计能力。`branch_handling` 的 `human_confirmation` 必须绑定 `confirmed_paths[]`，只能豁免这些路径覆盖的脏/未跟踪文件；未列入路径仍然 block。

### 6.5 判定矩阵

**角色审核铁律**：判定矩阵中凡是以审查角色名要求的 evidence（如 `architect`、`critic`、`test-engineer`、`code-reviewer`、`verifier`），必须声明为 `execution_mode:"native_subagent"`。这些角色必须由 SuperSpec 分发包里的 repo-local `.codex/agents/<role>.toml` + `.codex/prompts/<role>.md` 提供，不能依赖用户全局 oh-my-codex 配置；缺失或当前 Codex surface 不能启动 native subagent 时 fail closed。`explore` 是主阶段/skill 名，不是 v1 角色 gate；事实查证由主线程直接读文件/搜索并沉淀 `discovery.md`，只有需求对抗审查需要 `critic` native-subagent evidence。v1 只能校验这套自报告 native-subagent 契约（字段、输出引用、非 direct、非主线程自审）；机械真实性到 v2 才能通过 SubagentStart/SubagentStop runlog 验证。主线程自己生成的审查、验证或复述不能满足角色 gate pass；不满足时统一 block `missing_native_subagent_evidence` / `self_review_not_allowed`。人工确认是单独的 `human_confirmation` gate，不属于角色审核。

| Gate | 所属主阶段 | OpenSpec minimum | SuperSpec evidence required | 典型 block codes |
|---|---|---|---|---|
| `init` | `init` | change root + OpenSpec default artifact graph 可解析；repo 已执行 `openspec init --tools codex`，OpenSpec 原生 Codex skills 与 CLI surface 存在；SuperSpec 自身 5 个 workflow skill（`.codex/skills/superspec-*`）存在且 frontmatter name 合法（D4 / 审计 G-2） | canonical config/state boundary 可校验；完整 sidecar 目录允许后续阶段 lazy-create | `openspec_init_missing`, `openspec_native_surface_missing`, `openspec_native_surface_invalid`, `superspec_init_missing`, `superspec_skill_invalid`, `non_default_openspec_schema`, `unexpected_openspec_artifacts` |
| `explore_complete` | `explore` | change root exists | main-thread discovery report + `critic` native-subagent requirement review（角色 evidence 必须 `target_refs` pin 当前 `.superspec/artifacts/discovery.md` blob）+ 用户对探索结论、范围边界和进入 propose 的 `human_confirmation` + DISC 披露闭环：round-tagged review 出现后要求逐轮 `main_review_digest`，material findings 必须有用户裁决锚点（详见 §5.5 披露不动点） | `missing_discovery`, `missing_native_subagent_evidence`, `missing_human_confirmation`, `stale_explore_review`, `evidence_output_ref_duplicate`, `review_scope_unverified`, `missing_review_digest`, `needs_user_decision_pending`, `finding_unresolved`, `finding_undisclosed`, `user_decision_unbound`, `standing_authorization_unbound`, `review_round_stale`, `review_digest_stale`, `review_round_discontinuous`, `digest_chain_broken`, `finding_identity_mismatch`, `finding_summary_not_verbatim`, `accepted_deviation_unacknowledged`, `ledger_injection_missing`, `artifact_update_required`, `rereview_required`, `finding_route_invalid`, `round_budget_exhausted` |
| `propose_complete` | `propose` | proposal + specs + design + tasks done | `explore_complete` + `proposal_reviewed` + `design_complete` + `invariants_reviewed` + `test_contract_drafted` + `tasks_complete` | `missing_proposal`, `proposal_reviewed_failed`, `design_complete_failed`, `invariants_reviewed_failed`, `tasks_complete_failed` |
| `apply_ready` / `propose.apply_ready` | `propose` | proposal + specs + design + tasks done | `propose_complete` + 用户 `apply_isolation` human_confirmation（pin `tasks_structure_hash`）；若 tasks 结构在确认后变化，必须用户 `scope_expansion` re-approval 或拆分/重设 change | `propose_not_complete`, `apply_isolation_unconfirmed`, `scope_expansion_unconfirmed` |
| `task_edit` | `apply` | tasks done, 目标 task 未勾 | `propose_complete` + 用户 `apply_isolation` human_confirmation（pin `tasks_structure_hash`）+ 该 task 有 RED pass 或 approved no-TDD | `propose_not_complete`, `apply_isolation_unconfirmed`, `scope_expansion_unconfirmed`, `missing_red_evidence`, `invalid_no_tdd_reason` |
| `task_complete` | `apply` | tasks done | `propose_complete` + 用户 `apply_isolation` human_confirmation（pin `tasks_structure_hash`）+ 该 task GREEN pass 或替代验证 | `propose_not_complete`, `apply_isolation_unconfirmed`, `scope_expansion_unconfirmed`, `missing_green_evidence`, `unexpected_green_failure` |
| `task_reopen` | `apply` | tasks done, 目标 task 仍勾选 | `propose_complete` + 用户 `apply_isolation` human_confirmation（pin `tasks_structure_hash`）+ `review_complete` 的 request_changes route 授权 reopen + task_reopen evidence 绑定 source guidance / adjudication / before-after tasks hash；scope 变化同样要求 `scope_expansion` 重批 | `propose_not_complete`, `apply_isolation_unconfirmed`, `scope_expansion_unconfirmed`, `request_changes_required`, `task_reopen_invalid`, `missing_task_reopen`, `task_reopen_pending_revert` |
| `review_ready` | `review` | OpenSpec native artifacts done + tasks 全勾 | `propose_complete` + 全 task evidence 完成 + validate pass | `propose_not_complete`, `tasks_incomplete`, `validate_failed` |
| `review_complete` | `review` | review_ready allowed | allow-only gate：只有 `main_adjudication.review_decision:"allow"` 才可放行；要求 3 条 `source_guidance`（`code-reviewer` / `architect` / `critic`）+ review 内联 `verification_review` / `final_test` + 唯一终局 `main_adjudication` + blocker / claim / load 全部闭环；任何 fail 状态的 verification evidence（含已被 supersede 的）必须被 `verify_failure_handling` human_confirmation 的 `confirmed_refs` 覆盖 | `missing_source_guidance`, `missing_main_adjudication`, `required_load_unloaded`, `required_claim_unadjudicated`, `missing_final_verification_review`, `missing_final_tests`, `verify_failure_unconfirmed` |
| `verify_complete` / `check-verify-ready` | `review`（兼容别名） | same as `review_complete` | 不新增独立 gate；复用 `review_complete` 的 final verification 要求 | same as `review_complete` |
| `archive_ready` | `archive` | OpenSpec native artifacts complete + validate pass | `review_complete` + human confirmation (`trust:self_reported` in v1) + archive preservation plan/bundle ready | `missing_final_confirmation`, `missing_archive_preservation_plan` |
| `archived` | `archive` | archive 已执行且找到归档 change | `.superspec` preservation bundle/evidence 可读且与 archive 前 manifest 匹配 | `archive_not_found`, `superspec_not_preserved` |

`propose` 内部 gate：

| Internal gate | OpenSpec minimum | SuperSpec evidence required | 典型 block codes |
|---|---|---|---|
| `proposal_reviewed` / `propose.proposal_reviewed` | proposal done | `explore_complete` + 强制披露循环（无 legacy 豁免）：round-tagged `critic` review（`review_round_id` `proposal_reviewed-r<N>` + `findings[]` + pin `proposal.md`/discovery 集合）+ 逐轮 `main_review_digest`；material findings 必须有用户裁决锚点；同时是 `specs`/`design` 的 artifact entry gate | `explore_complete_failed`, `missing_proposal`, `missing_proposal_review`, `missing_review_digest`, `finding_route_invalid` + §5.5 披露不动点全部 gate 防线 codes |
| `design_complete` / `propose.design_reviewed` | design done | `proposal_reviewed` + architect + critic + test-engineer report（角色 evidence 必须 pin 当前 `design.md` blob）+ human confirmation (`trust:self_reported` in v1)；round-tagged design review 出现后进入披露循环（target 集合：`proposal.md` + `design.md` + `specs/**/*.md` + discovery，集合相等 stale），legacy design evidence 维持 grandfathered 口径 | `proposal_reviewed_failed`, `missing_architect_review`, `missing_human_confirmation`, `stale_design_review`, `evidence_output_ref_duplicate`, `review_scope_unverified`, `review_round_stale`, `review_digest_stale` |
| `invariants_reviewed` / `propose.invariants_reviewed` | design done + design_complete | sidecar `.superspec/artifacts/business-invariants.md` 存在且结构有效 + critic + test-engineer review；round-tagged review 出现后进入披露循环（target：business-invariants + design + specs glob），legacy evidence grandfathered | `missing_business_invariants`, `invalid_business_invariants`, `missing_invariant_review`, `evidence_output_ref_duplicate`, `review_scope_unverified`, `review_digest_stale`, `finding_route_invalid` + §5.5 披露 codes |
| `test_contract_drafted` / `propose.test_plan_drafted` | design done + invariants_reviewed | sidecar `.superspec/artifacts/test-contract.md` 存在且结构有效 + specs Scenario 覆盖完整 + hard `INV-*` 映射 + 红绿契约 review + critic（reviewer evidence 必须 pin 当前 `test-contract.md` blob）；round-tagged review 出现后进入披露循环（target：test-contract + invariants + design + specs glob），legacy evidence grandfathered | `missing_test_contract`, `missing_coverage_matrix`, `invariant_not_honored`, `missing_test_contract_review`, `stale_test_contract_review`, `evidence_output_ref_duplicate`, `review_scope_unverified`, `review_digest_stale`, `finding_route_invalid` + §5.5 披露 codes |
| `test_contract_honored` | tasks done | `test_contract_drafted` + test-contract `test_id` 与 tasks.md `test_refs` 一致，test-contract `INV-*` 与 tasks.md `invariant_refs` 一致，且 RED/GREEN evidence 引用合法 test_id/invariant_refs | `test_contract_drafted_failed`, `test_contract_not_honored`, `missing_task_test_refs`, `missing_task_invariant_refs`, `invalid_invariant_ref` |

**propose 内部 gate 主链拓扑**（前置链自此完整闭合）：`explore_complete → proposal_reviewed → design_complete → invariants_reviewed → test_contract_drafted → test_contract_honored → tasks_complete → propose_complete`。`proposal_reviewed` 位于 explore 与 design 之间（DISC Phase 2）：`design_complete` 直接 require 它，`specs`/`design` 的 artifact entry（`check-artifact`）也以它为 enter gate；缺失时对应路径 block `proposal_reviewed_failed`。`test_contract_honored` 位于 drafted 与 tasks_complete 之间：它消费 drafted 产出的契约（必须先有有效契约才谈"兑现"），并被 `tasks_complete` 作为前置消费；跳过 drafted 直接构造 honored 条件必须 block `test_contract_drafted_failed`。
| `tasks_complete` / `propose.tasks_mapped` | tasks done | `tasks.md` 结构化任务合法 + req/test/task 映射合法 + 写范围无冲突 + `test_contract_honored`；仅在出现 round-tagged tasks review 后进入披露循环（target：tasks + test-contract + invariants + design + specs glob） | `invalid_task_graph`, `write_scope_conflict`, `missing_review_digest`, `return_test_contract_drafted` route 合法时 `finding_route_invalid` 不报 + §5.5 披露 codes |

### 6.6 v1 真实强制力天花板（无 hook 时，务必清醒接受）

v1 不含 L4，**没有任何模型写不了的运行时取证源**（PostToolUse/SubagentStart 在 v2 才有）。由此：

- 除 OpenSpec minimum 外，**所有 SuperSpec evidence（RED/GREEN、subagent report、human confirmation）都是模型可写文件，可被整体伪造成一套自洽证据**。
- **指纹对账只防漂移（看过之后被改）+ 崩溃恢复，不防伪造（凭空捏造）**：模型可一次性写齐假 evidence（`status:pass`、编造 `agent_id`、甚至填真实 `blob_sha`），guard `recompute` 时对这套假文件求指纹天然自洽、无 stale、judgment 通过 → 形成**伪造闭环（forgery loop）**，产出假 allow。模型甚至不必"算"指纹——guard 会替它算。

| 维度 | v1 真实强度 |
|---|---|
| OpenSpec 原生 artifact 存在性 + requires 顺序（L1） | **硬地基**：guard 跑真 CLI，模型伪造不了 |
| 结构/映射/覆盖矩阵/脏工作区纪律/规模分级/人审阻塞 | 有效 **当且仅当** 合作型 agent 遵守 |
| RED/GREEN、subagent 审查、human confirmation 真伪 | `self-reported / forgeable`（v1 无法机械防伪；判定矩阵里标 `runtime-verified` 的项在 v1 **实际退化为 self-reported**） |

**定位结论（红线）**：**v1 = audit-only discipline layer / cooperative agent discipline，不是"防抄近路的严格强制"。** 用户#1 诉求"机械强制、不靠模型自觉"由 **v2 hook** 兑现（且 gated on R-1 spike）。**批准 v1 = 接受该诉求在 v1 阶段不被满足**，仅获得"合作型 agent 的规范化 + OpenSpec 原生硬约束 + 可审计 evidence"。严禁把 v1 对外宣称为"严格强制"、"mechanical enforcement" 或 "runtime-verified"。

---

## 7. L4：Codex Hook 强制层（核心增量，回应 B2）

> **交付定位：L4 属于 v2（见 §18 分期）。v1 不实现 hook、不产出 `.codex/hooks.json`、不写 hook stdin adapter、也不写 PostToolUse/SubagentStart 运行时取证入口。本章只作为 v2 设计依据；v1 只保留 guard 命令和 evidence schema 的兼容边界。**

### 7.1 事实基础

Codex 0.136.0 hooks（`~/.codex/hooks.json` 或项目 `.codex/hooks.json`，默认开启）。官方文档显示 `PreToolUse` 支持拦截 `apply_patch`（文件编辑，matcher 可用 `apply_patch`/`Edit`/`Write`）、`Bash`、MCP，并可返回 `{"hookSpecificOutput":{"permissionDecision":"deny",...}}` 或 `exit 2 + stderr`。真实物理 deny 行为、`unified_exec` 绕过率和 guard-as-hook 时延必须在 v2 前置 R-1 spike 中实测。

### 7.2 Hook 矩阵

以下矩阵描述 **v2 目标行为**，不是 v1 验收项。只有 R-1 spike 证明 deny 可靠、绕过率可接受、guard-as-hook 时延可控后，表内效果才允许从设计目标升级为实施承诺。

| Hook | matcher | guard 动作 | v2 目标效果 |
|---|---|---|---|
| `PreToolUse` | `apply_patch`/`Edit`/`Write` | 解析 patch 目标文件 → 若命中某 task 的 `write_scope` 且该 task 无 RED pass → deny | **改实现代码前必须有 RED**，物理拦截 |
| `PreToolUse` | `Bash` | 命令含 `openspec archive` 且 `archive_ready` 未过 → deny；含危险写（`sed -i`/`tee`/`>` 命中正本/scope 外）→ deny | 物理拦截越权归档/越界写 |
| `PostToolUse` | `Bash` | 命中测试命令（如 `mvn test`）→ 用真实 `exit_code` + `tool_response` 生成 RED/GREEN evidence | 测试 evidence 升级为 `runtime-verified` |
| `SubagentStart` | `*` | 把真实 `agent_id`/`agent_type`/turn 写入 `subagent-runlog.jsonl` | 为 subagent evidence 提供运行时核验源 |
| `SubagentStop` | `*` | 记录 subagent 结束 + transcript 路径 | 核验 subagent 确实跑完 |

### 7.3 guard-as-hook 必须 fail-closed

Codex 在 hook 失败 / 返回不支持字段时**默认 continue tool call（fail-open）**。因此 guard hook 包装脚本必须：

```text
trap 所有异常 → 输出 {"permissionDecision":"deny", reason} 或 exit 2 + stderr
超时（hook 默认 600s，应设短 timeout 如 30s）也视为 deny
绝不让脚本自然崩溃（崩溃 = Codex 放行 = 强制失效）
```

### 7.4 evidence 运行时防伪（回应 critic B2 第二条）

- **subagent 报告**：guard 校验 evidence 的 `agent_id` ∈ `subagent-runlog.jsonl`（L4 SubagentStart 写入的真实启动记录）。主线程自写假报告因 agent_id 不在真实日志中 → block。
- **RED/GREEN**：优先采用 `PostToolUse` hook 捕获的真实测试 evidence（含真实 exit_code/log）；模型手写的 test_run evidence 标 `trust:self_reported`，不满足"严格"级 gate。

### 7.5 启用与信任

- 项目 `.codex/hooks.json` 需经 `/hooks` review + trust 后才生效（按 hash 记录，改了要重新 trust）。
- 团队/强约束场景：用 `requirements.toml` 的 managed hooks + `[features].hooks=true` pin，使用户无法本地禁用。

### 7.6 诚实威胁模型与强制力分级

**强制力分级**（每个 gate 标注）：

| 级别 | 含义 | 例 |
|---|---|---|
| `mechanical` | hook 物理 deny，模型跳不过 | 改 write_scope 内代码无 RED |
| `runtime-verified` | 证据由 hook 运行时捕获，不可伪造 | RED/GREEN 真实测试结果、subagent agent_id |
| `audit-only` | 仅事后稽核，靠现场重算发现 | 外部编辑器直接改文件 |

**残留逃逸（不夸大，必须文档化）**：

1. `unified_exec` 流式 shell 拦截不全 → 可能绕过 `apply_patch` hook 写文件。缓解：PostToolUse + §9.5 事后 diff 稽核兜底。
2. hooks 可被 `[features].hooks=false` 关闭（除非 requirements.toml pin）。
3. 未 trust 的项目 hook 不运行。
4. `read_file`/`grep`/`WebSearch` 无 hook surface（只读，不影响写强制）。

**结论（v2 目标）**：若 R-1 spike 证明 deny 可靠且绕过率可接受，L4 才把核心写路径（apply_patch）与归档（Bash）提升到 `mechanical`，把测试与审查证据提升到 `runtime-verified`。在 v1 阶段，这些能力不存在，残留全部交由 `audit-only` 兜底。

---

## 8. 三道防线（L3 + L4 关系）

```text
防线1 物理拦截   PreToolUse deny           —— mechanical
防线2 运行时取证 PostToolUse/SubagentStart —— runtime-verified
防线3 事后稽核   Sync Guard 现场重算+指纹   —— audit-only（兜底 unified_exec 等逃逸）
```

v1 只有防线3。防线1/2 是 v2 overlay，只有在 R-1 spike 通过并完成 hook 集成后才参与推进决策；届时推进决策是三者的 AND。

---

## 9. superpowers TDD 集成

### 9.1 design 完备性清单（skill + review gate 强制逐项）

接口契约 / 数据流与状态 / 事务与一致性 / 边界与并发 / 错误路径与回滚 / 兼容性（向后兼容、灰度）/ 可观测性 / 安全与权限 / 性能影响。每项要么给决策，要么显式标"不涉及 + 理由"。

### 9.2 测试覆盖矩阵（sidecar test-contract + guard 强制）

正常路径 / 边界值 / 异常与错误 / 幂等与重试 / 并发竞态 / 回归（行为保持）/ 契约（API、schema）。每个 specs 的 `#### Scenario` 至少映射一个用例。

### 9.3 红绿灯五步 + Iron Law

```text
1 RED         写一个最小失败测试
2 VERIFY RED  运行，确认"因正确原因失败"；意外通过则停止
3 GREEN       写最小代码让其通过，不优化/不加功能/不顺手重构
4 VERIFY GREEN 运行确认通过
5 REFACTOR    仅绿灯后清理，每次重构后重跑，失败即 revert
```

**Iron Law**：没有正在失败的测试，不准写实现代码；违反则删除超前代码重来。anti-patterns（过度 mock / 模糊断言 / 模糊命名 / 测实现细节而非行为）作为 reference 随 skill 下发。

### 9.4 tasks.md 结构块 + no_tdd_reason（补 critic M5）

```markdown
- [ ] TASK-001 Extract duration service
  - requirement_refs: REQ-001, REQ-002
  - test_refs: TEST-001
  - read_scope: path/A.java
  - write_scope: path/C.java
  - dependencies: []
  - parallel_group: PG-001
  - tdd_required: true
  - tdd_mode: behavior-preserving-refactor   # 见下
```

`tdd_required: false` 的 `no_tdd_reason` 枚举：`documentation-only` / `configuration-only` / `test-only-refactor` / `mechanical-rename` / `generated-artifact-only` / `non-executable-spec-change`。非枚举值 block。改运行时代码路径/业务规则/数据迁移/权限/外部接口/错误处理的 task 不允许 `tdd_required:false`。

**`tdd_mode` 枚举（补 M5 关键：解决"行为保持重构"反例）**：

| tdd_mode | 红绿灯形态 |
|---|---|
| `new-behavior`（默认） | 标准 RED-first：先写失败测试 |
| `behavior-preserving-refactor` | **characterization 测试**：对现有行为先写 GREEN（锁定现状），重构后保持 GREEN。无需 RED-first（无新行为可失败） |
| `hotfix` | 受控通道：允许先复现 bug 的 RED → 修复 → GREEN，或在 hotfix preset 下走精简流程（§13） |

> 修正前稿反例：`Extract duration service`（抽取服务、保持行为）应标 `tdd_mode: behavior-preserving-refactor`，而非强制 `new-behavior` 的 RED-first。

### 9.5 diff 检测：采用当前脏工作区协议（替换三点语法，补 critic 3.1）

放弃有缺陷的 `git diff base_ref...head_ref` 三点语法（脏工作区不是 commit、untracked 丢失、并行 task_start_ref 失管）。改用当前协议：

```bash
git status --short
git diff --stat
git diff --cached --stat
git ls-files --others --exclude-standard   # 显式捕获 untracked（含新建测试/源文件）
```

归因三分类：① 属于当前 change（并入对应 task）；② 不属于（暂停询问：纳入/拆新 change/保留/授权丢弃）；③ 来源不明（暂停、报告文件清单、不推进）。

核心规则：**脏工作区只是代码证据，不自动推进 `guard_route_phase`、不自动勾 tasks.md**；推进仍需通过对应 gate。guard 在 `task_complete`/`review_ready` 用此协议核验：勾选但无 GREEN → block；write_scope 内有改动但无 RED → block。

---

## 10. test-contract 兑现校验（补 critic 3.2）

`business-invariants.md` 是 **superspec sidecar**（`.superspec/artifacts/business-invariants.md`），不是 OpenSpec artifact。它在 `test-contract.md` 之前冻结本 change 命中的业务不变量：每条 `INV-*` 必须有 statement、scope、source anchors、acceptance/risk refs、confidence、enforcement level、verification，以及 test refs 或 review-only reason。Guard 只校验结构、引用、指纹和时序；语义正确性由 critic/test-engineer/human evidence 承担。

`test-contract.md` 也是 **superspec sidecar**（`.superspec/artifacts/test-contract.md`），不是 OpenSpec artifact。它分两段校验，避免在 tasks.md 尚未生成时形成循环依赖：

- `invariants_reviewed`（写 test-contract 前）：校验 `business-invariants.md` 存在、结构有效，并通过 critic + test-engineer 审查。
- `test_contract_drafted`（写 tasks.md 前）：校验文件存在、结构有效、覆盖 specs 的每个 `#### Scenario`，覆盖 `enforcement_level:"automated-test"` 的 hard `INV-*`，并通过 test-engineer + critic 审查。`review-checklist` / `human-confirmation` hard invariant 不强制伪装成 `TEST-*` 行，但必须在后续 final invariant matrix 中覆盖；`human-confirmation` 还必须有 explicit human confirmation evidence。此时**不得**要求 tasks.md 反向映射；`TEST-*`/`INV-*` 必须来自 `## 测试覆盖矩阵` 表格行，注释或说明段落中的 token 不算覆盖。
- `test_contract_honored`（tasks/apply/review 期）：test-contract 的 `test_id` 集合 ⊆ ∪(tasks.md 各 task 的 `test_refs`)；每个 `TEST-*` 行绑定的 `INV-*` 必须出现在匹配该 `TEST-*` 的 task `invariant_refs` 中，不能只做全局集合包含。
- `task_edit`/`task_complete`：apply 期 RED/GREEN 引用的 `test_id` ⊆ test-contract 声明的 `test_id`，`invariant_refs` ⊆ business-invariants 声明的 `INV-*`；task 声明的每个 `test_refs` 必须在对应 gate 逐项兑现，`task_edit` 只接受 `gate:"task_edit"` 的 RED/characterization，`task_complete` 只接受 `gate:"task_complete"` 的 GREEN。
- 尽量比对 RED evidence 的 `expected_reason` 与 test-contract 声明的 `expected_red`。
- 不一致 → block（`test_contract_not_honored`）。

（断言是否"有意义"仍只能由 test-engineer/critic subagent 判定，标 `runtime-verified` 不可达，诚实归 `audit-only`。）

---

## 11. L3 多视角 Subagent

### 11.1 三段式（每阶段）

1. **事实调查**：需要现有实现/依赖/约定等事实时，主线程直接读文件、搜索、运行只读命令并沉淀 source anchors；事实调查不是角色 gate，也不要求启动 native subagent。只有当范围很大、需要并行压缩上下文时，才可把调查作为可选辅助委托，但它不能替代后续角色审查 evidence。
2. **主线程编排（委托原生产出引擎）**：读 discovery 与角色审查 evidence 后，**必须**通过 OpenSpec 的产出引擎写/更新 artifact——propose 期对每个 artifact 调 `openspec instructions <artifact> --change <c> --json`，apply 期调 `openspec instructions apply --change <c> --json`（详见 §11.4），不得徒手另写产出流程。
3. **对抗审查**：派 subagent 对抗审查，产出 review 证据；v1 guard 校验 native-subagent 自报告契约，v2 再按 §7.4 增加运行时绑定。

主线程永远不是角色审核者。任何以角色名进入 gate 的审查、验证 evidence 都必须声明为 native subagent 产出；v1 按自报告契约校验，v2 再做运行时验证。主线程负责事实调查、整合、处置 findings、更新 artifact 或发起下一轮 subagent。

### 11.2 角色矩阵

| Gate | 事实调查 | 对抗审查（多视角） |
|---|---|---|
| explore | 主线程直接查现有实现/隐性合约/风险，输出 `discovery.md` | `critic`（歧义、边界、遗漏） |
| propose: proposal/specs | 使用 explore evidence | `proposal.md` 产出后由 `critic` 做轻量 advisory 复核（scope/intent/non-goals/hidden assumptions）；specs 继续由 `critic` 审查需求边界、Scenario 完整性 |
| propose: design | 主线程按 discovery/OpenSpec artifacts/source anchors 核对架构约束 | **`architect` + `critic` + `test-engineer` 并行** |
| propose: business-invariants | 主线程从 discovery/specs/design/source anchors 起草 `business-invariants.md` | `critic`（伪不变量/过宽/缺 source） + `test-engineer`（enforcement 可执行性） |
| propose: test-contract | 主线程直接核对测试框架/约定 | `test-engineer`（红绿契约可执行性） + `critic`（覆盖矩阵完整性） |
| propose: tasks | 主线程直接核对模块/依赖/触点 | `critic`（覆盖、依赖序、**并行写冲突**） |
| apply | 主线程按 test-contract 和任务触点选择/运行测试 | 红绿灯纪律（§9）；可选 `test-engineer` 诊断不作为硬 gate |
| review | — | **`code-reviewer` + `architect` + `critic` source guidance** + final verification（`verifier` + `critic` proof/gap 复核） + 终局 `main_adjudication` |

v1 review 硬门禁要求 `superspec-review` 先在 repo-local native-subagent surfaces 上产出 `source_guidance`，主线程读取关键 source 后执行 final verification，再基于 `source_guidance` + `verification_review` / `final_test` 生成唯一的终局 `main_adjudication`。subagent 可以报告风险、约束、claims 和推荐动作，但不能直接把 `review_complete` 放行；SuperSpec gate 只接受主线程 adjudication 作为最终 allow proof。`verification_review` 负责复核 proof/gap、范围漂移、遗漏风险和 rollback 充分性；若它暴露新的 blocking issue，本轮 review 保持 block，修复后重跑 verification，再进入终局 adjudication。`security-reviewer` / `performance-reviewer` 不作为 v1 独立硬门禁角色，后续可按项目需要扩展为专项 profile 或独立 role。

### 11.3 evidence 契约

subagent evidence 必须含 `execution_mode:"native_subagent"`、`agent_role`、`agent_id`、`prompt_ref`、`output_ref`、`source_anchors`、`target_refs`（§5.5 内容指纹）。review-phase `source_guidance` 还必须提供 `source_refs`、`required_load_refs`、`required_claim_ids`，这样主线程才能把 subagent 当导游而不是最终裁决者。这里的 `source_refs` / `required_load_refs` 不再是路径字符串，而是 `pinned_ref = {path, blob_sha}`；其中 `pinned_ref.path` 一律使用 repo-root relative path。对于 review-phase `source_guidance.target_refs`，其 `target_refs[].path` 也一律使用 repo-root relative path。`required_load_refs` 必须按 `(path, blob_sha)` 精确包含于 `source_refs`，同一路径不同 blob 视为不同材料。`output_ref` 必须可读且非空，不能指向被审查 target 文件本身。subagent 不可用时 gate 必须 block，不得降级为主线程自审、主线程复述、standalone prompt 或 `execution_mode:"direct"`。

v1 中 `agent_id` 属于 `trust:self_reported_native_subagent`：guard 只能校验字段存在、格式、输出引用和非 direct 约束，无法机械证明该 agent 真跑过。v2 启用 SubagentStart/SubagentStop runlog 后，guard 再把 `agent_id` 对照 §7.4 的真实启动日志核验，升级为 `runtime-verified`。

### 11.4 与 OpenSpec 原生产出引擎的关系（委托，不替换）

SuperSpec 是 OpenSpec 的 **overlay**：不仅复用其 `status`/`validate`/`archive`，更**必须复用其产出引擎**——artifact 的 `template`/`rules`/`context`/`instruction` 由 OpenSpec 经 `openspec instructions` 注入，SuperSpec **不得**自造一套平行产出流程（否则丢失 schema 模板/项目上下文/校验对齐，违背"增强而非替换 OpenSpec"原则）。

- **产出（propose）**：`superspec-propose` 必须显式读取 repo-local `openspec-propose` skill，继承其 artifact-order / `openspec status` / `openspec instructions` 协议；每个 OpenSpec artifact（proposal/specs/design/tasks）必须经 `openspec instructions <artifact> --change <c> --json` 取回 `template`/`rules`/`context`/`instruction`/`dependencies`/`resolvedOutputPath`，先读 `dependencies` 列出的已完成 artifact，再按 `template` 写到 `resolvedOutputPath`；`context`/`rules` 是对作者的约束，**不写进**产出文件。SuperSpec 覆盖 OpenSpec propose 的 one-shot 形态，在每个 artifact 产出后插入增量：进入 propose 前必须通过带用户确认的 `explore_complete`；proposal→`proposal_reviewed` hard internal gate（round-tagged `critic` review + 披露循环，无 legacy 豁免）；design→subagent 审查 + 人审；specs/design→business-invariants 起草 + critic/test-engineer 审查；business-invariants→test-contract 起草；tasks→元数据富化（refs/scope/TDD/parallel/invariant_refs），并以 `check-enter` 收口。
- **实现（apply）**：`superspec-apply` 必须显式读取 repo-local `openspec-apply-change` skill，继承其 status / `contextFiles` / task list / progress / dynamic instruction 协议；必须经 `openspec instructions apply --change <c> --json` 取回这些事实，读全 `contextFiles` 后按任务实现。SuperSpec 覆盖 OpenSpec apply 的直接实现循环，在每个 task 外层包 `check-task-edit`→RED→实现→GREEN→`check-task-complete`，勾选 `- [ ]`→`- [x]` 交由原生 apply 语义。
- **归档（archive）**：归档以 OpenSpec 原生 CLI 为准：当前 v1 固定使用 `openspec archive -y <c>`，依赖 OpenSpec 自带 delta→main spec sync + validate（已实测 1.4.1），SuperSpec 不暴露 `--skip-specs` 分支，也不允许 `--no-validate`。当前 repo-local `openspec-archive-change` skill 的手动 `mkdir`/`mv` 流程与 SuperSpec archive-preservation 约束冲突，只可参考其选择/status guardrails，不能替代 `openspec archive`。SuperSpec 在 native CLI 前后加 `check-archive-ready`（含 archive 域人审 + preservation manifest）与 `check-archived`。
- **探索（explore）**：`superspec-explore` 必须显式读取并遵循 repo-local `openspec-explore` skill 的 stance / OpenSpec Awareness（如 `openspec list --json`、`openspec status --change <c> --json`、读取 `artifactPaths`）。SuperSpec 在其上加更严格边界：explore 阶段只产出 sidecar `discovery.md` 与 `critic` evidence，不写 OpenSpec planning artifacts；OpenSpec explore 中"可捕获到 proposal/specs/design/tasks"的建议在 SuperSpec 中改为记录到 discovery，并交给 `superspec-propose` 通过 `openspec instructions` 落地。
- **铁律**：SuperSpec skill **绝不**绕过 `openspec instructions` 徒手编写 OpenSpec artifact 或实现循环。v1 中 guard 至少以 `openspec validate` 兜底产出合法性；"是否经 instructions 产出"属 skill 纪律（v1 audit-only，v2 可经 hook 取证）。

---

## 12. Review（含 Verification）/ Archive

### 12.1 review evidence

review-phase native-subagent evidence 统一使用 `kind:"source_guidance"`。`code-reviewer` / `architect` / `critic` 都必须提供 `output_ref`、`source_refs`、`required_load_refs`、`required_claim_ids`、`base_ref`、`head_ref`、`reviewed_files`、`blocking_findings`、`non_blocking_findings`、`finding_dispositions` 和 `rollback_targets`。其中：

- `source_refs` / `required_load_refs` 使用 `pinned_ref = {path, blob_sha}`。
- `pinned_ref.path` 一律使用 repo-root relative path；不要按 change root 解释它。
- review-phase `target_refs[].path` 与 `reviewed_files[]` 也一律使用 repo-root relative path，确保 freshness / diff coverage 校验针对真实被审查文件。
- `required_load_refs` 必须是 `source_refs` 的精确子集，比较键为 `(path, blob_sha)`，不能只按 `path`。
- 每条 `blocking_findings[*]` 必须带稳定 `finding_id`。
- `finding_dispositions[]` 使用最小 machine-readable 结构 ` {finding_id, recommendation, rationale} `；它必须对每个 `blocking_findings[*].finding_id` 恰好覆盖一次，但只表达 subagent 自己的建议/状态，不能替代主线程最终裁决。

通过要求：三种角色的 live/pass `source_guidance` 都存在、覆盖本次 diff、且把需要主线程亲自读取的材料列在 `required_load_refs`。主线程在读完 final verification 结果后，必须写出唯一的终局 `kind:"main_adjudication"`。这条 evidence 的 canonical 作者边界固定为：

- `execution_mode:"direct"`
- `created_by:"main-thread"`
- 禁止出现 `agent_role`、`agent_id`、`prompt_ref`

`main_adjudication` 必须记录：

- `review_decision`（只允许 `allow | request_changes`；`review_complete` 只接受 `allow`）
- `request_changes_route`（仅 `review_decision:"request_changes"` 时允许，v1 只允许 `reopen_tasks | change_update`）
- `source_evidence_refs`
- `blocking_source_evidence_refs`（仅 request-changes path 使用，且必须是 `source_evidence_refs` 子集）
- `reopen_task_ids`（仅 `request_changes_route:"reopen_tasks"` 时允许非空）
- `verification_evidence_refs`
- `loaded_refs`（同样使用 `pinned_ref = {path, blob_sha}`，其 `path` 也必须是 repo-root relative，并且必须按 `(path, blob_sha)` 精确覆盖全部 `required_load_refs`；同一路径不同 blob 不算已加载）
- `claim_adjudications[] = {claim_id, decision, rationale}`
- `finding_adjudications[] = {finding_id, decision, rationale}`
- `output_ref`

其中：

- 每个 `required_claim_id` 必须在 `claim_adjudications[]` 中出现且只出现一次。
- 每个 `blocking_findings[*].finding_id` 必须在 `finding_adjudications[]` 中出现且只出现一次。
- `claim_adjudications[].decision` 使用 `accept | reject | needs_fix`；`needs_fix` 不是 allow 终态。
- `finding_adjudications[].decision` 使用 `dismissed | accepted_fixed | accepted_deviation | needs_fix`；只有前三者是 allow 终态，`needs_fix` 直接 block。
- allow path 的 `verification_evidence_refs` 必须覆盖本轮 `verification_review` / `final_test` 的 live/pass evidence id；没有读到这些终局验证证据，不得写出 allow 所需的终局 adjudication。
- allow path 的 `source_evidence_refs` / `verification_evidence_refs` 只能引用本轮 live/pass `source_guidance` / `verification_review` / `final_test` evidence id；缺失引用或额外 unknown / non-live id 都必须 block。
- `review_decision:"request_changes"` 时，`verification_evidence_refs` 必须为空；本轮正确出口是 `request_changes_route` handoff，而不是 `review_complete` allow。
- `request_changes_route:"reopen_tasks"` 时，`blocking_source_evidence_refs` 必须包含能够授权 reopen 的 `code-reviewer source_guidance` evidence，且对应 `blocking_findings[*].affected_task_ids` 必须覆盖被 reopen 的 task。

没有 `main_adjudication`，即使 subagent 全部写了 “pass” 也必须 block。缺 repo-local role agent/prompt 或无法启动 native subagent 时 block，不允许主线程或用户全局 prompt 代审。

### 12.2 verification evidence

最终验证 evidence 使用 `kind:"verification_review"`，并且在 `review_complete` 判定中只接受 `gate:"review_complete"` 的 `verification_review` / `final_test` 证据。`check-verify-ready` / `verify_complete` 仅是兼容命令别名，必须复算同一个 `review_complete` 契约，不能放宽证据搜索范围。`verification_review` 含 `openspec_validate_ref`/`task_matrix_ref`/`invariant_matrix_ref`/`scope_drift_ref`/`test_evidence_refs`，其中 `openspec_validate_ref` 必须引用本次 `openspec validate` 输出。`final_test` 使用最小 schema：`kind:"final_test"`、`gate:"review_complete"`、`test_command`、`output_ref`，并依赖 canonical evidence `status:"pass"` 作为 allow 所需的成功状态；`output_ref` 必须可读、非空并指向本次终局测试运行日志/结果。通过要求：`openspec validate` pass、tasks 全完成、所有 impl task 有 RED/GREEN 或替代验证、每个 non-post hard invariant（`automated-test` / `review-checklist` / `human-confirmation`，不含 `advisory`）均进入每条 `verification_review.invariant_matrix_ref` 指向的 markdown 表格，且对应行 `status` 只能是 `pass | accepted`，`evidence` 单元必须引用至少一个 live/pass `evidence_id`；普通段落中提到 `INV-*` 不算覆盖，`confirmed` 只是 invariant confidence，不是 final matrix pass 状态。无未解释 scope drift，并且 `verifier` + `critic` 两条 `verification_review` 都存在且各自满足 matrix 覆盖。`verification_review` 提供 proof/gap，不替代主线程的 review 裁决；若它发现新的 blocking issue，则本轮 review 不得以旧 adjudication 放行，必须在修复后重跑 verification，再生成终局 `main_adjudication`。

### 12.3 archive 边界（补 critic 3.5）

区分 `archive_ready`（可执行 archive）与 `archived`（已执行 + 观察到 evidence 保留）。
- v1：`openspec archive` 前必须通过 Sync Guard / skill 检查；提前或越权 archive 只能由事后检测识别并记录为不可逆偏差。
- **R-2 已实测**：OpenSpec 1.4.1 默认 `spec-driven` 的 `openspec archive` 会随 change 目录迁移并保留 `.superspec/`。v1 仍必须在 archive 前生成 `.superspec/artifacts/archive-preservation.json` manifest，`check-archived` 通过 archive 目录内 `.superspec/` 与 manifest 比对完成校验。
- **防回归 fallback**：若未来 OpenSpec 行为改变导致 `.superspec/` 不保留，guard 必须在 archive 前把 `.superspec/` 复制到稳定 preservation bundle（如 archive 目标目录内的 `.superspec-preservation/`），再执行/修复 archive；`check-archived` 只信任 preservation manifest/bundle，不假设 OpenSpec 永远迁移隐藏目录。
- v2：L4 Bash hook 在 `archive_ready` 未过时物理 deny `openspec archive`（不再只是事后发现）。
- archive 后 change 移至 `openspec/changes/archive/<date>-<change>/`，`check-archived` 必须**走 archive 目录查找**，不能再用 `status --change <c>`（可能找不到）。
- 提前/越权 archive 标记为不可逆 + 文档化检测窗口。

---

## 13. 规模分级（补 critic M6）

> **v1 实然声明（审计 E-1，用户裁决 2026-06-10）**：v1 的 gate 面板是 **full-only**——`hotfix`/`tweak` preset 当前**不放宽任何 gate**，guard 对非 full preset 只做"变更规模超标 → 强制升级确认"（`preset_upgrade_requires_human_confirmation`），不提供精简流程。下表的精简语义是**未来设计目标**，需另立设计稿（gate 子集、披露循环在精简面板下的语义、与 §6.5 判定矩阵的交互）后才可实施；在那之前选择 `hotfix`/`tweak` 的唯一实际效果是声明意图 + 触发升级闸门。

并非所有 change 都走完整 9 道 gate。按复杂度选 preset（**目标语义，v1 未实现精简**）：

| preset | 适用 | 流程（目标，v1 实际全部走 full 面板） |
|---|---|---|
| `full`（默认） | 新功能、架构变更、跨模块 | 完整 `project init -> explore -> propose -> apply -> review -> archive` + 全审查面板（final verification 在 review 内） |
| `hotfix` | 单函数/模块 bug 修复 | 精简：复现 RED → 修复 → GREEN → review 内轻量 final verification；可精简前置设计/任务审查面板，但 `review_complete` 仍必须满足标准 review 契约（3 条 `source_guidance` + review 内联 verification + 终局 `main_adjudication`） |
| `tweak` | 文案/配置值/文档微调 | 最精简：跳过深度设计与并行审查面板，但 `review_complete` 仍必须满足与 `full` / `hotfix` 相同的标准 review 契约 |

**升级标准（命中任一即升 full，强制；v1 已实现该闸门）**：

- hotfix→full：涉及 3+ 文件 / 架构变更 / schema 变更 / 引入新公共 API / 超出单函数模块。
- tweak→full：涉及 5+ 文件 / 跨模块 / 需 5+ 新测试 / 配置项增删（非改值）。

preset 与升级写入 `superspec-state.json` 的 `superspec` 节，由 guard 校验；升级是 §14 的人审阻塞点之一。

---

## 14. 人审阻塞点（回应"不能单纯靠模型控制"）

以下节点 guard 判定后，skill **必须用 AskUserQuestion 暂停等待用户显式选择**，不得用推荐/默认/历史偏好替代，不得只输出文字提示就继续：

1. explore 结论、范围边界和进入 propose 的确认；proposal 阶段还必须通过 `proposal_reviewed` hard internal gate；proposal/tasks 等 material findings 走披露循环用户裁决
2. 设计方案（brainstorming）选择
3. apply 前的隔离方式 + 执行方式选择
4. verify 失败时"修复 or 接受偏差"（含 spec drift 处置）
5. 分支处理方式
6. preset 升级（hotfix/tweak→full）
7. apply 期范围膨胀需重设计或拆新 change

**guard 侧 evidence 锚点（FIX-8 / 审计 A-5）**：上述阻塞点中 #1 的 explore 进入 propose 部分、#2、#3、#4、#5、#6、#7 在 guard 侧均有 `human_confirmation` evidence 锚点——分别为 gate `explore_complete`、`design_complete`、`apply_isolation`（`check-apply-ready`、task gates 和 task reopen gate 强制，confirmation 须 pin `tasks_structure_hash`，即 checkbox 不敏感的 tasks.md 结构指纹，可从 `status` 输出读取）、`verify_failure_handling`（`review_complete` 在存在 fail 状态 verification evidence 时强制，且 supersede 不可抹除该义务）、`branch_handling`、`preset_upgrade`、`scope_expansion`（tasks.md 结构在 apply 批准后变化时 task gates / task reopen gate 强制重新批准）。proposal 的 material findings 使用披露循环里的 `user_review_decision`，不另设 `human_confirmation` gate。锚点只保证"跳过人审必留痕/必 block"，不能机械证明用户真的被询问（v1 天花板 §6.6）。

**Red Flags**（出现以下念头即停下走 AskUserQuestion）：「用户大概会同意」/「小改动不用确认」/「上次选了 A 这次也 A」/「我说了计划用户没反对」/「都走到这了应该没事」。

---

## 15. 旧流程处理（无需迁移）

`yourflow` / `workflow` / `ai-dev-workflow-toolkit` 及 in-flight change `openspec-delivery-extension` 均为测试期产物、**未投入使用**，因此 **superspec 不做任何兼容迁移**：

- SuperSpec 从干净 overlay（guard + sidecar + skills）起建，不 fork OpenSpec schema，不导入旧 sidecar 状态。
- 旧目录可直接删除或隔离；最多保留为**负例 fixture**（验证不受约束 sidecar 漂移会被 Sync Guard block）。
- 仅在**概念层**参考旧实现（rollback / invalidation / semantic_status / BLOCKER_DOMAINS 等与状态机无关的思路）；其 `(stage,substage)` 状态机及相关测试不可照搬，gate/transition 一律按本规范新写。

---

## 16. 目录与文件布局

```text
package.json package-lock.json tsconfig.json
superspec_guard.ts superspec_init.ts  # npm bin / 仓内开发入口
src/ tests/                          # guard 运行时 + 回归测试
templates/                           # workflow / sidecar 模板
adapters/ schemas/                   # runtime adapter payload + manifest schema
docs/            # 规范源（本目录）
  README.md                        # 文档入口和阅读顺序
  SPEC.md                          # 本文（v0.4 单一规范源）
  DISTRIBUTION.md                  # 分发 / 安装 / 升级 / 卸载方案
  designs/                         # 专题设计与 RFC
  audits/                          # 审计报告与评审发现
  plans/                           # 修复计划与交接手册
  history/                         # 早期草案和历史对照
  templates/                       # sidecar artifact 模板
  hooks/                           # v2 planned：hook 配置/adapter 规范源 + tests
.superspec/config.yaml               # optional 项目级 SuperSpec 默认配置（唯一项目级配置名；缺失时使用内置 defaults）
.codex/skills/superspec-{explore,propose,apply,review,archive}/
                                    # 安装：Codex 加载的 5 个用户可见主流程 skill；init 使用 superspec-init，verify 并入 review
.codex/hooks.json                  # v2 安装：L4 hook 配置
openspec/changes/<change>/         # 运行时（OpenSpec 正本，spec-driven，不改 schema）
  proposal.md specs/ design.md tasks.md
  .superspec/
    config.yaml                     # optional change 级覆盖配置（唯一 change 配置名）
    artifacts/business-invariants.md # phase-created SuperSpec sidecar，不进 OpenSpec graph
    artifacts/test-contract.md     # phase-created SuperSpec sidecar，不进 OpenSpec graph
    superspec-state.json              # guard-owned 运行态状态
    evidence/ ledger.jsonl          # evidence dirs phase-created; ledger init-created
```

---

## 17. 测试计划

- **OpenSpec 基线**：change 使用默认 `spec-driven`（`openspec status --json` 仅含 proposal/specs/design/tasks）；禁止依赖 custom `superspec` schema；`check-init` 必须在 repo-local OpenSpec Codex skills（如 `openspec-propose` / `openspec-apply-change` / `openspec-archive-change` / `openspec-explore`）缺失或 front matter 异常时 block，也必须在 `openspec instructions` / `archive` / `validate` / `status` CLI surface 不可用时 block，提示先执行 `openspec init --tools codex` 或 `openspec update --force`。
- **Guard 单元**：artifact missing→block；caller 传入 status→ignored；evidence missing→block；角色 evidence 非 `execution_mode:"native_subagent"`→block；角色 evidence 伪装 main-thread adjudication→block；`main_adjudication` 缺 canonical 作者标记（`execution_mode:"direct"` + `created_by:"main-thread"`）或携带 `agent_role`/`agent_id`/`prompt_ref`→block；两轨满足→allow；ledger 含 current_stage→block；非 guard 写 state→block；status 指纹过期→`state_fingerprint_stale` block 后重算写入 `state_freshness:"recomputed"`；guard_route_phase 领先有效路由→block/下调；state 声称 artifact done→block；删 `superspec-state.json` 后可重建；state 文件存在但损坏（不可解析/非 object）→所有命令 block `state_corrupt` 且损坏文件原样保留；`recompute --rebuild-corrupt`→显式重建 + ledger 记 `state_corrupt_rebuilt` 事件；健康 state 上带 `--rebuild-corrupt`→等同普通 recompute、不写重建事件；design_complete 在 explore_complete 未过（缺 discovery/critic 证据）时→block `explore_complete_failed`；test_contract_honored 在 test_contract_drafted 未过时→block `test_contract_drafted_failed`；discovery.md/design.md/test-contract.md 在角色 review 后被改动（evidence 未 pin 当前 blob）→分别 block `stale_explore_review` / `stale_design_review` / `stale_test_contract_review`；discovery/design 改动后 state 指纹（`discovery_fingerprint`/`design_fingerprint`）必须报 `state_fingerprint_stale`；判定后、写入前发生的文件变化不得被吸收进 computed_from（写入必须复用判定时指纹，下次 check 以 `state_fingerprint_stale` 暴露该变化）；篡改 active_gate 不能绕过；RED 意外通过→block；GREEN 缺失→block；勾选无 GREEN→block；path traversal→block；并行写冲突→block；`stale_review`（blob_sha 失配）→block；`test_contract_not_honored`→block；`required_load_refs` 非 `source_refs` 精确子集→block；`loaded_refs` 未按 `(path, blob_sha)` 精确覆盖 `required_load_refs`→block；`blocking_findings` 缺 `finding_id` 或未被 `finding_adjudications[]` 一一响应→block；`claim_adjudications[]` 漏 `required_claim_id` / 重复 / `needs_fix`→block；allow path 的 unknown/non-live `source_evidence_refs` / `verification_evidence_refs`→block；仅有 `gate:"verify_complete"` verification evidence 不得满足 `review_complete`；supersede 指向不存在的 `evidence_id`→block `supersede_target_missing`；跨 gate supersede 无 `supersede_reason`（含空白字符串）→block `supersede_unauthorized`；同 gate supersede 或携带非空理由的跨 gate supersede→不报 supersede 类 reason；dispatch 观察到 supersede→ledger 恰好追加一条 `evidence_superseded` 事件（重复 dispatch 不重复记录）；state 损坏时不写 supersede ledger 事件；未知 `kind`→block `evidence_unknown_kind`，白名单内全部 kind→不报 unknown；`human_confirmation` 缺 `confirmation_text` / 缺 `confirmed_refs[]`（branch_handling 为 `confirmed_paths[]`）/ gate 不在消费集合→block `human_confirmation_invalid`，字段齐备→不报；`apply_isolation`/`scope_expansion` confirmation 缺 `tasks_structure_hash`→block `human_confirmation_invalid`；task_edit/task_complete/task_reopen 无 live `apply_isolation` confirmation→block `apply_isolation_unconfirmed`，有 confirmation→allow；tasks.md 结构（checkbox 不计）在批准后变化→block `scope_expansion_unconfirmed`，补 `scope_expansion` confirmation pin 当前结构→解除；仅勾选 checkbox 不触发 scope 重批；review_complete 存在 fail 状态 verification evidence 且无 `verify_failure_handling` confirmation 覆盖其 evidence_id→block `verify_failure_unconfirmed`，覆盖后→allow；对 fail evidence 的 supersede 不解除 disposition 义务；role evidence `prompt_ref` 不可读→block `evidence_prompt_missing`、内容为空→block `evidence_prompt_empty`、逃逸 change root→`evidence_unsafe_ref`，可读非空→不报；同 change 内重复 `evidence_id`→block `evidence_id_duplicate`，全唯一→不报；`test_run` 缺 `raw_log_refs`→block `test_run_log_missing`、缺 `result_summary`→block `test_run_summary_missing`、日志不可读/为空→block `test_run_log_missing`、逃逸 change root→`evidence_unsafe_ref`；声称的 `test_id` 不在引用日志中→block `test_id_not_in_log`；按运行建档的 `test_ids[]` 清单 + 日志齐备→不报 test_run 类 reason；propose 期同 gate role evidence 复用同一 `output_ref`→block `evidence_output_ref_duplicate`；跨 gate 复用 `output_ref` 无 `review_scope[]` 或 scope 不含本 gate target artifact→block `review_scope_unverified`，scope 覆盖全部被盖章 gate 的 target→allow；`*_evidence_refs`（列表或 lane 映射）引用不存在的 evidence_id→block `dangling_evidence_ref`，全部可解析→不报。**DISC 披露不动点（Phase 1，explore_complete）**：schema 不合法的 digest/decision/authorization/findings→分别 block `review_digest_invalid` / `user_decision_invalid` / `standing_authorization_invalid` / `review_finding_invalid`；material blocker 无 digest→block `missing_review_digest` + `finding_unresolved`；digest 含 `needs_user_decision`→block `needs_user_decision_pending`；本轮 finding 未入 digest→block `finding_undisclosed`；最新轮 review/digest 未 pin 当前 target 集合→block `review_round_stale` / `review_digest_stale`；clean 重审不抹历史 blocker→block `finding_unresolved`；disposition 改写身份字段/summary 非逐字→block `finding_identity_mismatch` / `finding_summary_not_verbatim`；material 终态缺用户锚点或 decision 绑定失败（uid/scope_key/material/blob/结构序任一不匹配）→block `user_decision_unbound`；standing auth 越界（material 未授权/blocker/gate 不符/过期/excluded 优先）→block `standing_authorization_unbound`；option_d_custom 的 requires_artifact_update / requires_rereview 未兑现→block `artifact_update_required` / `rereview_required`；accepted material deviation 未被 clean 轮 ack→block `accepted_deviation_unacknowledged`；round 编号断档或 digest 链断→block `review_round_discontinuous` / `digest_chain_broken`；round k>1 prompt 缺工具渲染 ledger→block `ledger_injection_missing`；超 3 轮未收敛→block `round_budget_exhausted`；完整披露循环（finding→blocked digest→user decision→artifact 更新→supersede 旧轮→注入 ledger 重审→链式 digest 终态）→allow；非 material finding 经有效 standing auth 一轮关闭→allow；旧式无 round evidence→不触发披露检查（grandfathered）。**DISC Phase 2（proposal_reviewed / design_complete）**：`proposal_reviewed` 无任何 round-tagged review + digest→block `missing_proposal_review` + `missing_review_digest`；旧式无 round critic evidence 不能绕过强制披露（born-disclosure gate 无 grandfather 路径）→仍 block `missing_review_digest`；proposal blocker 不经披露直接重审到 clean→block `finding_unresolved`，已披露 finding 被下一轮 digest 丢弃→block `needs_user_decision_pending`；user decision + user_decided disposition 闭环→allow；disposition route 不在全局枚举→schema block `review_digest_invalid`，route 合法但越 gate 子集（如 proposal 上用 `reopen_tasks`）→block `finding_route_invalid`，`return_explore` 在 proposal 上合法；`design_complete`/`propose.design_reviewed` 别名、`propose_complete` 子门、`specs`/`design` artifact entry、`propose.tasks_mapped`/`tasks_complete` 直连入口在缺 `proposal_reviewed` 时全部 block（`proposal_reviewed_failed` 或前置链 code）；design round-tagged review + digest pin 全 glob 集合→allow，digest 后新增 spec 文件（集合不等，P1-6）→block `review_round_stale` + `review_digest_stale`；legacy（无 round）design evidence→不触发披露检查（grandfathered，P2-3）。**DISC Phase 3（invariants_reviewed / test_contract_drafted / tasks_complete）**：round-tagged invariants material blocker 无 digest→block `missing_review_digest` + `finding_unresolved`；upstream business-invariants 改后 digest stale→block `review_digest_stale`；invariants/test_contract 上非法 route（如 `reopen_tasks`/`return_test_contract_drafted` 越界）→block `finding_route_invalid`；test_contract digest 后新增 spec 文件（glob 集合不等）→block `review_digest_stale`；legacy invariants/test_contract evidence（无 round）→不触发披露（grandfathered）；tasks_complete 无 round-tagged review→不触发披露；tasks 一旦出现 round-tagged review 无 digest→block `missing_review_digest`；tasks 上 `return_test_contract_drafted` route 合法→不报 `finding_route_invalid`；pinned target path 用 repo-root 前缀或 `../` 逃逸（target root mismatch，设计 §7 全 propose 期 gate 只认 change-root 相对路径）→集合不等 fail-closed block `review_round_stale` + `review_digest_stale`。
- **安装引擎单元（D4 / 审计 G-1、G-2）**：真实 install-map 可解析且全部 source 存在；fresh install 拷贝文件 + wrapper exec bit + 写 schema-valid manifest（manifest sha256 = managed 基线）；重复 install 幂等（全 ok）；preexisting 不同内容文件→不覆盖、manifest 标 `preexisting/managed:false`，`--force` 才覆盖且先备份 `*.bak`；update 三态：未改→滚动到新版、用户改过→保留用户版 + `*.new`（manifest 保留旧基线 sha 供 uninstall 识别改动）、下架且未改→删除；无 manifest 时 update/uninstall fail-closed；uninstall 只删未改 managed 文件，preexisting/用户改过/`.superspec/` 数据一律不碰，`--dry-run` 不动文件，结束删 manifest；`--update` 与 `--uninstall` 互斥→guard_error；install-map 与 guard 常量一致性（`REQUIRED_SUPERSPEC_WORKFLOW_SKILLS` 全部 skill + `REQUIRED_SUPERSPEC_AGENT_ROLES` 全部 agent/prompt 在 map 中）；check-init 在 superspec workflow skill 缺失→block `superspec_init_missing`、frontmatter name 非法→block `superspec_skill_invalid`，齐备→allow。
- **真实 OpenSpec CLI 冒烟（D5 / 审计 F-4，opt-in）**：`SUPERSPEC_REAL_OPENSPEC_SMOKE=1` 时（CI `real-openspec-smoke` job：workflow_dispatch + 每周 schedule）对真实 `openspec` CLI 跑：CLI 必须在 PATH（缺失→fail 而非 skip）；临时项目 `openspec init --tools none` + 最小 delta change 后真实 `openspec status --json` 满足 `openspec_status_shape_reasons` 形状契约 + 四 artifact 齐备 + change/repo root 解析；真实 `openspec validate` 通过；guard `status` / `check-enter` 对真实 CLI 端到端 dispatch（status allow + explore block `missing_discovery`）。默认（无环境变量）4 个用例全部 skip。
- **Hook（L4，v2 acceptance，不属于 v1 测试计划）**：apply_patch 命中 write_scope 无 RED→deny；`openspec archive` 在 archive_ready 未过→deny；PostToolUse 捕获真实 exit_code 生成 RED/GREEN；伪造 agent_id（不在 runlog）→evidence rejected；guard hook 异常→exit 2（fail-closed）。
- **Integration**：status 字段变化只依赖稳定字段/兼容层；sidecar test-contract 缺失时 `test_contract_drafted` block；tasks/test_refs 未兑现时 `test_contract_honored` block；review evidence 存在但 tasks 未完成→block；archive preservation bundle 缺失或 manifest 不匹配→archived block；`check-review-complete` 只接受 `gate:"review_complete"` 的 verification/final-test evidence；`check-verify-ready` 只是同一契约的兼容入口。
- **E2E fixture**：最小 change 跑 `project init -> explore -> propose -> apply -> review -> archive`，每个主阶段 gate 测"缺→block / 补齐→allow"两次；`design_complete`、`test_contract_drafted`、`tasks_complete` 只作为 propose 内部 gate 测试，`check-verify-ready` 仅测兼容别名。review 阶段必须同时覆盖一条完整 allow path：3 条 `source_guidance`、精确匹配的 pinned `source_refs/required_load_refs/loaded_refs`、完整 `claim_adjudications[]`、完整 `finding_adjudications[]`、`verification_review` + `final_test` 齐备后 allow。
- **Skill 冒烟（委托原生引擎，见 §11.4）**：`superspec-explore` 必须显式桥接 `.codex/skills/openspec-explore/SKILL.md` 和 `openspec list --json`；`superspec-propose` 必须显式桥接 `.codex/skills/openspec-propose/SKILL.md` 且引用 `openspec instructions <artifact>`；`superspec-apply` 必须显式桥接 `.codex/skills/openspec-apply-change/SKILL.md` 且引用 `openspec instructions apply`；`superspec-archive` 必须说明 `.codex/skills/openspec-archive-change/SKILL.md` 的手动 move 流程被 `openspec archive` CLI 覆盖，并实际使用 `openspec archive -y`（依赖其自带 sync+validate，不暴露 `--skip-specs` / `--no-validate` 分支）；任一 skill 出现"徒手 Write/update OpenSpec artifact 而不经 instructions"即视为回归。

### 17.1 已知测试覆盖缺口

**reason code 覆盖（FIX-13 / 审计 F-1，2026-06-10 已闭合）**：按"src 中 `reason()` 字面 code 全集 vs 测试文件字符串全集"对账，所有 block reason code 均已至少有一个测试断言其出现；该对账口径应在新增 reason code 时保持（新增 code 必须随手补测，否则 diff 重新出现）。

当前测试已覆盖主路径和大量 block path，但以下回归边界仍需补齐，避免后续扩展再次产生规范漂移：

- 禁用配置/状态别名应覆盖 §5.2/§5.3 的全量黑名单，而不是只抽样 `.superspec.yaml`、`.superspec/config.json`、`.superspec/state.json`。
- `check-archived` 需要 manifest 存在但内容/sha 不匹配的负例。
- `dispatch` 需要明确证明调用方无法通过传入伪造 status 影响判定；guard 只能使用自己的 `load_context`/OpenSpec status。
- skill smoke 需要负向断言：不能在保留 `openspec instructions` 文案的同时新增徒手 Write/update OpenSpec artifact 的步骤。

---

## 18. 实施路线图（分两期交付）

**架构一次到位，实现分两期。** v1 必须先把 OpenSpec 默认流程、Sync Guard、skills、sidecar artifacts 和一个真实 change 跑稳；hook/L4 只能在 v1 验收后进入 v2。v1 的 Sync Guard 只需保持 **hook-compatible** 边界：命令参数稳定、输出 `allow/block` JSON、evidence schema 预留 `trust`/`agent_id`/`tool_response_ref` 等字段、失败时可映射为 `exit 2`。v1 **不**定义或 stub hook stdin adapter，不解析待应用 patch，不摄取 PostToolUse `tool_response`，不写 SubagentStart/SubagentStop runlog。

### v1（MVP，定位 = `audit-only discipline layer`）

> **强制力天花板（见 §6.6）：v1 所有 SuperSpec 证据可被伪造闭环，真实净强制 = OpenSpec 原生硬约束 + 合作型 agent 纪律 + 事后审计。v1 不满足"防抄近路"诉求——那是 v2 的事。**

1. 本规范源（SPEC.md）评审定稿。
2. 确认 change 走默认 `spec-driven`；落地 sidecar 模板（`docs/templates/`）+ 示例 change 验证 `openspec status` 与 SuperSpec guard gate（**不 fork schema**）。
3. 实现 Sync Guard（guard-owned state + 指纹对账 + fail-closed + **hook-compatible 命令/JSON 输出接口**），仅复用 workflow guard 的 rollback/semantic_status 等**状态机无关** schema；**gate/transition 测试按本规范重写，不复用旧 `(stage,substage)` 状态机测试**。
4. 编写 5 个用户可见 `superspec-*` skill：`superspec-explore`、`superspec-propose`、`superspec-apply`、`superspec-review`、`superspec-archive`（三段式 + subagent 矩阵 + 红绿灯纪律 + 规模分级 + 人审阻塞点 + references）；project init 由 `superspec-init`（仓内开发入口 `superspec_init.ts`）完成，final verification 并入 `superspec-review`，旧 `check-verify-ready` 仅作为兼容入口；`design`、`test-contract`、`tasks` 只作为 `superspec-propose` 内部步骤；**所有 OpenSpec artifact 的产出/实现必须委托 `openspec instructions`（见 §11.4），SuperSpec 仅加 gate/红绿灯/审查外层**；推进处 instruction 要求"先调 guard 且 PASS"。
5. 清理/隔离旧测试期流程（无需迁移，见 §15）。
6. 端到端跑通一个真实 change，**观测"模型是否会跳过 guard 抄近路"——这是决定 v2 必要性的数据**。

### v2（验证后加，强制级别 → `mechanical` / `runtime-verified`）

前置条件（满足才启动）：① v1 overlay（guard + skills + sidecar）已通过真实 change 验收；② R-1 spike 确认 PreToolUse 能物理 deny `apply_patch`、`unified_exec` 不会大面积绕过、guard-as-hook 时延可接受；③ v1 实测显示 `audit-only` 不足以约束模型。

7. 落地 hook adapter 与 `.codex/hooks.json`（L4）+ guard-as-hook 包装（fail-closed），接 PreToolUse deny / PostToolUse 取证 / SubagentStart/SubagentStop runlog。
8. 把核心门禁从 `audit-only` 升到 `mechanical`，evidence 防伪切换到运行时捕获。

> 若环境无 hook（hooks 被禁用 / 未 trust），系统**永久停留 v1 audit-only** 并在 guard 输出中显式告警，不假装拥有 mechanical 强制。

---

## 19. 决策点与待验证

### 19.1 决策点（默认已选，可改）

- **D-1 命名**：正式定为 **SuperSpec**（技术标识小写 `superspec`），原占位代号 `irsflow` 已全局替换。
- **D-2 需求澄清形态**：默认不单独成 OpenSpec artifact（用 skill prompt + `.superspec/artifacts/discovery.md` + guard 现状调查门禁）；备选独立 sidecar `discovery` artifact。
- **D-3 state 边界**：采纳受控状态 + gpt5.5 指纹对账（已定）。
- **D-4 强制力（分期）**：v1 定位 = `audit-only discipline layer`（不依赖 hook）；v2 必须在 v1 跑通并完成 R-1 spike 后才加 L4 hook 升 `mechanical` / `runtime-verified`。v1 guard 接口保持 hook-compatible，但不实现 hook adapter；无 hook 环境永久停留 v1 并显式告警。
- **D-5 OpenSpec 边界**：v1 固定默认 `spec-driven`，不 fork schema、不新增 OpenSpec artifact、不把 SuperSpec gate 写进 OpenSpec requires 链。

### 19.2 待验证

- **R-1（部分确认，关键项未测）**：Codex 0.136.0 **支持 hooks 框架、PreToolUse/deny 接口存在** = 已确认（版本 + 官方文档）；但 **PreToolUse 对 `apply_patch` 的真实 deny 行为、`unified_exec` 绕过率、guard-as-hook 端到端时延 = 未实测**。**v2 启动前必须真跑 deny spike**；若 deny 不可靠或 `unified_exec` 大面积绕过，则 `mechanical` 强制在 Codex 下不可达，需重估 v2。
- **R-2（已验证，保留回归测试）**：OpenSpec 1.4.1 默认 `spec-driven` archive 会保留 `.superspec/`；v1 需把该行为固化为 E2E 回归测试，并保留 §12.3 fallback 以应对未来 OpenSpec 行为变化。
- **R-3**：`openspec status --json` 字段稳定性。运行时不因 `openspec --version` 本身阻塞；以 status 字段 shape 校验 + `1.4.1` golden fixture + 兼容层发现结构漂移，版本号仅作为诊断信息展示。
