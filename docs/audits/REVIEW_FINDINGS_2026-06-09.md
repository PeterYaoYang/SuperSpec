# SuperSpec 外部评审发现清单（交付 Codex 执行）

- 评审日期：2026-06-09
- 评审范围：`scripts/superspec/`（guard 实现 + 测试）、`docs/`（全部设计/分发/审计文档）、`.codex/skills/superspec-*`、`.codex/{agents,prompts}/*`
- 评审方式：独立代码级审计（不信任既有 `docs/audits/GUARD_PROOF_GAPS_AUDIT.md`，从代码重新找洞）+ 实跑测试/类型检查 + 对标同类 workflow / spec-kit / Veath + **critic 子代理对抗复核**
- 实测基线：`tests 202 / pass 202 / fail 0`，`tsc --noEmit` 零错误，测试总耗时 **~93.5s–142s（随负载波动）**，仓库**无 CI**。
- **本文档已纳入 critic 对抗裁决（见 §8）**：严重度已重排、若干量化/绝对化表述已修正、新增 A-7/A-8/A-9 三条更根本的问题。交给 codex 时以本（修订后）版本为准。

---

## 0. 给 Codex 的执行说明（务必先读）

1. **真相源是测试，不是文档。** 本仓库已出现"文档落后于代码"的事实（详见 P0-1）。修复任何一条前，先 `cd scripts/superspec && npm test` 跑通，再以代码+测试为准。
2. **区分修复类型**，不要混淆：
   - `CODE-FIX`：改 guard 代码 + 加测试。
   - `DOC-FIX`：只改文档，不动代码。
   - `DESIGN-DECISION`：需要人拍板的取舍，**不要擅自实现**，先在 PR/issue 里提方案。
   - `DO-NOT-BLINDLY-FIX`：v1 已知天花板，**禁止假装修复**（见 A-1），只允许"显式标注 + 为 V2 预留"。
3. **每个 CODE-FIX 必须附带回归测试**，测试名建议直接对应本文档的问题编号（如 `A-2 stale lock is reclaimed`），以便日后"测试即真相源"。
4. **不要改变既定哲学**：受控状态可重算、禁止平行状态机、overlay 不 fork OpenSpec。本清单的修复都不应违背这三条。
5. 修复优先级见 §6。

---

## 1. 优先级总览表

> 严重度已按 §8 critic 对抗裁决修订：A-7/A-8/A-9 为 critic 补充的、比原 P0 更根本的问题；P0-1 因"无引用触发器"下调；A-2 由"CRITICAL/永久"改为 MAJOR。

| 编号 | 严重度 | 类型 | 一句话问题 | 位置 |
|---|---|---|---|---|
| A-7 | 🔴 P0 | CODE-FIX | 产物只校验文件存在，不校验内容 → 空洞 review 也合法（咬诚实 agent） | `src/evidence.ts` |
| A-8 | 🔴 P0 | DESIGN-DECISION | guard 崩溃抛异常而非结构化 block；v2 hook 语境下变静默放行(fail-open) | `src/core.ts` + 设计 |
| A-2 | 🟠 P1 | CODE-FIX | 状态锁无 stale 检测，崩溃后孤儿锁阻断该 change（一行 rm 可恢复，但误导+无自愈） | `src/state.ts` |
| A-9 | 🟠 P1 | DESIGN-DECISION | allow 与真实动作之间存在 TOCTOU，动作本身不在任何校验内 | 设计/skills |
| A-3 | 🟠 P1 | CODE-FIX | 一条 human_confirmation 全局解除脏工作区门 | `src/git.ts` |
| A-1 | 🔴 概念 | DO-NOT-BLINDLY-FIX | 多agent协议无法证明 subagent 跑过（注：新鲜度+处置完整性其实**有**运行时强制） | `src/evidence.ts` |
| P0-2 | 🟠 P1 | DOC-FIX | 分发文档写 7 个 skill，实际 5 个 | `DISTRIBUTION.md` |
| T-1 | 🟠 P1 | CODE-FIX | 仓库无 CI，202 测试不会自动跑 | 新增 `.github/workflows` |
| A-4 | 🟡 P2 | CODE-FIX | (a)event_id 碰撞[cosmetic] (b)ledger/state 非联合原子 (c)created_at 可被 caller 覆盖 | `src/state.ts` |
| A-5 | 🟡 P2 | CODE-FIX | 覆盖逻辑 DRY 近乎逐行重复 + pinned_ref_key 重复定义 3 次 | `src/gates.ts`,`src/evidence.ts` |
| A-6 | 🟡 P2 | CODE-FIX | blob_sha 受 autocrlf/clean filter，跨平台假阳性 | `src/git.ts` |
| P0-1 | 🟡 P2 | DOC-FIX | 自审文档把已修的 GPG 标成"未解决"（真实但无引用触发器，故下调） | `docs/audits/GUARD_PROOF_GAPS_AUDIT.md` |
| T-2 | 🟡 P2 | CODE-FIX | 测试 ~93.5s（大量真实 subprocess）；仅 DX 摩擦，与 doc drift 无因果 | `tests/` |
| A-10 | 🟠 P1 | DESIGN+CODE | OpenSpec 多面深耦合；R-3 兼容层只防 status，`instructions` 产出引擎无兜底 | `src/openspec.ts` + 设计 |
| P0-3 | 🟠 P1 | DESIGN-DECISION | 缺单一同步机制，规范被实现倒逼漂移 | 全局 |
| S-3 | 🟠 P1 | DESIGN-DECISION | L4 hook（机械强制）未实测**且实验顺序倒置**，决定 v2 生死 | 设计/对外措辞 |
| S-1 | 🟡 P2 | DESIGN-DECISION | 复杂度高；preset 未真正减负；review 机器应砍到与可验真匹配 | `src/gates.ts` |
| S-2 | 🟡 P2 | DESIGN-DECISION | 分发仅设计未实施，3 处写死耦合，当前 copy 到他仓即失效 | `DISTRIBUTION.md` |

---

## 2. P0 / P1：文档-实现一致性（元问题）

### P0-1 — 自审文档严重落后于代码 `DOC-FIX`

- **现象**：`docs/audits/GUARD_PROOF_GAPS_AUDIT.md` §1.1「当前未解决问题快照」把 **GPG-001 / 002 / 003 / 008 / 009 / 010** 标为"阻断级未解决"，并称测试 180 个。
- **实测真相**：这 6 条**已全部实现并有测试**，当前测试 **202 个全绿**。证据：
  - GPG-001：`src/tasks.ts` `task_test_evidence(..., gate)` 接受 gate 参数；`src/gates.ts` `check_task_edit` 传 `"task_edit"`、`check_task_complete` 传 `"task_complete"`。
  - GPG-002：`src/gates.ts` 调 `declared_test_evidence_reasons`（逐项校验每个 declared `TEST-*`）。
  - GPG-003：`src/invariants.ts` `invariant_matrix_coverage_reasons` 已校验 hard INV 覆盖 + status + 引用 live evidence；`src/gates.ts:1319` 调用。
  - GPG-008/009/010：`src/evidence.ts` `unresolved_live_task_reopens` 用 `pass_task_reopens`（含 superseded，防隐藏）；`src/gates.ts` 全局 reopen 生命周期校验含 `unknown_task` / `reopen_lifecycle_exhausted`。
- **危害（已按 critic 降级）**：理论上 agent 读这份审计会误判 → 重复"修复"或对 guard 失去信任。**但 critic 全仓 grep 确认：无任何 SKILL.md/guard 代码引用 `docs/audits/GUARD_PROOF_GAPS_AUDIT.md`，该文件现归档为审计文档且非规范源，权威源 `SPEC.md` 准确。** 故危害是假设性的（缺触发器），严重度从"最严重"下调为 P2 文档清理。仍应修，因为它是 P0-3（无同步机制）的症状样本。
- **修复**：将 §1.1 / §35 / §36-38 与代码对齐——把这 6 条标为"已修复（由测试 X 守护）"，测试计数 180 改为以 `npm test` 实际输出为准；或将整份文档降级为顶部硬标「本快照可能落后，以测试为准」的历史快照。GPG-010 应标"中风险"而非阻断。
- **验收**：文档不再出现与 `npm test` 结果矛盾的"未解决/计数"陈述；最好由 P0-3 的一致性测试自动守护。

### P0-2 — 分发文档 skill 数量错误 `DOC-FIX`

- **现象**：`docs/DISTRIBUTION.md` §1 / §3 列 7 个 skill，含 `superspec-init`、`superspec-verify`。
- **真相**：实际 `.codex/skills/` 下只有 **5 个用户可见 skill**：`superspec-explore / propose / apply / review / archive`。`init` 已改为脚本 `scripts/superspec_init`，`verify` 已并入 `review`。
- **修复**：`DISTRIBUTION.md` 改为 5 个，删除 `superspec-init` / `superspec-verify` 条目及其安装清单；同步检查 install-manifest 相关描述。
- **验收**：文档列出的 skill 集合 == 文件系统实际集合（建议由 P0-3 的一致性测试守护）。

### P0-3 — 缺少"单一同步机制"，规范被实现倒逼漂移 `DESIGN-DECISION`

- **现象**：`SPEC.md` / `docs/audits/GUARD_PROOF_GAPS_AUDIT.md` / 代码 / 5 个 skill / `DISTRIBUTION.md` 五处各自维护"当前状态"，无同步约束。`SPEC.md` 内部充斥"当前 v1 floor route…""当前实现只持久化 fresh|recomputed"等补丁式追述，说明规范在被动追代码。
- **目标**：让"可执行测试"成为唯一真相源，文档只引用测试。
- **建议实现（即评审里的"选项 b"）**：
  1. **GPG ↔ 测试名映射**：每个 GPG 编号对应一个命名锚点测试；文档不再写"已修复/未解决"，只引用测试名。
  2. **一致性测试**（扩展 `tests/test_superspec_skills.test.ts`）：
     - 断言 `DISTRIBUTION.md` 列出的 skill 数量/名称 == `.codex/skills/superspec-*` 实际集合（当场抓 P0-2）。
     - 断言 `SPEC.md` 列出的 gate / evidence kind 集合 == `src/util.ts` 常量集合。
  3. **删冗余**：移除/降级 `GUARD_PROOF_GAPS_AUDIT.md §1.1` 这类"手写状态镜像"。
- **验收**：故意改坏文档（如把 skill 写成 6 个）能让某个测试变红。

---

## 3. 代码级审计发现（独立从代码找洞）

### A-1 — 多agent审查协议在 v1 无法证明 subagent 真的运行过 `DO-NOT-BLINDLY-FIX`

- **位置**：`src/evidence.ts` role evidence 校验（约 288-302 行）。
- **现象**：guard 判定一条 `source_guidance` 是否来自独立 subagent，**关于"谁产出的"这一项**全部依据自报字段：`execution_mode === "native_subagent"` + `created_by/agent_id` 不在固定 denylist `SELF_REVIEW_MARKERS`（`main`/`self`/`codex_exec`…）里。**这些字符串都是主线程自己写进 JSON 的，guard 无法证明任何 subagent 真的运行过。**
- **⚠️ critic 修正（重要，写给 codex）**：不要据此以为"v1 无任何运行时强制"——这是**错的**。`pinned_ref` 新鲜度（重算 `file_blob_sha` 比对，`evidence.ts:108-134`）和 main_adjudication 处置完整性（每个 `required_claim_ids`/`blocking_findings` 恰好覆盖一次、残留 needs_fix 直接 block）**确实是运行时强制、且非自报**的。可被伪造的只是"subagent 身份"这一项，不是整套协议。
- **后果（已重锚）**：真正的洞不是"可伪造"（伪造一个**有实质 findings 的通过** adjudication 工作量≈真做），而是**与 A-7 合流的"空洞也合法"**——身份无法证明 + 内容不校验，使得"主线程自报一个内容空洞的 subagent review"可以过关。这才是 v1 多agent协议强制力的真实上限。
- **⚠️ 禁止的"修复"**：不要在 v1 试图用更长的 denylist / 更多自报字段来"堵住伪造"——那是安全剧场，仍可绕过。
- **允许的处理**：
  1. `DOC-FIX`：在 `SPEC.md` / skill / guard 输出里**显式、醒目地**标注"v1 多agent证据为 audit-only，无运行时证明，强制力依赖合作型 agent 自觉"。`trustWarnings()` 已有总括警告，建议针对 role evidence 增加专门告警行。
  2. `DESIGN-DECISION`：把"subagent 运行证明"明确登记为 V2 / L4（`SubagentStop` hook 捕获运行时事件）的待办，并在 schema 里**预留**一个未来由 hook 填充、主线程不可写的校验位（设计先行，不在 v1 实现强制）。
- **⚠️ 架构 critic BLOCKER-1（重要，影响是否要砍 review 机器）**：v2 的 `SubagentStop` runlog 也只能证明"一个 type=critic 的 agent 启动过"，**证明不了它做了有能力的对抗审查**——"审查质量"在任何路线图上都没有运行时取证源（不同于 RED/GREEN 的 exit_code 可证伪）。因此 review 阶段那套最重的 evidence 契约（main_adjudication 12 字段 + 双 verification_review + claim/finding 逐条裁决）**校验的全是结构完整性、而非审查真实性**，且会制造"被严格审查过"的错觉。建议：**保留多视角 prompt 效应（对善意 agent 确有价值），但把 review evidence 机器砍到与"可验真能力"匹配的程度**（趋近"一个 advisory critic prompt + 一个 final 测试"）——这是复杂度/收益最失衡处。属 `DESIGN-DECISION`，需人拍板，勿擅自删。
- **验收**：文档与 guard 输出不再让读者误以为 v1 的多agent审查"无法伪造"或"已被严格验真"。

### A-2 — 状态锁无 stale 检测，孤儿锁阻断该 change `CODE-FIX`（MAJOR，非 CRITICAL）

- **位置**：`src/state.ts` `with_state_lock`（116-135 行），重试在 `src/core.ts` `dispatch`（289-306 行）。
- **现象**：锁是 `openSync(lock, "wx")` 独占创建，正常在 `finally` 里 `unlinkSync`。但**无 PID、无 TTL、无 stale 检测、无 force-unlock**。进程在持锁期间被 kill（OOM / Ctrl-C / CI timeout / 容器重启）→ 锁文件残留 → 此后该 change 的**每次** guard 调用都抛 `state_concurrent_update`。
- **`dispatch` 重试救不了（critic 确认这是最准的一击）**：重试只对 `state_concurrent_update:` 前缀重试 5 次、退避后抛 `retry budget exhausted`。测试 `test:2115` 证明它**只**能救"另一个活进程在 0.1s 内 rm 锁"的瞬时竞争；**孤儿锁没人 rm，5 次必然全 EEXIST → 抛异常**。
- **后果（已按 critic 降级措辞）**：不是"永久/无解"——`rm .superspec/superspec-state.lock` 一行即恢复，blast radius = 单个 change，可立即检测。但**对自治 agent 仍是真问题**：① 错误信息 `"...held; retry recompute"` **主动误导**（让 agent 去重试，而重试对孤儿锁必然失败，把可恢复问题伪装成死循环）；② 无自愈；③ 见 A-8——此异常在 v2 hook 语境会从"卡死"变成"静默放行"。
- **修复**：锁文件写入 `{pid, hostname, created_at}`；EEXIST 时读锁内容判断 stale（PID 不存在 / 超 TTL）则原子接管；提供 `recompute --force-unlock`；并把误导的错误信息改成提示"如确认无并发进程，删除 .lock 或 --force-unlock"。注意 TOCTOU——接管用原子操作。
- **验收**：`A-2 stale lock is reclaimed after holder death`（留一个指向不存在 PID 的锁，下次应接管）+ `--force-unlock` 能恢复。

### A-3 — 一条 human_confirmation 全局解除脏工作区门 `CODE-FIX`

- **位置**：`src/git.ts` `dirty_worktree_reasons`（34-44 行）。
- **现象**：只要存在任意一条 `gate:"branch_handling"` 的 `human_confirmation`，**整个仓库所有脏/未跟踪文件的 scope 检查全部跳过**（直接 `return []`），豁免是二元、全局、与具体文件无关的。
- **后果**：配合 A-1（human_confirmation 也自报），等于一张万能通行证；即便合作场景也极易过宽满足。
- **修复**：让 `human_confirmation` 绑定它确认的**具体路径集合**（如 `confirmed_paths: [...]`，带 pinned_ref 更佳），只豁免这些路径；未列入的脏文件仍需阻断。
- **验收**：新增测试 `A-3 human_confirmation only waives its declared paths`：确认 path A 后，脏文件 B 仍触发阻断。

### A-4 — 账本可审计性瑕疵 `CODE-FIX`

- **位置**：`src/state.ts` `materialize_ledger_event`（79-81 行）；`write_prepared_state_locked`（205-235 行）。
- **A-4c（created_at 可被覆盖，critic 补充，优先修）**：`materialize_ledger_event` 里 `{ event_id, created_at: now(), ...event }` 的 `...event` spread **在后面**，若 caller 传入 `created_at`，会**覆盖**规范 `now()` → 审计时间戳由作者控制。这是真正的审计完整性洞。修复：把 `...event` 放最前，让 `event_id`/`created_at` 覆盖 caller 传值（不可被外部改写）。
- **A-4a（event_id 碰撞，cosmetic）**：`event_id: \`EVT-${Date.now()}\`` 毫秒级，同毫秒会重复。**critic 核对：`event_id` 全仓零消费者（无去重/索引/查找依赖），碰撞当前无下游破坏，纯 cosmetic。** 仍建议改为 `${Date.now()}-${seq/random}`（`begin_archive_preservation_bundle` 已这么做，可统一）。
- **A-4b（ledger 与 state 非联合原子）**：先 rename ledger 再 rename state，崩溃落在中间 → 账本记了决策但 state 未推进。修复：写明"账本是尝试日志、可能超前于 state"的语义（DOC），或引入单一 journal 联合提交。
- **验收**：`A-4c ledger created_at cannot be overridden by caller`；`A-4a ledger event ids are unique within the same millisecond`。

### A-5 — 覆盖逻辑 DRY 重复 + subtle 正确性无护栏 `CODE-FIX`

- **A-5a（DRY）**：`src/gates.ts` `check_review_complete`（约 1359-1367 行起，allow 路径内联）与 `main_adjudication_source_guidance_reasons`（约 195-257 行，request_changes 路径）**各有一份几乎同构的 claim/required_load/finding 覆盖聚合逻辑**。将来改"覆盖规则"易只改一处、漏另一处（历史 GPG-013/021 系列同类坑）。修复：抽出单一公共函数，两条路径共用。
- **A-5b（subtle 正确性）**：`src/evidence.ts` `pass_task_reopens`（584-608 行）**故意**用 `find_pass`（含 superseded）而非 `live_pass` 来堵 GPG-008，正确但无注释——未来有人"顺手优化"成 `live_pass` 会静默重新引入已修漏洞。修复：加显式注释说明"勿改为 live_pass 及原因" + 一条专门的回归锚点测试。
- **验收**：抽公共函数后两条路径测试仍全绿；新增 `A-5b reopen history is not hidden by generic supersede`（若改成 live_pass 该测试应变红）。

### A-6 — blob_sha 跨平台假阳性 `CODE-FIX`

- **位置**：`src/git.ts` `file_blob_sha`（8-13 行）。
- **现象**：用 `git hash-object`，它会走 `.gitattributes` 的 clean filter 和 `core.autocrlf` 规范化。Windows 检出或带 clean filter 的仓库，同一逻辑内容算出的 blob_sha 与录入时不同 → `pinned_ref` 误报 `stale_review` / `stale_loaded_ref` → 评审门误阻断。
- **关联**：与 `DISTRIBUTION.md` 的跨平台分发目标直接冲突。
- **修复（择一）**：改用 `git hash-object --no-filters`，或改用稳定的字节级 sha256（与现有 `sha256_file` 一致），或在文档明确约束 CRLF/filter 配置。
- **验收**：在 `core.autocrlf=true` 模拟下，pinned_ref 不因换行规范化误报 stale。

### A-7 — 产物只校验存在、不校验内容：空洞 review 也合法 `CODE-FIX` 🔴（critic Top-1）

- **位置**：`src/evidence.ts` `output_ref_reasons`（208-219 行）及各 `*_ref` 校验。
- **现象**：对 `output_ref`、role evidence 的产出文件，guard 只校验 `safe_within + existsSync + isFile`，**从不校验内容是否非空/是否实质**。`target_refs` 的 blob_sha 只证"文件没变"，不证"文件是真 review"。
- **后果（比"可伪造"更根本）**：一份指向**空文件**、甚至指向 `tasks.md` 自身的 role evidence 照样过 `review_complete`。**这咬的是诚实 agent**——只要忘了写实质内容也能过关，guard 无法区分空洞评审与真实评审。这是 v1 强制力的真实上限，结论 2/A-1 应以此为核心。
- **修复（audit-only 范围内可做的硬化）**：对 `output_ref`/产出文件加最小内容校验（非空字节数下限、必需结构标记/章节锚点、不得等于被评审的源文件路径自身、与其它 evidence 的 output_ref 不得指向同一文件等）。注意：这只能提高空洞成本，不能在 v1 根除（根除需 A-8/L4）。
- **验收**：`A-7 review evidence with empty/echoed output_ref is rejected`。

### A-8 — guard 崩溃抛异常而非结构化 block；v2 hook 下 = 静默放行 `DESIGN-DECISION` 🔴（critic Top-2）

- **位置**：`src/core.ts` `dispatch`（289-306，孤儿锁 → `retry budget exhausted` 抛出）；以及 openspec 未装 / 状态 JSON 畸形 / IO 错误等路径。
- **现象**：上述失败 guard **抛异常**而非返回结构化 `block` 决策。v1 无 hook，崩溃语义交给 skill 散文处理；而 `SPEC.md:34,464` 明示 **Codex hook 失败默认 continue tool call（fail-open）**。
- **后果**：A-2 的孤儿锁在 v1 是"卡死"，**一旦进入 v2 hook 就变成静默放行**——一个本应 fail-closed 的强制器，在最关键的崩溃路径上会 fail-open。这是比陈旧草稿严重得多的强制力风险。
- **修复（DESIGN）**：定义 guard 的崩溃契约——所有内部失败必须转成结构化 `block`（fail-closed）而非裸异常；为 v2 hook 明确"guard 自身异常 = deny，不是 continue"。这是需要先拍板的设计决定，**不要在 v1 仓促实现**，但必须在 L4 hook 落地前定稿。
- **验收**：dispatch 在 openspec 缺失/状态畸形/孤儿锁下返回 `decision:"block"`（带明确 reason），而非抛出未结构化异常。

### A-9 — allow 与真实动作之间的 TOCTOU `DESIGN-DECISION`（critic Top-3）

- **现象**：`check-archive-ready` 在 T0 给 allow，agent 在 T1 才执行真正的 `openspec archive -y`；`check-task-complete` 给 allow 后 agent 才去勾 `- [x]`。guard 校验的是**快照**，被门禁的**动作本身不在任何锁/校验内**。
- **后果**：即便接受 audit-only，"被审计的动作"与"审计时刻"之间的窗口里状态可任意漂移；且对**动作**连事后锚点都没有。"audit-only = 事后可重算发现"的表述对动作并不成立。
- **修复（DESIGN）**：在 v2/L4 用 `PostToolUse` hook 捕获真实动作并锚定到 allow 决策；v1 至少在文档显式承认此窗口，不夸大 audit-only 的覆盖面。
- **验收**：文档不再暗示 v1 能事后发现 allow 后的动作漂移。

### A-10 — OpenSpec 耦合面是多处深耦合，`instructions` 产出引擎兜底缺失 `DESIGN-DECISION` + `CODE-FIX`（架构 critic MAJOR-3）

- **现象**：耦合不止"读 `openspec status --json`"一处，而是 **4+ 面**：① `status --json` 字段 shape；② `openspec validate`（archive/review 前置）；③ `openspec archive` 隐藏目录保留行为（R-2 只对 1.4.1 做过一次性 spike）；④ **`openspec instructions <artifact> --json` 作为强制产出引擎**（`SPEC.md §11.4` 铁律：绝不徒手写 artifact，必须取 `template/rules/context/resolvedOutputPath/dependencies`）；⑤ check-init 对 repo-local `openspec-*` skill front matter 的存在性校验。而 `openspec schema` 命令官方标 **experimental**。
- **后果**：`status` 漂移只影响"读"，已有较好兜底（R-3：shape 校验 + golden fixture + 兼容层）。但 **`instructions` 输出结构漂移会打断"写"路径**——`template`/`resolvedOutputPath`/`dependencies` 字段一变，propose/apply 产出流程静默断裂，而 R-3 兜底**几乎只覆盖 status**，对 instructions/archive 输出 shape 着墨极少（status 防御 ≈ A-，instructions 防御 ≈ D）。v1 又是 audit-only，断了未必立刻发现。
- **⚠️ 注意**：overlay 复用产出引擎（不 fork）是**正确**架构决定，**不要改成 fork**。这条要修的是"兜底覆盖面"，不是耦合本身。
- **修复**：把 R-3 兼容层从"只防 status 漂移"扩展到 `instructions` 与 `archive`，各加 golden fixture + 输出 shape 校验 + 版本兼容层；锁定/记录已验证的 OpenSpec 版本范围。
- **验收**：`instructions`/`archive` 各有 golden fixture 测试；上游字段重命名能被 shape 校验当场抓出而非静默断裂。

---

## 4. 自测 / 工程化

### T-1 — 仓库无 CI `CODE-FIX`

- **现象**：仓库**无 `.github`**，202 测试只能手动跑。这是 P0-1 文档漂移的机制性原因之一（没人自动验证 → 文档停在旧状态）。
- **修复**：新增最小 CI（GitHub Actions 或团队现有 CI），在 `scripts/superspec` 下跑 `npm ci && npm run typecheck && npm test`，PR 必须绿。
- **验收**：CI 配置存在并能触发；红测试能阻断合并。

### T-2 — 测试偏慢（~93.5s）`CODE-FIX`（DX 摩擦，非阻断）

- **现象**：相当一部分用例用 `spawnSync(process.execPath, [GUARD_TS, ...])` 真实启动 node 子进程跑整个 guard（冷启动 + 重新 strip TS + 真实 git/fsync），单个 ~1s，叠加起来 critic 实测 **93.5s**（我侧 142s，受机器负载波动）。
- **⚠️ critic 修正**：**删除原"慢测试→文档漂移"的因果归因**——手写 audit 根本不由 `npm test` 生成，doc drift 真因是"修完没回填手写审计"，与测试速度正交。T-2 仅是 DX 摩擦，**不是 P0-1 的成因**，优先级随之下调。
- **修复（可选优化）**：保留少量端到端 subprocess 冒烟用例，其余改为直接 import 函数 + `withRuntime` 注入 fake（仓库已有该模式）；或并行化 `node --test`。
- **验收**：`npm test` 总耗时下降且仍 202 全绿。

> 注：`npm run typecheck` / `npm test` 从正确目录运行正常，**npm 脚本本身无缺陷**（评审过程中一次失败是沙箱 cwd 问题，非真实问题）。

---

## 5. 结构 / 取舍建议（需人拍板，勿擅自实现）

### S-1 — 复杂度反噬，preset 未真正减负 `DESIGN-DECISION`

- 9 gate × 5 skill × 13 种 evidence kind × 4 status × reopen 双轨生命周期 × pinned_ref × main_adjudication 十几个必填字段，认知负担高；最现实的 failure mode 是 agent 写错 evidence 卡死或绕过退回裸 OpenSpec。
- `tweak`/`hotfix` preset 名义减负，但 `SPEC.md §13` 明文规定 `review_complete` 仍须满足与 `full` 相同的 review 契约（3 角色 source_guidance + 内联 verification + 终局 main_adjudication）——**全流程最贵的 review 那一段三档 preset 一视同仁**，改个文案的 tweak 仍要 3 subagent + 12 字段 adjudication。
- **建议（架构 critic 强化）**：
  1. 让 `tweak`/`hotfix` 真正放宽 review 角色面（如单 reviewer + 主线程 adjudication）。
  2. **reopen 在 v1 收敛为"单轮 reopen + 一条 resolved + review_ready 重算"**，把对抗性 supersede 防御（GPG-008/009/010/020/025）**推迟到 V2**（届时 review 可取证才有意义）——而非天真删除，是刻意分期。
  3. 把 review evidence 机器砍到与"可验真能力"匹配的程度（见 A-1 设计建议）。

### S-1b — 其它复杂度/可用性次要项 `DESIGN-DECISION`（架构 critic MINOR）

- **"哪一步"有四个重叠概念**：`guard_route_phase` / `requested_route_phase` / `active_gate` / OpenSpec status，`SPEC.md §5.3` 花整页消歧——需要一页防混淆本身就是认知负担信号。
- **绿地工具背 legacy 兼容**：`verify_complete` / `check-verify-ready` 作为"兼容别名"贯穿 SPEC/测试/skill，但 v1 从未发布过——给没出生的工具维护历史兼容是无谓表面积，建议删。
- **GPG-004 自承"策略过严"**：human-confirmation 型 hard invariant 被强制塞进 TEST 矩阵会误挡合法用例（false-block），是"严格"反噬可用性的实例。

### S-2 — 分发目前做不到（DISTRIBUTION 仅设计、未实施） `DESIGN-DECISION`（架构 critic MINOR）

- `DISTRIBUTION.md` 全是设计（P0-P4 未实施），且已实测三个写死耦合点：wrapper 写死 `scripts/superspec/` 布局、skill 假设 CWD=repo root、`.codex/` 被 gitignore 无 git 兜底。
- **后果**：当前**直接 copy 到别人仓库会失效**，"对标同类轻量 workflow 的传播力"暂时只在 PPT。
- **建议**：把这三个写死点列为分发 P0；在能一键装进任意仓库前，不对外宣称"可分发/给团队用"。

### S-3 — L4 机械强制未实测 + 实验顺序倒置（决定 v2 生死） `DESIGN-DECISION`（架构 critic BLOCKER-2）

- v1 真实净强制力 = OpenSpec 原生硬约束 + 合作 agent 自觉 = **同类轻量纪律框架级别**；项目头号目标 G6"机械强制"完全押注 V2 的 L4 hook，而 R-1（Codex `PreToolUse` 对 `apply_patch` 的真实 deny、`unified_exec` 绕过率、guard-as-hook 时延）**一项都未实测**。
- **顺序倒置（核心缺陷）**：决定整个项目是否有差异化的 R-1 spike（真跑一次 deny 即可验证、成本极低）被排在 v1 全部工程（含 9400 行 guard）**之后**。若 R-1 失败 → 永久停 audit-only → **用更高复杂度换来同级强制力**。
- **建议（强烈）**：**把 R-1 spike 提到最前，先验证再决定要不要继续加码这套复杂度**；在跑通前，所有对外材料严格只说"audit-only / 纪律框架"，不宣称"机械强制"。

---

## 6. 建议修复顺序（给 Codex，已按 critic 裁决重排）

**第一梯队（强制力/正确性，先做）**
1. **A-7** 产物内容校验（空洞 review 止血，咬诚实 agent，最高 ROI）
2. **A-2** 状态锁 stale 回收 + 误导信息修正（CODE-FIX）
3. **A-3** 脏工作区门绑定路径（CODE-FIX）
4. **A-4c** created_at 不可被 caller 覆盖（CODE-FIX，审计完整性）

**第二梯队（防再漂移 + 可维护性）**
5. **T-1** 接最小 CI（让测试自动跑）
6. **P0-2 + P0-1** 文档对齐（DOC-FIX，快）
7. **A-5** 抽公共覆盖函数 + pinned_ref_key 去重 + reopen 锚点测试
8. **A-6** blob_sha 跨平台；**A-4a/A-4b** 账本细节；**T-2** 测试提速（可选）

**需先拍板再实现（DESIGN-DECISION，勿擅自改）**
9. **A-8** guard 崩溃 fail-closed 契约（L4 hook 落地前必须定稿）
10. **A-9** allow↔动作 TOCTOU（v2 用 PostToolUse 锚定）
11. **A-1** v1 强制力诚实化（只做文档标注，DO-NOT-BLINDLY-FIX）
12. **P0-3** 单一同步机制（一致性测试）；**S-1** preset 真正减负；**S-3** R-1 spike

---

## 7. 对标结论（供决策背景，非待办）

| 维度 | SuperSpec | 轻量整合型 workflow | spec-kit (官方) | Veath/opsx-superpowers |
|---|---|---|---|---|
| 状态机哲学 | 可重算受控状态，**禁止**平行状态机 | **显式相位状态机** | 无 | OpenSpec 原生拥有 |
| guard | TS + 指纹CAS + 证据schema + pinned_ref | bash / YAML 级校验 | 无 | 无（schema/模板） |
| 证据强度 | **内容寻址（blob_sha）** | 以存在性为主 | 无 | 无 |
| 多agent对抗审查 | **导游/裁决分离（独有最深）** | 通常较轻 | 无 | superpowers 纪律 |
| 上手/采用 | 高门槛 / 自用 | 中 / 单入口 UX 更顺 | 低 / 广泛 | 中 / 小众 |

- **vs 轻量整合型 workflow**：SuperSpec 严格一个量级（内容寻址证据、真多agent协议、状态防漂移更彻底），但轻量方案通常更轻、单入口 UX 更顺。两者都经历过"状态从 openspec 子树解耦出去"的同类进化。
- **vs spec-kit**：不同物种。spec-kit 是纯脚手架（无 guard/证据/强制），漂移靠社区外挂 reconcile/archive。SuperSpec 重几十倍、方向相反。
- **vs Veath**：哲学最近（overlay 不 fork + graceful degrade），但它 schema+模板级（轻），你 TS guard + 202 测试级（重）——印证方向正确，也反衬"重量差"值得持续自问。

---

## 8. Critic 对抗裁决（已完成，总评：REVISE）

critic 子代理独立复核了 §3 每条结论（重跑测试、逐行核对代码），结论是**硬事实大多成立，但有两类系统性偏差**：(1) 严重度排序失真；(2) 若干量化/绝对化表述经不起核对。本文档 §1～§4 已按其裁决修订，下面是裁决全文摘要。

### 逐条裁决

- **结论 1（文档陈旧 = 最严重）→ 事实成立，定级夸大。** 6 条 GPG 确已实现（独立核对：`task_test_evidence` 已加 `gate` 形参 `tasks.ts:185`、RED 绑 `task_edit`/GREEN 绑 `task_complete`、`invariant_matrix_coverage_reasons` `invariants.ts:330-367`、`pass_task_reopens` 用 `find_pass` `evidence.ts:584-608`）；doc 自述 180/180、实测 202。**但**：该文件现归档为审计文档且非规范源，**全仓 grep 无任何 SKILL.md/guard 代码引用它** → "agent 误读"的危害链缺触发器，是假设性危害。权威源是 `SPEC.md`（准确，明示 v1=audit-only）。**故 P0-1 从"最严重"下调。** 另：GPG-010 是中风险非阻断（我原表述不精确）。

- **结论 2（强制力空头/成本收益倒挂）→ 核心成立，三处夸大。** 角色证据无 subagent 运行证明（对）。**但**："完全无运行时强制"**事实错误**——`pinned_ref` 新鲜度（重算 blob_sha，`evidence.ts:108-134`）和 main_adjudication 处置完整性（每个 claim/finding 恰好覆盖一次，残留 needs_fix 直接 block）**确实是运行时强制的非自报项**；"写 JSON 即可"夸大——伪造一个**有实质 findings 的通过** adjudication 工作量≈真做；"成本收益倒挂"用错威胁模型（cooperative 下价值是强制产出+审计轨迹+新鲜度+角色分离，非防篡改）。

- **结论 3（复杂度/reopen 过度工程）→ 复杂度成立，"过度工程"夸大，bypass 成立。** `REVIEW_TASK_REOPEN_PROTOCOL_DESIGN.md:94,439` 证明设计者明知 sha256 是 audit-only 并据此刻意设计，双轨各防一个具体审计连贯性失败，是**有据取舍**非天真堆叠。更准确表述是"audit-only 下成本/收益偏高"。v1 无 hook → bypass 退回裸 OpenSpec 结构上成立。

- **结论 4（142s 慢测试→doc drift）→ 数字错误 + 因果错误。** 实测 **93.5s 非 142s**（我高估 ~50%）；且 doc drift 真因是"修完没回填手写审计"，与测试速度**正交**——手写 audit 根本不由 `npm test` 生成。**此因果链已从 T-2 删除。**（注：测速受机器负载影响，我侧测得 142s、critic 侧 93.5s，无论如何都比"导致漂移"的归因更温和。）

- **结论 5 → (a) 机制成立、"dispatch 救不了孤儿锁"成立（最准一击），但"永久/无解"夸大（一行 `rm` 可恢复，MAJOR 非 CRITICAL）；(b) 机制成立但 event_id 零消费者，实为 cosmetic（我隐含的严重度偏高）；(c) 成立且比我说的更严重**（是近乎逐行内联拷贝，且 `pinned_ref_key` 重复定义 3 次）。

### Critic 补充的、我漏掉的更严重问题（已纳入 §3 为 A-7/A-8/A-9）

- **Top-1 → A-7 内容空洞性**：`output_ref_reasons`（`evidence.ts:208-219`）只校验 `safe_within+existsSync+isFile`，**从不校验内容/非空**。指向空文件、甚至指向 `tasks.md` 自身的 role evidence 照样过 review_complete。这比"可伪造"更根本——**连诚实 agent 忘写实质内容也能过关**，guard 无法区分空洞与真实评审。结论 2 应以此为核心。
- **Top-2 → A-8 guard 崩溃 fail-open**：v1 无 hook，崩溃语义交给 skill 散文；`SPEC.md:34,464` 明示 Codex hook 失败默认 continue（fail-open）。`dispatch()` 在孤儿锁/openspec 未装/状态 JSON 畸形/IO 错误时**抛异常而非返回结构化 block**。即 A-2 的 brick 进入 v2 hook 语境会变成**静默放行**。
- **Top-3 → A-9 allow 与动作间的 TOCTOU**：`check-archive-ready` 在 T0 给 allow、agent 在 T1 才执行真正的 `openspec archive -y`；`check-task-complete` 给 allow 后才勾 `- [x]`。guard 校验的是**快照**，被门禁的**动作本身不在任何锁/校验内**，"audit-only"表述把它说成"事后可重算发现"，但对**动作**连事后锚点都没有。

### Critic 额外发现（已纳入 A-4c）

- `materialize_ledger_event`（`state.ts:80`）的 `...event` spread 在 `event_id/created_at` **之后**，caller 传入的 `created_at` 会**覆盖**规范 `now()` → 审计时间戳可被作者控制（真正的小审计完整性洞，比 event_id 碰撞更值得修）。

---

## 9. 架构级 Critic 终审（第二位 critic，已整合）

除 §8 的代码级 critic 外，另有一位 **架构级 critic** 从"功能价值 vs 投入"角度复审，总评同为 **REVISE**，并提出 2 个 BLOCKER + 3 个 MAJOR。其结论已分别整合进上文，对应关系如下：

| 架构 critic 结论 | 整合位置 |
|---|---|
| **BLOCKER-1**：旗舰"多视角对抗审查"在 v1 **和 v2** 都不可验真（v2 runlog 只证 subagent 启动过，不证审查质量）；review 重型机器只保证结构完整、非审查真实 → 应砍到与可验真匹配 | A-1（已补设计建议）+ A-7 |
| **BLOCKER-2**：G6"机械强制"是唯一差异化但 v1 完全未满足，全押 R-1，而 R-1 被排到最后才验 = **实验顺序倒置** | S-3（已升级为 BLOCKER + 顺序倒置） |
| **MAJOR-1**：reopen 生命周期是"为对抗审查而对抗审查"的标本（6 条 GPG 加固一个 v1 可整体伪造的状态机）；对 honest agent 有 mistake-evidence 价值，但净失衡 | S-1（已补"v1 收敛单轮 reopen、对抗防御推迟 V2"） |
| **MAJOR-2**：SuperSpec **文档语料库本身**违反它鼓吹的"单一真相源"（9 份设计文档 = 它要消灭的平行状态机，且正在漂移） | P0-1 + P0-3 |
| **MAJOR-3**：OpenSpec 是多面深耦合，`instructions` 产出引擎兜底缺失 | A-10（新增） |
| MINOR：preset 不减 review 负 / 四个重叠"步"概念 / 绿地工具背 legacy 别名 / 分发未实施 3 写死点 / GPG-004 过严 false-block / 13 evidence kind 组合过载 | S-1 / S-1b / S-2 |

**两位 critic 的共识（信号最强，建议最优先采纳）**：
1. **review 阶段的重型 evidence 机器，其严格度与"可验真能力"严重不匹配**——两位都指向"结构完整 ≠ 审查真实/非空洞"（代码 critic 的 A-7 空洞性 + 架构 critic 的 BLOCKER-1）。
2. **严重度应从"文档陈旧"上移到"强制力真实性 + 崩溃语义 + 复杂度失衡"**。
3. **R-1 spike 应前置**：在继续加码复杂度前，先用最低成本验证机械强制是否可行。
