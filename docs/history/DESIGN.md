# SuperSpec 设计文档（历史草案，请勿实现）

> Historical note: 本文是早期 v0.1 草案，保留用于设计取舍追溯。当前实现规范以 `docs/SPEC.md` 为准。本文中的 custom OpenSpec schema、`test-contract` OpenSpec artifact、`review`/`verification` artifact 等方案已经被 v0.4 sidecar overlay 方案取代，请勿按本文实现。

> 状态：草案 v0.1（待评审定稿）
> 名称 `superspec` 为占位代号，可改（全局替换即可）。
> 本文是单一规范源。`.codex/skills/superspec-*`、`openspec/schemas/superspec/`、guard 脚本均由本目录同步产出。

## 1. 背景与问题

当前基于 OpenSpec 的开发中暴露四个痛点：

1. **design 不够细致**：设计文档质量靠主观，缺强制的完备性维度。
2. **test 太简单**：测试用例覆盖不足，没有强制覆盖矩阵，开发后问题多。
3. **任务拆分没有串并行**：tasks 是平铺清单，没标出依赖、并行组、写范围。
4. **缺多视角对抗**：每个阶段单一视角生成，没有引入对抗审查/代码 review 角色，大迭代时实现与需求容易偏离。

同时，现有两套自研草稿各有硬伤：

- `yourflow`（`.yourflow/` + 分片 JSON）：**强项**是强制 Subagent Execution Boundary（主线程只编排，审查/调查必须 subagent 带证据）；**硬伤**是 `state.json` 自立 `current_phase` 状态机。
- `workflow`（`.ai-workflow/` + `workflow_guard.py`）：**强项**是可执行 guard 硬门禁、独立 code review 阶段、rollback/invalidation schema；**硬伤**是没有任何 subagent 约束（主线程可自审），且 `gate-ledger` 也自立 stage 状态机。

## 2. 设计目标与第一原则

**第一原则（最高约束）：零平行状态机。**
OpenSpec 是唯一状态主干。进度、阶段顺序、完成度一律由 `openspec status` 推导，增强框架**绝不再维护任何 `current_phase` / `stage` 字段**。sidecar 只允许存放“证据”，不允许存放“我现在在哪个阶段”。

目标：

- G1 在 OpenSpec 原生流程上**加阶段、加验证**，让需求澄清更全面、设计更完备、测试更严格、实现后有 code review。
- G2 每个阶段引入**多视角对抗审查**（按阶段配不同/多个 subagent 角色）。
- G3 测试执行严格遵循 **superpowers 风格红绿灯**（RED→GREEN→REFACTOR + Iron Law）。
- G4 扫描/调查交给 **subagent 带证据回传**，主线程只做编排与确认。
- G5 **单一规范源**，不再出现多套各自维护的工作流。

## 3. 总体架构：三层叠加

| 层 | 职责 | 落地物 | 状态来源 |
|---|---|---|---|
| **L1 Schema 层**（工作流主干） | 定义阶段/产物/门禁顺序/下发指令 | 项目本地自定义 OpenSpec schema | `openspec status` |
| **L2 Guard 层**（硬门禁） | 只校验 OpenSpec 验不到的“证据型”门禁 | 升级版 guard 脚本 | 读 `openspec status --json` + 证据文件 |
| **L3 Subagent 层**（多视角对抗 + 扫描） | 每阶段派角色扫描/审查，回传证据 | skill 编排 + 证据文件 | 证据文件 |

> 关键验证（已用 spike 实测）：OpenSpec 1.4.1 的 `schema fork/init --artifacts` 支持任意自定义 artifact id；`openspec status` 能原生跟踪自定义 artifact 的完成度并按 `requires` 做依赖门禁（`[-] test-contract (blocked by: design, specs)`）；`openspec instructions <自定义artifact>` 能下发我们写进 schema 的指令。因此 L1 完全用 OpenSpec 原生能力承载，无需平行状态机。

## 4. L1：自定义 schema 设计

`openspec/schemas/superspec/schema.yaml`，artifact 链（在原生 `proposal→specs→design→tasks` 上扩展）：

| # | artifact | generates | requires | 增强点（写进 instruction） |
|---|---|---|---|---|
| 1 | `proposal` | proposal.md | [] | Why/What/Capabilities/Impact + **现有实现与隐性合约注意点** |
| 2 | `specs` | specs/**/*.md | [proposal] | 需求 + 可测 `#### Scenario`（OpenSpec 原生校验） |
| 3 | `design` | design.md | [proposal, specs] | **设计完备性清单**（见 §5.1）+ 必须有 subagent 对抗审查证据 |
| 4 | `test-contract` | test-contract.md | [specs, design] | **测试覆盖矩阵**（见 §5.2）+ 红绿灯契约 + Iron Law |
| 5 | `tasks` | tasks.md | [specs, design, test-contract] | **串/并行组、读写范围、依赖、风险**标注 |
| 6 | `review` | review.md | [tasks] | 实现后**多视角独立 code review** + rollback target |
| 7 | `verification` | verification.md | [review] | **证据矩阵**（REQ→TASK→TEST→RED/GREEN）+ 最终对抗审查 |

`apply.tracks: tasks.md`（沿用原生 checkbox 进度跟踪）。

> 需求澄清（“考虑现有实现 + 对抗审查”）**默认不单独成 artifact**，而是落在 `proposal`/`specs` 的强制 instruction + L2 guard 的“现状调查证据”门禁上（决策点 D-2，可改为独立 `discovery` artifact）。

## 5. 质量硬清单

### 5.1 design 完备性清单（design 的 instruction 强制逐项覆盖）

接口契约 / 数据流与状态 / 事务与一致性 / 边界与并发 / 错误路径与回滚 / 兼容性（向后兼容、灰度）/ 可观测性（日志、指标）/ 安全与权限 / 性能影响。每项要么给出决策，要么显式标注“不涉及+理由”。

### 5.2 测试覆盖矩阵（test-contract 的 instruction 强制覆盖）

正常路径 / 边界值 / 异常与错误 / 幂等与重试 / 并发竞态 / 回归（行为保持）/ 契约（API、schema）。每个验收场景（来自 specs 的 `#### Scenario`）至少映射一个用例。

### 5.3 红绿灯契约

每个自动化用例声明 `expected_red`（预期失败原因）与 `expected_green`（预期通过结果）+ 执行命令；手工用例给出可观察证据。

## 6. L2：Guard 设计

guard 只负责 OpenSpec 校验覆盖不到的 **4 类“证据型”硬门禁**：

1. **红绿灯证据**：实现前存在 RED 且“因正确原因失败”；实现后 GREEN 通过；证据齐全。
2. **对抗审查证据**：design/review/verification 的审查确由 **subagent** 产出（execution_mode=subagent），非主线程自审。
3. **并行安全**：tasks 的并行组无写范围冲突。
4. **人审 gate**：关键阶段的人工确认是合法 JSON 记录（confirmed/confirmed_by/confirmed_at/confirmation_text）。

guard 的**输入是 `openspec status --json` + change 目录下的证据文件**；输出 `pass`/`block` + 原因。**guard 不写、不读任何 `current_phase`**——它信任 `openspec status` 作为阶段真相，只补“这一步的证据够不够”。

调用点：每个阶段 `check-enter`（前序证据门禁）/ `check-complete`（本阶段证据齐全）。沿用 `workflow` 已有的 rollback/invalidation/semantic_status/BLOCKER_DOMAINS 数据结构（这些已有测试覆盖，复用而非重写）。

> 强制力说明（诚实）：在 Codex CLI 下 skill/instruction 是建议性的。最强可达到的“硬强制”是：把“必须先跑 guard 且 PASS 才能进入下一 artifact”写进每个 artifact 的 instruction（`openspec instructions` 会下发）+ guard 在 `check-enter` 时校验前序证据不全即 `block`。要做到机械上完全无法跳过，需确认 Codex 是否支持 pre-tool/pre-artifact hook（见 §11 待验证）。

## 7. L3：Subagent 设计

### 7.1 每阶段统一“三段式”

1. **扫描/调查**：需要现有实现/依赖/约定等事实时，派 subagent 调查，回传带证据的报告（主线程不自己做实质调查作为门禁证据）。
2. **主线程编排**：主线程读证据，写/更新该 artifact 文件。
3. **对抗审查**：派 subagent 做对抗审查，产出 review 证据；guard 校验该证据存在且通过。

### 7.2 多视角角色矩阵

| 阶段 | 扫描/调查 | 对抗审查（多视角） |
|---|---|---|
| proposal/specs | `explore`（现有实现/隐性合约/风险点） | `critic`（需求歧义、边界、遗漏） |
| design | `explore`（架构约束） | **`architect` + `critic` + `test-engineer` 并行** |
| test-contract | `test-engineer`（测试框架/约定） | `critic`（覆盖矩阵是否完整） |
| tasks | `explore`（模块/依赖/触点） | `critic`（覆盖、依赖序、**并行写冲突**） |
| apply | `test-engineer`（选例/诊断） | 红绿灯纪律（§8） |
| review | — | **`code-reviewer` + `security-reviewer` 并行** + rollback |
| verification | `verifier`（证据矩阵） | `critic`（漂移/范围膨胀/遗漏） |

### 7.3 证据契约

证据文件含：`evidence_id`、`kind`（subagent_report/review/test_run/human_confirmation/...）、`ref`、`summary`、`created_at`、`execution_mode`（对抗审查/调查必须为 `subagent`）、`agent_role`。证据放 change 目录下证据子目录（§10），**不含状态字段**。

## 8. superpowers TDD 集成

`apply` 阶段强制五步循环，写进 schema 的 `apply.instruction` 与 apply skill：

1. **RED**：写一个最小失败测试。
2. **VERIFY RED**：运行，确认“因正确原因失败”；若意外通过则停止（功能已存在或测试写错）。
3. **GREEN**：写最小代码让其通过，不优化、不加功能、不顺手重构。
4. **VERIFY GREEN**：运行确认通过。
5. **REFACTOR**：仅在绿灯后清理（去重/改名/抽取），每次重构后重跑测试，失败即 revert。

**Iron Law**：没有正在失败的测试，不准写实现代码；违反则删除超前代码重来。
**anti-patterns 清单**：禁止过度 mock、模糊断言、模糊命名、测试实现细节而非行为等（作为 reference 随 skill 下发）。

## 9. 状态与证据模型（零平行状态机的落地）

- **阶段/进度真相**：`openspec status --json`（artifact `done/ready/blocked` + tasks checkbox）。
- **证据**：change 目录下证据子目录中的 JSON/Markdown/log，**只描述“发生了什么”，不描述“现在在哪一步”**。
- **人审**：合法 JSON gate 记录。
- 任何工具/skill 想知道“现在该干什么”，调用 `openspec status` / `openspec instructions`，不读私有状态文件。

## 10. 目录与文件布局

```text
docs/            # 规范源（本目录）
  DESIGN.md                        # 本文
  schema/schema.yaml               # schema 规范源
  schema/templates/*.md            # artifact 模板规范源
  guard/                           # guard 脚本规范源 + tests
  skills/superspec-*/                # skill 规范源
  references/                      # 完备性清单、覆盖矩阵、anti-patterns、证据契约
openspec/schemas/superspec/          # 安装到项目、被 openspec 直接使用
.codex/skills/superspec-*/           # 安装副本，供 Codex 加载
openspec/changes/<change>/         # 运行时
  proposal.md specs/ design.md test-contract.md tasks.md review.md verification.md
  .superspec/evidence/               # 证据（无状态字段）；红绿日志、subagent 报告、人审 gate
  .openspec.yaml                   # schema: SuperSpec
```

## 11. 迁移与收敛

- 以 `superspec` 为唯一规范源；`yourflow`、`workflow`、`ai-dev-workflow-toolkit` 标记为 deprecated 并在迁移完成后归档/删除。
- 保留：`yourflow` 的 Subagent Boundary 思想、`workflow` guard 的 rollback/invalidation/semantic_status schema 与测试。
- 丢弃：两套各自的 sidecar 状态机（`state.json.current_phase`、`gate-ledger` 的 stage）。
- 现有 change `openspec-delivery-extension` 当前用 `spec-driven` + `.yourflow/`，迁移策略单列（不强制回填）。

## 12. 决策点（默认已选，可改）

- **D-1 命名**：默认 `superspec`。
- **D-2 需求澄清形态**：默认不单独成 artifact（用 proposal/specs instruction + guard 现状调查门禁）；备选独立 `discovery` artifact。
- **D-3 证据目录**：默认 `.superspec/evidence/`（仅证据，无状态）。
- **D-4 guard 强制力**：默认 instruction 强制 + guard check-enter 证据门禁；若 Codex 支持 hook 则升级为机械强制。

## 13. 风险与待验证

- **R-1（关键）**：Codex CLI 是否支持 pre-artifact/pre-tool hook 以机械强制 guard。待调研。
- **R-2**：`openspec archive` 对含自定义 artifact 的 change 行为（是否只处理 specs delta、是否忽略额外 .md）。需用示例 change 实测。
- **R-3（历史表述，已由 SPEC.md v0.4 修正）**：guard 读 `openspec status --json` 的字段稳定性（schema 命令标注 experimental，可能变）。最终策略不是运行时锁版本，而是 status 字段 shape 校验 + golden fixture + 兼容层，版本号仅作诊断。

## 14. 实施路线图

1. 本设计文档评审定稿（当前）。
2. 落地 `openspec/schemas/superspec/`（schema + 模板），用示例 change 验证 status/instructions/archive（覆盖 R-2）。
3. 升级 guard：基于 `openspec status --json` + 证据门禁，移除平行状态机；复用 workflow guard 的 rollback/schema + 测试。
4. 编写 `superspec-*` skill（三段式 + subagent 矩阵 + 红绿灯纪律 + references）。
5. 收敛迁移旧三套。
6. 端到端跑通一个真实 change。
