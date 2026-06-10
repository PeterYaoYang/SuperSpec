# SuperSpec 审计修复总控计划 2026-06-10

> 用途：本文档是修复会话的**唯一入口**。按 Phase 顺序执行即可解决 2026-06-10 全面审计发现的全部可修复问题。
> 执行纪律：严格按 Phase 顺序；每个 Phase 末尾有验收；标注 ⏸ 的检查点必须用 AskUserQuestion 暂停等用户裁决，不得用默认值替代。

## 0. 背景与文档地图

SuperSpec（OpenSpec overlay 工作流：guard CLI + 5 skill + sidecar evidence）经全面审计发现 44 项问题，分布在三份文档：

| 文档 | 内容 | 在本计划中的角色 |
|---|---|---|
| `WORKFLOW_FULL_AUDIT_2026-06-10.md` | 全面审计：静态 23 项（A-1~G-3）+ 实证 8 项（H-1~H-8） | 问题清单与证据（file:line） |
| `REVIEW_DISCLOSURE_FIXED_POINT_REVIEW_2026-06-10.md` | disclosure 设计稿专项审查：13 项 + 轮次经济 R1-R5 | Phase 3 修订设计稿的权威依据 |
| `REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md` | disclosure 机制设计本体（**含已知缺陷，未经 Phase 3 修订不得实施**） | Phase 3 的修订对象、Phase 4 的实施依据 |
| `FIX_HANDOFF_2026-06-10.md` | 基础修复的逐项实施细节（FIX-1~13） | Phase 1/2 的操作手册 |
| `DISCLOSURE_IMPL_HANDOFF_2026-06-10.md` | disclosure 工作线的逐项实施细节（A1-A13、B1-B6） | Phase 3/4 的操作手册 |
| `SPEC.md` | 规范源 | 红线约束：v1 audit-only、不 fork OpenSpec schema、guard 唯一状态写入器、fail-closed |

代码：`scripts/superspec/`（TypeScript，`npm test`）。~~真实 change `refactor-vacation-duration-api` 的 `.superspec/` 是历史现场，**任何 Phase 都不得修改其 evidence 文件**。~~
> 2026-06-10 更新：该 change 的历史现场已由**用户有意清空**（测试用途，旧 evidence 无法适配新结构）。全局纪律 4 的"真实 change 回归"改为依赖测试 fixture 的 legacy grandfathered 用例；该 change 目录为空属预期。

## 全局纪律（适用所有 Phase）

1. 每项修复先写失败测试（block + allow 路径各至少一个），再改实现；`npm test` 始终全绿。
2. 新增 block reason code / evidence kind 同步更新 `SPEC.md` §6.5 判定矩阵与 §17 测试计划。
3. 每完成一项，在对应操作手册（FIX_HANDOFF / DISCLOSURE_IMPL_HANDOFF）勾选并注明改动文件。
4. 每个 Phase 结束后对真实 change 跑 `scripts/superspec_guard status --change refactor-vacation-duration-api` + 抽查 check 命令：若新检查产生无法修复的追溯 block，**停下报告**（这是 grandfathering 缺口），不得硬改历史 evidence。
5. 发现本计划与实际代码冲突时（审计可能有误判），以代码事实为准，记录偏差并继续。

---

## Phase 1：基础红线修复

按 `FIX_HANDOFF_2026-06-10.md` 第一批执行 **FIX-1 ~ FIX-5**：

1. FIX-1 state 损坏 fail-closed（`state_corrupt` block + 显式重建确认）
2. FIX-2 `design_complete` require `explore_complete`
3. FIX-3 `test_contract_honored` require `test_contract_drafted`
4. FIX-4 explore/design/test-contract 三处 stale blob 检查 + state 指纹纳入 discovery.md/design.md
5. FIX-5 computed_from 使用判定时指纹（消除"新指纹+旧判定"窗口）

**验收**：npm test 全绿 + 全局纪律 4 的真实 change 回归。

## Phase 2：机制收紧

按 `FIX_HANDOFF_2026-06-10.md` 第二批执行 **FIX-6 ~ FIX-13**：

supersede 授权（6）、kind 白名单 + human_confirmation schema（7）、四个人审阻塞点补 evidence（8）、prompt_ref/evidence_id 校验（9）、test_run 按运行建档（10）、propose 期 output_ref 查重 / review_scope 合同（11）、全局悬空引用检查（12）、50 个未测 reason code 补测（13）。

注意：FIX-11、FIX-12 是 Phase 4 的地基，不可跳过。

**验收**：同 Phase 1，另抽查审计 §7 F-1 高风险 reason code 清单已全部有测试。

## Phase 3：修订 disclosure 设计文档（纯文档，不写代码）

按 `DISCLOSURE_IMPL_HANDOFF_2026-06-10.md` Stage A 执行 **A1 ~ A13**，对 `REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md` 逐项修订。修订依据是审查文档的 13 项 finding + 轮次经济 R1-R5 + 实证 H-1/H-2。

完成后输出修订摘要（逐项对照 A1-A13 的勾选 + 关键改动点）。

**⏸ 检查点 CP-1**：暂停，等用户确认修订后的设计稿。未确认不得进入 Phase 4。

## Phase 4：实施 disclosure Phase 1（仅 `explore_complete`）

按 `DISCLOSURE_IMPL_HANDOFF_2026-06-10.md` Stage B 执行 **B1 ~ B6**：三种新 evidence kind 的 schema、target map 与集合 stale、finding ledger + `review_disclosure_complete` guard、`superspec-explore` skill 的 digest/checkpoint/rerun 流程、Phase 1 全部测试、真实 change grandfathering 验证。

范围红线：只做 `explore_complete`；Phase 2-5（proposal/design/invariants/tasks/final review/backfill）不做；v2 可信通道只留文档预留。

**验收**：设计稿 Phase 1 测试清单 + 审查文档新增测试项全部落地；真实 change 无追溯 block。

## Phase 5：决策项落地

以下 6 项是产品决策，逐项用 **⏸ AskUserQuestion** 向用户呈现（带推荐选项与代价说明），按用户选择实施或搁置：

| # | 决策项 | 出处 | 推荐 |
|---|---|---|---|
| D1 | `.superspec/` git 跟踪策略：ledger/evidence/manifest 入库 vs gate-allow 自动快照 vs 维持现状 | H-3（最高优先） | ledger + evidence JSON + manifest 入库，reports/raw 走 gitignore + sha 引用 |
| D2 | preset 语义：实现 hotfix/tweak 的 gate 精简 vs SPEC 降级承诺为 full-only | E-1 | 先 SPEC 降级（诚实），gate 精简另立设计 |
| D3 | archive manifest 外部锚点（与 D1 同域） | D-2 | 随 D1 一并解决 |
| D4 | 安装引擎：manifest-driven init/update/uninstall + check-init 纳入 superspec-* skill 健康检查 | G-1/G-2 | 实施（工作量中等，独立性好） |
| D5 | 真实 OpenSpec CLI 冒烟测试（opt-in CI job） | F-4 | 实施（小） |
| D6 | route 进度语义：`max_route_reached` 派生字段 vs 文档降级 | H-7 | 文档降级（小） |

**验收**：每项有用户裁决记录（采纳/搁置 + 理由），采纳项实施并测试。

> **用户裁决记录 2026-06-10**：
>
> | # | 裁决 | 理由 |
> |---|---|---|
> | D1 | **交给最终用户选择**（不在 v1 强制实施） | SuperSpec 尚未拆分为独立工程，最终形态是类 openspec 的通用工具；`.superspec/` 是否入宿主仓库的 git 应由使用该工具的用户自行决定。文档中声明默认 untracked + 风险提示 + 推荐配置即可 |
> | D2 | **采纳 a**：SPEC 降级承诺为 full-only，gate 精简另立设计 | 诚实优先，纯文档改动 |
> | D3 | **同 D1**：交给最终用户选择 | 与 D1 同域 |
> | D4 | **采纳 a**：manifest-driven init/update/uninstall + check-init 纳入 superspec-* skill 健康检查 | 工作量中等、独立性好 |
> | D5 | **采纳 a**：opt-in 真实 openspec CLI 冒烟测试 | 工作量小 |
> | D6 | **采纳 a**：文档降级，SPEC 明确 route 无进度语义 | 纯文档，最小成本 |
>
> **实施记录 2026-06-10**：
> - D1/D3 ✅ 文档落地：SPEC §5.1 增"`.superspec/` git 跟踪策略"段（默认 untracked + 风险声明 + 推荐配置 + 交给使用方选择）；DISTRIBUTION §10 记拍板（init 未来提供 .gitignore 选择项）。
> - D2 ✅ SPEC §13 增 v1 实然声明：gate 面板 full-only，hotfix/tweak 仅触发升级闸门，精简语义为未来设计目标。
> - D4 ✅ `src/install_engine.ts`（manifest-driven install/update/uninstall，manifest 写 `.codex/superspec/install-manifest.json`，sha256 基线保护用户改动）；`superspec_init` 增 `--update/--uninstall/--dry-run/--force`；`project_init` 接入引擎；`check-init` 增 superspec-* skill 健康检查（`superspec_init_missing`/`superspec_skill_invalid`）；`tests/test_install_engine.test.ts` 11 用例 + check-init 2 用例；SPEC §5.1/§6.5/§17、DISTRIBUTION §11 同步。
> - D5 ✅ `tests/test_real_openspec_smoke.test.ts`（4 用例，`SUPERSPEC_REAL_OPENSPEC_SMOKE=1` 激活，默认 skip；本机对真实 openspec 1.4.1 全绿）；CI 增 `real-openspec-smoke` job（workflow_dispatch + 每周一 schedule，可指定 openspec 版本）；SPEC §17 同步。
> - D6 ✅ SPEC §5.3 增"route 无进度语义"铁律（禁止当恢复书签/进度指针；恢复进度的唯一方式是重跑 check），§3 架构图同步措辞。

---

## 完成定义

全部 Phase 完成后，以下问题集得到解决：

- 审计 31 项中除"明确归 v2"外的全部（A-1~H-7 的可修项）；
- disclosure 痛点（子代理待确认内容必须原文披露用户、裁决结构化记录、历史 blocker 不可抹）已在 propose 期六个 gate 落地（disclosure Phase 1-3：explore/proposal/design 强制或激活式 + invariants/test-contract/tasks 激活式，见 `DISCLOSURE_IMPL_HANDOFF_2026-06-10.md`）；disclosure Phase 4（final review/`main_adjudication` 接入）与 Phase 5（backfill/grandfathering 工具）留待另立计划；
- 三份审计文档中标注的修复项可逐一回溯勾销。

**已知不解决（设计性接受，勿尝试）**：evidence 伪造防御、subagent 真实性验证、测试 exit code 验真、动作-allow 时序绑定——全部属于 v2 hook（前置 R-1 spike），SPEC §6.6 已声明 v1 天花板。
