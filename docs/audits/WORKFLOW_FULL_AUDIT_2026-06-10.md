# SuperSpec 工作流全面审计 2026-06-10

> 状态：Audit findings / 2026-06-10
> 审计范围：SPEC.md v0.4 全文、`scripts/superspec/src/*`（gates/evidence/state/core/openspec/tasks/invariants/archive/git/paths/util/workflow_loop/project_init）、5 个 skill 模板与已安装副本、`scripts/superspec/tests/*`、分发层（adapters/schemas/README/DISTRIBUTION.md）、既有 7 篇审计/设计文档；另含**实证审计**：真实 change `refactor-vacation-duration-api` 的完整 `.superspec/` 轨迹（76 条 ledger、200+ evidence/raw 文件、state、reports）。
> 审计方法：主线程精读 SPEC.md 与关键代码段 + 4 个并行 subagent 全文扫描（状态机拓扑 / evidence 校验 / skill 合同与分发 / 测试覆盖），关键发现经主线程抽查代码核实；实证部分由主线程直接解析 ledger 时间线、比对 evidence blob 指纹与当前文件、抽查证据原文。SPEC 只代表"应然"，§9 实证部分专门记录"实然"与应然的偏差。
> 关联文档：`docs/audits/REVIEW_DISCLOSURE_FIXED_POINT_REVIEW_2026-06-10.md`（针对 review disclosure 设计稿的专项审查，其 P0/P1 发现此处不重复展开，仅交叉引用）。

## 0. 总评

SuperSpec 的架构判断是成熟的：overlay 不替换 OpenSpec、guard 唯一状态写入器、受控状态 + 指纹对账、v1 诚实定位为 audit-only discipline layer（SPEC §6.6 的"伪造闭环"自我声明是同类系统中少见的清醒）。历史审计（GUARD_PROOF_GAPS / REVIEW_FINDINGS / HARDENING_234）的大部分发现已修复进基线，工程纪律良好。

但本次全面审计仍发现了一批**新问题**，集中在四个方面：

1. **gate 前置链有真实断点**——部分 gate 可以跳过前序 gate 直接通过，违背 SPEC 自己承诺的流程拓扑（§2）。
2. **freshness/blob 检查覆盖严重不均**——`invariants_reviewed` 有 stale 检查，而 explore/design/test-contract 的 role evidence 不绑定被审 artifact 的当前内容（§4）。
3. **声明为红线的 fail-closed 存在 fail-open 缺口**——损坏的 state 文件被静默当作"无状态"重建（§5）。
4. **guard 的测试覆盖与其产品地位不匹配**——105 个 block reason code 中 50 个从未在测试中出现；guard 本身就是这个产品的核心交付物（§7）。
5. **实证轨迹证明退化已经发生**——真实 change 的 ledger/evidence 显示：一次 omnibus "refresh" 审查被扇出为四个 gate 的证据、7 个 task_complete 在 30 秒内批量补票、整个 `.superspec/` 不进 git（§9）。这些不是理论风险，是已经跑出来的事实。

按 v1 自己声明的威胁模型评级：v1 防的是"合作但易出错/无意识跳步的 agent"，不防恶意伪造（那是 v2 hook 的事）。因此本审计的严重度以**"合作 agent 也会无意中踩到/绕过"**为 P0/P1 主判据；纯恶意伪造类问题除非有低成本加价手段，否则归入信任模型层（§6）单独陈述，不计入流程缺陷。

严重度定义：

- P0：违背 SPEC 自我承诺的红线（fail-closed、前置链、唯一写入器），且合作 agent 正常使用即可能触发。
- P1：流程把控失效或机检退化为约定，实际使用中会发生。
- P2：实现/语义缺口，特定场景暴露。
- P3：工程债、待实现项、长期风险。

---

## 1. 工作流全景（审计基线）

```text
用户可见：project init -> explore -> propose -> apply -> review -> archive
propose 内部（SPEC 声明链）：explore_complete -> design_complete -> invariants_reviewed
  -> test_contract_drafted -> tasks_complete -> propose_complete
apply：check-apply-ready -> 每 task: check-task-edit -> RED -> 实现 -> GREEN -> check-task-complete
review：check-review-ready -> 3x source_guidance -> verification_review + final_test -> main_adjudication -> check-review-complete
archive：check-archive-ready(锁内事务) -> openspec archive -y -> check-archived
```

强制力分层：L1 OpenSpec CLI 事实（硬）；L2/L3 guard 结构判定（audit-only）；skill 文本纪律（无兜底）；L4 hook（v2，未实现）。

---

## 2. 流程拓扑层（gate 前置链）

### A-1 [P0] `design_complete` 不 require `explore_complete`，前置链断裂

`check-enter --gate design_complete` 只检查 OpenSpec design done + 三角色 evidence + human confirmation（`gates.ts:526-531`），没有任何 `explore_complete` 前置检查。一个忘记跑 explore 的合作 agent 可以直接从 design 起步并一路推进到 `propose_complete`——后者虽然汇总检查五个 subgate（`gates.ts:628-634`），但 explore 是在 design/invariants/test-contract 全部完成**之后**才被补查的，此时 discovery 对设计的约束作用已经为零，只剩"补一份事后 discovery"的形式合规。

SPEC §5.3 路由表明确写"`propose` 要求 `explore_complete` before editing OpenSpec planning artifacts"，实现没有兑现这个时序语义。

**修复**：`design_complete` 直接 require `explore_complete`。注意这与 REVIEW_DISCLOSURE_FIXED_POINT 设计稿中"每个内部 gate 的 direct entry 都必须执行同一前置链"的要求一致，可一并落地。

### A-2 [P1] `test_contract_honored` 是 SPEC 主链之外的隐藏 gate，且自身无前置

实际链是 `tasks_complete -> test_contract_honored`（`gates.ts:617-623`），而非 SPEC 声明的 `tasks_complete -> test_contract_drafted`；`test_contract_honored` 自身不 require `test_contract_drafted`/`invariants_reviewed`（`gates.ts:589-617`）。SPEC §6.5 的 internal gate 表里有它，但 §5.3 兼容性说明的 gate 名单里没有它的位置说明，"显式链"与"实际链"不一致。后果：tasks 阶段的兑现校验可以在 test-contract 从未经过 drafted 审查的情况下通过（只要表格结构碰巧匹配）。

**修复**：`test_contract_honored` require `test_contract_drafted`；SPEC 主链补全该 gate 的拓扑位置。

### A-3 [P1] 同一语义的两条入口路径前置拓扑不一致

`check-artifact --artifact design` 经 `ARTIFACT_ENTER_GATE` 把 proposal/specs/design 都映射到 `explore_complete`（`util.ts:148-153`，`gates.ts:652-656`），即"想写 design 必须先过 explore"；但 `check-enter --gate design_complete` 不检查 explore（A-1）。两条路径对"design 周边状态"的前置要求互相矛盾——走哪条入口决定了 explore 是否必需。skill 文本恰好都引导走正确的入口，所以这个洞当前被纪律掩盖着。

### A-4 [P2] `GATE_ROUTE` 声明了 `check_superspec_gate` 不实现的 gate

`GATE_ROUTE` 含 `review_complete` / `verify_complete` / `archive_ready`（`util.ts:197-200`），但 `check_superspec_gate()` 没有这些分支，`check-enter --gate review_complete` 会返回 `unknown_gate`（`gates.ts:635-636`）。实际必须走专用命令。不是安全洞（fail-closed 方向），但属于接口表与实现的漂移，会让上层调用方（skill/workflow_loop/未来 hook）按表编程时踩坑。

### A-5 [P2] human_confirmation 覆盖与人审阻塞点清单不对齐

SPEC §14 列了 7 个必须 AskUserQuestion 的人审阻塞点，但 guard 侧有 `human_confirmation` evidence 要求的只有 `design_complete`、`invariants_reviewed`（条件性）、`archive_ready`、preset 升级（`gates.ts:531,554-562,1421-1423`；`core.ts:195-198`）。apply 前的隔离方式选择、verify 失败处置、范围膨胀处置完全没有 evidence 锚点——连"自报告的确认"都不留痕。在 audit-only 模型下，留痕是底线能力，这三个点连审计都审不了。

### A-6 [P3] `check-verify-ready` 命名误导

名字像 ready 检查，实际执行 `check_review_complete()` 完整契约（`core.ts:237-239`，`gates.ts:1403-1405`）。SPEC 已声明它是兼容别名，但返回的 gate 名是 `review_complete`，调用方若按名字理解语义会误判。建议输出中加 alias 提示字段。

---

## 3. 路由与状态层

### B-1 [P2] `effective_route_phase` 的 allow 直通依赖"判定正确"的前提

allow 时直接返回 requested route，不与 floor 比较（`openspec.ts:126-133`）。经核对这与 SPEC §5.3 口径一致（"review/archive 作为有效路由只在对应 gate allow 后写入"），语义本身成立；但它把"route 不上调"的不变量完全寄托在 gate 判定正确上——结合 A-1/A-3 这类前置链洞，一次错误 allow 会被固化为 state 中的前进路由。前置链修复后此项自动收敛，单独不需修，但提示了**route 不变量缺少独立断言**：写 state 前可加一道 `requested <= floor + 1` 的防御性检查。

### B-2 [P0] 损坏的 state 文件被静默吞掉，违背 fail-closed 红线

`load_state()` 对 JSON 解析失败 catch 后返回 `null`（`state.ts:40-48`），`state_stale_reasons()` 对 `null` 直接返回空（`state.ts:71-73`），后续流程把它当"首次运行"重建。SPEC §5.3 铁律 ⑥ 说"删除 state 后可完整重建"——但**删除是显式操作，损坏不是**。损坏意味着发生过非预期写入（并发踩踏、崩溃截断、手工编辑），按 §6.4 fail-closed 总则应当 block + 大声报告，而不是静默重建把事故现场抹掉。ledger 同样存在此问题（`read_ledger_text` 对缺失返回空字符串，不区分"从未有"与"被清空"）。

**修复**：state 文件存在但解析失败 → block `state_corrupt`，要求显式 `recompute --force` 类操作确认重建；重建事件写入 ledger。

### B-3 [P2] 普通 check 的 TOCTOU 窗口（SPEC 已自认，但低估了一处）

SPEC §5.4 承认只有 `check-archive-ready` 在锁内重读重判。实测代码中普通路径锁内做了一次 fingerprint 比较后，`prepare_recomputed_state_write` 又重新计算指纹写入（`core.ts:136-159`，`state.ts:301-321`）——存在"判定时输入 ≠ 写入时 computed_from"的窗口：写出的 state 可能是"新指纹 + 旧判定"的组合，下次 stale 检查会因指纹已是新值而**不再报 stale**。这比 SPEC 自认的"没有锁内重判"更糟一档：不是少一道保护，而是会主动洗掉 stale 信号。

**修复**：写入的 `computed_from` 必须用判定时刻的指纹，不重算；或重算后若与判定时不一致则强制改写 decision 为 block（现有逻辑只在锁内第一次比较做了这件事，第二次重算没做）。

### B-4 [P2] 库 API 边界过宽，"唯一状态写入器"只对 CLI 成立

`core.ts:9` 整体 `export * from "./state.ts"`，`write_state_atomic` / `append_ledger` / `recompute_and_write_state*` 全部对库调用方可见；底层 `check_*` 也接受外部传入的 `status/evidences`（`gates.ts:516`）。CLI 路径上 caller 注入已被正确防御（dispatch 不读外部 status），但任何把 guard 当库引的代码（如未来 hook adapter、workflow_loop 演化）都可以绕过判定直接写 state。建议收紧导出面，写 API 只暴露给 dispatch 内部。

---

## 4. Evidence / Freshness 层

### C-1 [P1] role evidence 的 stale 检查覆盖严重不均——同类 gate 三种待遇

- `invariants_reviewed`：显式要求 evidence target 当前 `business-invariants.md` blob（`gates.ts:545-552`）✅
- `explore_complete`：critic evidence 不要求 target 当前 `discovery.md`——审的是哪个版本的 discovery 无人知晓（`gates.ts:520-525`）❌
- `design_complete`：三角色 evidence 不要求 target 当前 `design.md`，target 任意合法文件即可过 schema（`gates.ts:526-531`）❌
- `test_contract_drafted`：reviewer evidence 不绑定当前 `test-contract.md`（`gates.ts:583-588`）❌

后果：design 评审通过后再改 design.md，gate 依然 allow——这正是 SPEC §5.5 blob_sha 机制声称要防的 `stale_review` 场景，但机制只在 invariants 一处接通了。这是本次审计中**性价比最高的修复项**：模式已存在，照抄三遍。

同根问题：state 指纹覆盖 tasks/invariants/test-contract/evidence/config，但不覆盖 `discovery.md` 和 `design.md` 内容（`state.ts:57-68`），这两个文件改动连 `state_fingerprint_stale` 都不触发。

### C-2 [P1] supersede 无授权模型，是回滚机制也是无门槛的证据移除器

任意一条 `status:"superseded"` + `supersedes:<id>` 的 evidence 即可把任意 pass evidence 移出 live 集合：无作者检查、无 kind/gate 匹配、无目标存在性检查（`evidence.ts:647-653`）。它是 SPEC §5.5 设计的回滚机制，但在合作模型下也完全可能被**误用**：agent 想回滚 task A 的 GREEN，手滑写错 evidence_id 就静默灭掉了 review 的 source_guidance——而且没有任何 gate 会报告"某证据被 supersede"这件事本身。

另有不一致：`pass_task_reopens()` 用 `find_pass()` 而非 `live_pass()`（`evidence.ts:610`），superseded 的 task_reopen 仍参与 reopen 生命周期检查——同一个"死"概念在两处语义不同。

**修复**：supersede 至少要求 ① 目标 evidence_id 存在，② 同 gate 或显式 `supersede_reason`，③ ledger 记录 supersede 事件；统一 find_pass/live_pass 的使用规则。

### C-3 [P1] `kind` 不是枚举 + 关键 evidence 无专用 schema

通用 schema 只查 8 个字段存在性，`kind` 任意字符串可过（`evidence.ts:301-305`）。`human_confirmation` 完全没有专用 schema——design/archive 的人审证据只要 kind 字符串对、status pass 即可（`gates.ts:531,1421`），不要求 confirmation_text、确认范围、被确认的内容引用（`branch_handling` 的 confirmed_paths 是唯一例外）。`test_run`/`alternative_verification`/`manual_verification` 同样无 schema。打错 kind 字符串的 evidence 会被静默忽略而非报错，合作 agent 的笔误直接表现为"莫名其妙的 missing evidence"。

**修复**：kind 白名单 + 未知 kind 报 `evidence_unknown_kind`；`human_confirmation` 补最小 schema（confirmation_text + confirmed_refs + gate 匹配）。

### C-4 [P2] `prompt_ref` 不查存在、`evidence_id` 不查唯一

`prompt_ref` 是角色 evidence 必填字段但只查字段存在，不查文件存在/非空（对比 `output_ref` 有可读非空检查，`evidence.ts:205`）。`evidence_id` 无全局唯一性检查，重复 ID 会让 refs/supersede/Map 查找产生不可预期行为（后写覆盖）。

### C-5 [P2] RED/GREEN 的 `semantic_status` 纯自报，连结构性约束都没有

`test_run` 无专用 schema，RED/GREEN 判定完全依赖自报的 `semantic_status` 字段（`tasks.ts:185`，`gates.ts:1090,1142`），不要求 `output_ref`、不解析输出、无 expected_red 比对。"RED 意外通过则停止"（Iron Law 第 2 步）在 guard 侧零落地——SPEC §17 测试计划里写了"RED 意外通过→block"，实现和测试都没有。v1 不能验真实 exit code 可以接受，但至少应要求 test_run 携带 output_ref 并校验非空，给 v2 hook 留好升级面，同时让伪造需要多编一个文件。

### C-6 [P2] Markdown 解析器对"结构碰巧匹配"过于宽容

test-contract 表格解析按 `|` 直接 split、不处理转义、重复 TEST-ID 静默去重、scenario 覆盖判定是 substring includes（`tasks.ts:50-135`）；tasks.md 属性重复时后写覆盖、attr key 只认 `\w+`（`tasks.ts:8-20`）。畸形输入不报错而是产生意外语义。WORKFLOW_AUDIT 已提过 Markdown DSL 脆弱性，此处确认仍未修，且补充：**重复 ID 静默去重**会让"两行同 ID 不同内容"的矛盾表格通过校验。

### C-7 [P2] root 语义混用持续存在

`source_guidance.target_refs` 按 repo root 解析，其他 role evidence 按 change root（`evidence.ts:325`）；`invariants_reviewed` 硬编码期望 change-root 路径（`gates.ts:545`）。规则本身有文档，但实现里是按 kind 分支的特判，每加一种 evidence 就要重新决定一次 root——这是 REVIEW_DISCLOSURE 设计稿 P1-3 根语义冲突的现存土壤。建议在 pinned_ref 结构里显式带 `root: "repo"|"change"` 字段，消灭隐式约定。

---

## 5. 信任模型层（v1 声明 vs 实现的诚实度）

SPEC §6.6 已诚实声明所有 evidence 可伪造，本节不重复"可伪造"类问题，只列**声明与实现不一致**或**有低成本加价手段未做**的项。

### D-1 [P2] SELF_REVIEW_MARKERS 黑名单是逐字匹配，防的是"诚实地标错"，挡不住变体

黑名单 exact-match `main`/`main-thread`/`current-agent` 等（`util.ts:215`，`evidence.ts:317-318`）。在合作模型下它防的是 agent 诚实填写时的角色混淆，这个目的达到了；但文档若宣称它"防主线程自审"则言过其实——`orchestrator` 一个词就绕过。建议在 SPEC §6.5 把该检查的真实强度标注为"标签纪律检查"，与 `trust:self_reported` 同级。

### D-2 [P2] archive preservation manifest 无外部锚点，归档后可同步篡改

check-archived 信任归档目录内的 manifest，文件与 manifest 一起改即可通过；primary manifest 存在时 fallback bundle 不参与校验（`archive.ts:347-378`）。归档是终态操作，恰恰是最值得上外部锚点的地方：archive 前把 manifest sha 写入一条 git commit（或至少写入项目级 `.superspec/` 而非随迁目录），check-archived 双向比对。成本低，把"篡改归档"从改两个文件升格为改 git 历史。

### D-3 [P2] 引用完整性与历史完整性无任何检查

evidence 间的 `*_refs` 指向不存在的 evidence_id 时，多数路径静默忽略而非 block（review_complete 的 source/verification refs 是例外，有 unknown ref 检查）。删除 evidence 文件不触发任何告警——`evidence_fingerprint` 会变，但只表现为一次 `state_fingerprint_stale`，recompute 后即恢复 clean。这与 REVIEW_DISCLOSURE_REVIEW 文档 P0-1 的"删除式洗白"同根；那边给出的修复（全局悬空引用检查 + ledger 记录 evidence 文件集合变化）应该作为 guard 通用能力落地，不只服务于 disclosure 机制。

---

## 6. Skill 合同层（纪律真空清单）

guard 管不到、纯靠 skill 文本约束的步骤（按风险排序）：

| # | 纪律真空 | 所在 skill | 后果 | v1 可加价手段 |
|---|---|---|---|---|
| 1 | `openspec instructions` 委托——是否真调用、产物是否按 template 写 | propose / apply | 徒手编 artifact 丢失模板/规则/上下文对齐 | 要求把 instructions 输出存为 evidence ref（自报告但留痕可审计） |
| 2 | AskUserQuestion 七处人审阻塞点中四处无 evidence 锚点 | propose / apply / review / archive | 跳过人审不留痕 | 见 A-5：全部阻塞点要求 human_confirmation evidence |
| 3 | subagent 真实运行（三段式委托） | 全部 | 自报告契约，SPEC 已声明 v2 解决 | prompt_ref 存在性校验（C-4）+ output_ref 内容最小结构 |
| 4 | allow 之后才动手的时序（check-task-edit allow 与实际编辑之间） | apply | 快照 allow 不绑定动作 | v1 无解，v2 hook；可在 task_complete 时比对 write_scope 实际 diff |
| 5 | 测试命令真实执行与 exit code | apply / review | RED/GREEN/final_test 自报 | C-5：强制 output_ref |
| 6 | explore 阶段"只调查不实现、不写 planning artifacts" | explore | 越权写实现 | review_ready 的 dirty 检查部分兜底；可在 explore 期 check 增加 worktree dirty 报告 |
| 7 | 跨 skill 的 `<change>` 交接靠口头 | 全部 | 接错 change 或丢上下文 | state 中已有 change_id，skill 可要求先 `status` 确认 |

定性：1/2/5 有低成本留痕手段而未做，是 v1 内应修的；3/4 受 v1 天花板限制，维持诚实声明即可。

### E-1 [P1] preset 分级是"纸面功能"

SPEC §13 承诺 hotfix/tweak 可精简前置面板；实现里 guard 只做"非 full 且变更过大→要求升级确认"（`archive.ts:439`，`core.ts:195`），**不放宽任何 gate**；5 个 skill 也没有 preset 操作路径。当前真实状态是 full-only。这不是安全问题，而是产品承诺落空——轻量变更走全流程的成本会直接打击采用意愿（参见 REVIEW_DISCLOSURE_REVIEW §4 的 process fatigue 风险：成本逼出来的绕过比恶意更常见）。要么实现 preset 的 gate 精简，要么 SPEC 降级该承诺。

### E-2 [P2] workflow_loop 的阶段模型与主流程漂移

`workflow_loop.ts` 用的还是 `propose_design/red_gate/green_gate/verify` 等旧 stage 分类，不共享 guard state、不调 dispatch（`workflow_loop.ts:5,481,817`）。作为模拟测试工具存在合理，但其阶段口径与 5-skill 主流程已脱节，长期会反向误导（用错误的流程模型测纪律）。建议对齐或显式标注为 legacy taxonomy。

---

## 7. 测试层

### F-1 [P1] 105 个 block reason code 中 50 个从未在任何测试出现

guard 是这个产品的核心交付物，半数判定分支无测试。未覆盖清单中风险最高的一档：`evidence_unparsable`、`evidence_forbidden_field`、`evidence_change_mismatch`、`evidence_bad_status`（evidence schema 防线全裸奔）、`unknown_gate`、`unexpected_openspec_artifacts`、`custom_superspec_schema_present`（init 防线）、`invalid_no_tdd_reason`、`invalid_tdd_mode`、`missing_characterization`（TDD 枚举防线）、`test_contract_not_honored`（SPEC 点名的核心 gate）、`verification_role_invalid`、`finding_adjudication_invalid`（review 防线）。完整 50 项清单见测试扫描报告，建议直接转为补测 backlog。

### F-2 [P1] allow path 的 fixture 单一化

几乎所有 allow 测试由同一组 helper（`prepareProposeComplete`/`reviewGuidanceEvidences`/`mainAdjudication`）生成，结构高度同构：单 task、单 spec、单 invariant 的世界。多 task 并行组、多 spec 文件（联动 C-1/glob 集合问题）、多 invariant 交叉映射等组合形态是结构性盲区。

### F-3 [P2] SPEC §17 承诺但未兑现的测试

对照后未兑现项：caller 伪造 status 被忽略的显式测试、ledger 含 current_stage→block、非 guard 写 state→block、篡改 active_gate 不能绕过、RED 意外通过→block、真实 OpenSpec CLI 的 E2E（当前全部 mock `openspec_validate`，status 用 golden JSON）。其中"RED 意外通过"实现本身就没有（C-5），属于规范-实现-测试三层一起缺。

### F-4 [P3] 测试不跑真实 openspec CLI

全部 stub。R-3（status 字段稳定性）声称靠 golden fixture + 兼容层兜底，但 golden 只有 1.4.1 一份，OpenSpec 升级时的漂移检测实际上不存在。建议 CI 中加一个 opt-in 的真实 CLI 冒烟 job。

---

## 8. 分发/安装层

### G-1 [P2] 安装引擎是设计稿，`project_init` 不安装 SuperSpec 自己的 skill

install-map/manifest schema/DISTRIBUTION.md 齐备，但 `project_init.ts` 只装 OpenSpec skills 和 role surfaces，不消费 install-map、不写 install-manifest、无 update/uninstall（`project_init.ts:104-164`，README 自认"下一步"）。当前 5 个已安装 skill 与模板字节一致纯属手工维护的结果。

### G-2 [P2] `check-init` 不检查 `superspec-*` skill 自身

init gate 检查 OpenSpec native skills、role agent/prompt，但不查 `.codex/skills/superspec-*` 是否存在/完好（`gates.ts:410-492`）。用户可见 skill 被删/改后 guard 全程无感——工作流的"入口面"不在工作流自己的健康检查范围内。

### G-3 [P3] role prompt 双轨 + wrapper 硬编码路径

`project_init` 生成 generic stub，adapter 里另有 canonical TOML/prompt map，guard 只查 name/非空不查内容来源（`project_init.ts:62-83`，`gates.ts:433`）——角色 prompt 被替换成空话也不会被发现，联动削弱 D-1。wrapper 硬编码 `scripts/superspec/superspec_guard.ts` 路径，与 npm 分发目标冲突（DISTRIBUTION.md 自认）。

---

## 9. 实证审计：`refactor-vacation-duration-api` 真实轨迹

> 数据源：该 change 的 `.superspec/ledger.jsonl`（76 条）、`superspec-state.json`、~170 个 RED/GREEN evidence、各 gate role evidence、`reports/` 原文、raw 日志。以下每条均为实际文件中可复核的事实，非推断。

### H-1 [P1] 一次 omnibus "refresh" 审查被扇出为四个 gate 的证据——"旧痛点"的新变体已实际发生

时间线：design/invariants 等 gate 在 08:15-08:51 间先后 allow；随后 artifact 继续修改触发 stale（09:31、09:46 两次 `recompute block`）；09:51-09:58 间出现一批 created_at **完全相同**（09:51:33Z）的新 evidence；09:58-09:59 内 11 个 gate 连环重跑全部 allow。

关键事实：`EV-explore-complete-critic.json`（gate `explore_complete`）、`EV-invariants-reviewed-critic-v2.json`（gate `invariants_reviewed`）、`EV-test-contract-drafted-critic.json`（gate `test_contract_drafted`）、design 的 critic 证据——**四个 gate 的证据 `output_ref` 全部指向同一份 `reports/refresh-critic-review.md`**，prompt 也是同一份。refresh prompt 原文确认是一次性审查："Review current discovery, proposal, design, spec, business invariants and test contract..."。

定性：这是合作 agent 的诚实行为（确实重跑了 subagent，blob 也都重新钉住了当前文件），guard 全部放行，因为逐 gate 看每份证据都合规。但它实质上把"逐 gate 独立审查"压缩成了"一次 omnibus 复核盖四个章"——审查粒度静默退化。guard 的 output_ref 查重只在 `review_complete` 实现（`gates.ts:1276`），propose 期各 gate 不查。这同时是 REVIEW_DISCLOSURE 设计稿前提的实证（artifact 改动后 rerun-to-pass 是真实工作模式），也是该设计稿没覆盖的新洞：**round 的"审查范围合同"不存在，一个 round 可以无限复用**。

**修复**：propose 期 role evidence 增加 per-gate output_ref 查重；或显式允许 omnibus review 但要求 evidence 声明 `review_scope[]` 且 guard 校验 scope 覆盖该 gate 的 target map——二选一，不能维持现状的模糊。

### H-2 [P1] gate 实际是"事后批量补票"，不是流程中的控制点

ledger 显示：5 个 `task_edit` allow 分布在 08:59-09:04；之后 13 分钟无 gate 活动（实现期）；然后 **7 个 `task_complete` 在 09:20:10-09:20:40 的 30 秒内连续 allow**。skill 规定的 per-task `check-task-edit -> RED -> 实现 -> GREEN -> check-task-complete` 交错循环没有发生——实际模式是：批量开闸、集中干活、批量验票。同样地，refresh 后 09:58-09:59 的 11 连 allow 也是补票式重跑。

定性：guard 不要求交错时序（v1 也无法要求），所以这不违规；但它实证了 audit-only 模型的真实运行形态——**gate 是存档动作，不是决策点**。所有依赖"gate 时刻 = 决策时刻"的设计假设（如人审阻塞点应发生在动作前）在实践中都要打折扣。v2 hook 的价值排序应据此调整：动作-时序绑定的优先级高于证据防伪。

### H-3 [P1] 整个 `.superspec/` 不进 git——"append-only ledger"是一个 untracked 文件

`git ls-files` 确认该 change 的 `.superspec/` 下 **0 个文件被 git 跟踪**。evidence、ledger、state、reports、raw 全部是工作区裸文件。后果：

- append-only 语义没有任何载体：`git clean -fd` 或一次误删，全部历史无痕消失，连"曾经存在过"都无法证明；
- REVIEW_DISCLOSURE_REVIEW 文档 P0-1 的"删除式洗白"在此实证为默认状态——不是"可以删"，是"git 根本不知道它存在过"；
- archive preservation 机制（manifest 随目录迁移）建立在 untracked 文件能活到归档那天的假设上；
- raw/ 里还有编译产物（`.class` 二进制、classpath 文件）混在证据目录中。

**修复（需用户拍板）**：至少 ledger + evidence JSON + manifest 应进 git（reports/raw 可 gitignore + 在 evidence 中存 sha）；或每个 gate allow 时自动 commit `.superspec/` 快照到专用分支。不解决这条，v1 的"可审计"承诺只在文件碰巧没丢时成立。

### H-4 [P2] per-test 证据粒度是假的：29 份 GREEN 证据共享同一份 junit 日志

GREEN evidence 无 `output_ref` 字段（确证 C-5），只有 `raw_log_refs` 指向共享日志——**29 个 TEST 的"独立"GREEN 证据全部指向同一份 `raw/isolated-junit-green/junit-all.log`**：实际是一次跑批的机械扇出。`semantic_status` 全靠自报，guard 不解析日志、不比对 test_id 是否真在该日志中出现。per-test 粒度在 schema 层是 170 份 JSON，在事实层是 2-3 次测试运行。另：`raw_log_refs` 用了 repo-root 前缀路径，与普通 refs 的 change-root 约定再次混用（C-7 实证）。

**修复**：test_run 证据按"运行"建档而非按 test 扇出（一次运行一份证据 + test_ids[] 清单），存日志 sha；guard 至少校验声称的 test_id 在日志中出现过（grep 级即可）。证据数量直接降一个数量级，还顺带解决 H-5。

### H-5 [P2] 证据经济失控：一个中等 change 产出 200+ 文件

~170 份 RED/GREEN JSON（8 task × 重叠的 test 集，TEST-003 这类共享测试在 1-1/2-1/2-3 各有一套 RED+GREEN）+ 24 份 reports + raw 日志与二进制。没有人会审阅 170 份同构 JSON——证据量超过可审计带宽时，审计价值反而归零，只剩"合规感"。与 H-4 同根，按运行建档即可解决大半。

### H-6 [P2] 在野的 `created_by` 值证明字段语义已经漂移

实际出现的值：`native-subagent`、`user`、`codex_exec`、`user_confirmed_via_chat`。最后一个最能说明问题：branch_handling 的 human_confirmation 由 agent 代写，`created_by:"user_confirmed_via_chat"` 是 agent 对"用户在聊天里确认过"的转述声明——C-3（human_confirmation 无 schema）与信任模型 P0-1（作者性自声明）的活化石。另：批量 evidence 的 created_at 手写为同一秒（09:51:33Z），且早于其 output_ref 文件的 mtime（09:55Z），确证 created_at 不可作任何排序依据（P2-1 实证）。

### H-7 [P2] route flapping：state 的 route 是"最后一条命令"，不是工作流进度

该 change 已于 09:59 通过 `review_ready`，但 state 当前 `guard_route_phase:"propose"`、`active_gate:"tasks_complete"`——10:32 重跑了几个 propose 内部 gate，route 被拉回。`guard_route_phase` 的实际语义是"最近一次 check 的 route"，作为恢复/进度指针基本不可用。SPEC §5.3 称其为"命令路由/恢复权威"，实然与定位不符。建议 state 增加单调的 `max_route_reached` 派生字段（仅展示），或明确文档化"route 无进度语义"。

### H-8 [P3] 正面实证：guard 的约束力是真实的

公平起见：ledger 也证明 audit 层在认真工作——`invariants_reviewed` 连续 block 4 次直到证据齐全才放行；两次 stale `recompute block` 成功逼出了 refresh 重审（哪怕 refresh 本身有 H-1 的问题）；`task_edit`/`task_complete` 各有先 block 后补证据再 allow 的完整轨迹。**纪律层不是摆设**，它确实改变了 agent 的行为路径；本审计的全部问题都应理解为"在有效机制上修洞"，而非"机制无效"。

---

## 10. 修复路线图

**第一批（红线修复，1-2 天量级）**：

1. B-2 state 损坏 fail-closed（`state_corrupt` block）。
2. A-1 `design_complete` require `explore_complete`；A-2 `test_contract_honored` require `test_contract_drafted`。
3. C-1 explore/design/test-contract 三处补 stale blob 检查（照抄 invariants_reviewed 模式）+ state 指纹纳入 discovery.md/design.md。
4. B-3 写入 computed_from 使用判定时指纹。

**第二批（机制收紧，3-5 天量级）**：

5. C-2 supersede 授权模型 + supersede 事件入 ledger。
6. C-3 kind 白名单 + human_confirmation 最小 schema + A-5 四个无锚点人审阻塞点补 evidence 要求。
7. C-4 prompt_ref 存在性 + evidence_id 唯一性；C-5/H-4 test_run 按运行建档 + 强制日志引用 + test_id 在日志中可寻。
8. D-3 全局悬空引用检查（与 REVIEW_DISCLOSURE 修复共用）。
9. H-1 propose 期 role evidence 的 output_ref 查重或 review_scope 合同。
10. F-1 五十个未测 reason code 补测（可按上述高风险一档先行）。

**第三批（产品决策，需要用户拍板）**：

11. H-3 `.superspec/` 的 git 跟踪策略（ledger/evidence/manifest 入库 vs gate-allow 自动快照）——这是实证层暴露的最高优先决策项。
12. E-1 preset：实现 gate 精简或 SPEC 降级承诺。
13. G-1/G-2 安装引擎 + check-init 纳入 skill 健康检查。
14. D-2 archive manifest 外部锚点（与 H-3 同一决策域）。
15. F-4 真实 CLI 冒烟。
16. H-7 route 进度语义修正（`max_route_reached` 派生字段或文档降级）。
17. REVIEW_DISCLOSURE_FIXED_POINT 设计稿按其专项审查文档修订后实施（解决"reviewer blocker 被静默吸收"的原始痛点；其 disclosure loop 设计需吸收 H-1 的 review_scope 合同与 H-2 的批处理现实）。

**明确不修（接受为 v1 天花板，维持诚实声明）**：subagent 真实性、测试 exit code 验真、动作-allow 时序绑定、evidence 伪造防御——全部归 v2 hook，前置 R-1 spike。

---

## 11. 元观察

1. **这套系统最大的优点是诚实，最大的风险是诚实声明的边界在实现中悄悄漂移。** SPEC 把 v1 定位成 audit-only 说得很清楚，但 fail-closed 红线（B-2）、前置链承诺（A-1）、blob 防漂移机制（C-1）这些 v1 份内的硬承诺，实现上打了折扣。audit-only 不是"检查可以不严"的许可证——恰恰因为没有 runtime 强制，结构判定层是 v1 仅有的牙齿。
2. **覆盖不均比覆盖缺失更危险。** stale 检查、human_confirmation、refs 完整性检查都呈现"有的 gate 有、有的 gate 没有"的状态。一致的弱保护可以被一次性升级；不一致的保护会让使用者（和后续开发者）对"哪里有兜底"建立错误心智模型。建议为每类检查建立"适用 gate 矩阵"并在测试中断言矩阵完整性——与 REVIEW_DISCLOSURE_REVIEW §5 的可追溯性表是同一个方法论。
3. **成本问题是下一个结构性风险，且实证已经显形。** full-only 的现实（E-1）+ 多角色重审成本叠加，实证轨迹里已经长出了两个适应性形态：omnibus refresh（H-1，把多次审查压成一次）和批量补票（H-2，把流程中的 gate 挪到事后）。agent 没有违规——它在成本压力下找到了合规的最省力路径，而这条路径恰好掏空了机制的本意。对 discipline layer 而言，被合规地绕过比被违规地绕过更难发现。轮次经济与 preset 精简应当作为与安全同级的设计目标。
4. **应然审计看代码，实然审计看轨迹，两者发现的问题集几乎不重叠。** 本次 23 项静态发现里没有一项能直接预言 H-1/H-2/H-3 的具体形态；反过来，实证层的每个发现都能在静态层找到成因（H-1←output_ref 查重缺失，H-4←test_run 无 schema，H-6←created_by 自由文本）。SPEC 不全面是常态，**ledger 是这个系统里最诚实的文档**——后续任何工作流修订都应该先跑一遍真实 change 的轨迹分析再动手。
