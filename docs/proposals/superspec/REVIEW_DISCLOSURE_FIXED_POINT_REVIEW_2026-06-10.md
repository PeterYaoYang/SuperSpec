# REVIEW_DISCLOSURE_FIXED_POINT_DESIGN 审查结论与修复方案

> 状态：Review findings / 2026-06-10（v2：同日深查修订——推广 P0-1 至全部证据通道，新增 P1-6、P2-5，为 R3 增加锚定风险对策）
> 审查对象：`docs/proposals/superspec/REVIEW_DISCLOSURE_FIXED_POINT_DESIGN.md`（下称"设计文档"）
> 审查方式：设计文档逐节审查 + 对照 `scripts/superspec/src/gates.ts`、`scripts/superspec/src/evidence.ts` 实现核实
> 结论：问题诊断准确、方向正确、落地顺序合理。但存在 2 个 P0 信任漏洞、6 个 P1 问题、5 个 P2 问题和一组成本/退化风险。全部问题均有明确修复方案，绝大多数是设计文档层面的文字改动，应在 Phase 1 动工前完成。

## 0. 总评

设计文档把"主线程不能私吞 reviewer blocker"从约定升级成了状态机，核心组合拳（append-only finding ledger + finding_uid + blob-sha 钉住 + fail-closed material categories + 复用 main_adjudication）是正确的。

但当前版本防的是**懒惰的主线程**（忘了披露、跳过重审），防不住**狡猾的主线程**（改分类、编 user decision、转述洗白）。同时存在一类系统性缺陷：**规则文本引用了机检输入，但没有任何 canonical schema 字段或 producer 合同对该输入负责**。本文档列出全部问题与修复方案。

严重度定义：

- P0：存在绕过整个披露机制的廉价路径，或机制的最终锚点不可信。
- P1：落地后会在真实使用中造成错误 block、不收敛或机检退化为约定。
- P2：实现期会暴露的语义缺口或脆弱点。
- P3：成本与长期退化风险，需要设计层面的对策。

---

## 1. P0 级问题

### P0-1 证据的作者性与持久性全线不可验证（v2 推广：不止 user decision）

**位置**：设计文档 §4.3 `user_review_decision`、§4.4 `review_standing_authorization`、§5 append-only ledger；实现侧 `evidence.ts` 对 `created_by` 仅做字符串字段校验，ledger 输入完全来自磁盘现存文件（`live_pass` / `superseded_ids`）。

**问题**：整个机制的最终锚点是带 `created_by` 声明的 evidence 文件，但所有文件均由主线程落盘。洗白路径按成本从低到高有三条：

1. **删除文件**（最便宜）：ledger 靠扫描磁盘 evidence 文件构建。把 round 1 的 review evidence 和 digest 一起删除，guard 看到的就是一个天然干净的单轮历史。设计文档第 5 节的 "append-only" 是愿望，文件系统层面没有任何机制兜底。
2. **伪造 reviewer 证据**：`created_by:"native-subagent"` 同为自声明字符串。主线程可以不跑 reviewer，直接手写一份 clean review——连用户交互痕迹都不用编。
3. **伪造 user decision**：不问用户、直接落盘 `created_by:"user"` 的 decision，所有 guard 规则通过。

机器层面实际验证的是"现存文件集合的叙事自洽性"，既不验证作者在场性，也不验证历史完整性。设计文档第 13 节成功标准（"任何 blocker 都不能被静默修掉"）相对该现实是过度承诺。

**修复方案**：

1. v1 在设计文档中显式声明信任假设，覆盖全部三条通道："v1 假设主线程不伪造、不删除 evidence；guard 验证的是现存文件的叙事自洽性（结构、引用、新鲜度、历史闭环），而非作者在场性或历史完整性。"同步修正第 13 节成功标准措辞。
2. v1 内低成本加价手段（不解决问题，但把删除式洗白成本从"删一个文件"抬高到"重写一套完整自洽的假历史"）：
   - **引用完整性机检**：任何 evidence 中的 `*_refs` / `supersedes` / `previous_digest_refs` 指向不存在的 evidence_id 即 block——悬空引用等于历史被动过；
   - **round 连续性机检**：`review_round_id` 必须形如 `gate-r1..rN` 连续编号，digest 链长与 round 数一致；删除中间一轮必然造成编号断档或链断裂。
3. v2 把 evidence 锚定到主线程无法单方面重写的载体：
   - 每轮 round 结束后 git commit evidence 目录，guard 校验 evidence blob 存在于 git 历史；或 hash-chain + harness 签名；
   - 用户亲自运行 CLI 命令（如 `superspec decide <finding_uid> --option d ...`）落盘 decision，并附带 agent 无法获取的 nonce / 签名；
   - 与 harness hook / 交互式确认机制集成，由 harness 而非 agent 写 decision 文件。

### P0-2 分类权（category / material_categories）的归属未定义

**位置**：设计文档 §4.1、§10 升级矩阵、§6 guard 规则。

**问题**：fail-closed 逻辑全部建立在 `category` / `material_categories[]` 之上，但文档没有规定这些字段由谁赋值、guard 如何防篡改。若主线程在 ledger 归一化或 digest 编写时把一个 scope blocker 降级为 `category:"implementation"`（非 material），即获得自行处置权——这是比"重跑到 pass"更便宜的新洗白路径，一行分类绕过整个机制。§6 规则 2 只要求"finding 出现在 disclosure 中"（存在性），未要求身份字段一致性。

**修复方案**：

1. 明确分类的唯一 producer 是 reviewer：分类字段必须源自 role review evidence 原文。
2. 新增 guard 规则（加入 §6，并加入 Phase 1 测试清单）：digest / adjudication 中每条 disposition 的 `finding_type`、`category`、`material_categories[]`、`decision_scope_key` 必须与 origin finding **逐字段相等**，不等即 block。
3. reviewer prompt 模板中的分类定义部分使用固定 canonical 模板，guard 校验 `prompt_ref` 内容包含该模板，压缩 prompt 引导空间。
4. 本条与 P1-5（final source_guidance producer contract）是同根问题，建议在设计文档中合并为同一条规则落地。

---

## 2. P1 级问题

### P1-1 「用户可见」没有渲染契约，主线程转述可以洗白

**位置**：设计文档 §4.2、§9.1。

**问题**：digest 是 JSON evidence，用户实际看到的是主线程的转述。`summary` 字段由主线程（或经主线程归一化）书写，一个 scope blocker 可以被转述成无害措辞；用户基于失真信息选了 A，所有 guard 全绿。

**修复方案**：

1. material finding 的用户披露必须包含 reviewer `output_ref` 中的**原文引用**；或要求 digest 的 `summary` 为 origin finding summary 的逐字拷贝，guard 校验相等。
2. 定义最小用户披露格式并写入 skill 模板：finding 原文 + A/B/C/D 选项 + 每个选项的影响面（scope / non-goals / acceptance / tests）。

### P1-2 不动点循环没有终止保证

**位置**：设计文档 §5 规则 4、§6 规则 10。

**问题**：两个具体不收敛场景：

- **accepted deviation 振荡**：rerun 的 reviewer 是无记忆的新 subagent，会把上一轮已被用户裁决为 `accepted_deviation` 的问题重新提出（产生新 `finding_uid`），ledger 又出现未终态 material finding，循环不收敛。§6 规则 10 要求 reviewer 复核为 "known accepted deviation"，但没有承载字段、也没有强制 reviewer 知道历史，规则不可机检。
- **finding_uid 跨轮漂移**：`finding_uid` 含 `origin_review_evidence_id`（每轮更换），同一概念性问题在 ledger 中反复以新 uid 出现；§5 规则 4 的 `supersedes_finding_uids` 把映射责任压给 reviewer，同样依赖 reviewer 看得到历史。

**修复方案**：

1. 强制 **re-review prompt 注入当前 ledger**（全部未终态 findings + dispositions + accepted deviations），作为 `prompt_ref` 内容的机检项。
2. role review evidence 顶层新增 `acknowledged_accepted_deviation_uids[]` 字段；新增 guard 规则："ledger 中存在 accepted_deviation 时，clean round 的 role review 必须在该字段中逐一确认，缺失即该 round 不算 clean。"
3. 新增 max-round 升级路由（详见 P3 / R5）：全量轮预算（建议 3 轮）耗尽仍不 clean 时，guard 强制 route 到用户终局裁决。

### P1-3 final review 无法合法继承前序用户裁决（外部 review 发现，已核实成立）

**位置**：设计文档 §4.2 baseline 规则（L254）、继承表（L289-297）、§8（L495）、Phase 4 测试（L649-651）。

**问题**：文档内部自相矛盾——§8 与 Phase 4 要求 final `finding_adjudications[]` 满足 baseline 规则，但继承表的 target gates 止于 `tasks_complete`，`review_complete` 不在任何一行；该 gate 上又不可能存在 same-gate 的先前 user decision，standing auth 默认排除 material categories。三条腿全断。后果：explore 已裁决过的 scope decision，到 final review 要么重新问用户，要么 block（fail-closed 方向，故维持 P1 不升 P0）。

**修复方案**：

1. 继承表补行：五个早期 gate + `tasks_complete` → `review_complete`；`review_complete` → `archive_ready`（若 archive 启用 disclosure loop）。`tasks_complete` 同时补为合法 source。
2. **根语义**：§7 规定 `review_complete` 的 target root 是 repo root + change root 混合，而 `inherited_target_refs[]` 钉的是 change-root blob。补表时必须规定 inherited refs 按 change root 解析，否则 blob 匹配歧义。
3. **决策 lineage 语义**：继承要求 pinned blob 一致；若 discovery 在后续 gate 被合法修改，原始 decision 钉的旧 blob 失效，继承断裂。需明确：blob 变更后的合法路径是中间 gate 的新 user decision 成为新 baseline，决策沿 digest 链向前滚动。

### P1-4 guard 机检字段没有完整进入 canonical schema（外部 review 发现，已核实成立）

**位置**：设计文档 §5 规则 4（`supersedes_finding_uids` / `successor_finding_uid`）、§6 规则 10（"known accepted deviation"）、§11 末尾（`route` / `route_reason`）；§4.1 / §4.2 canonical 示例均无这些字段。实现侧 `evidence.ts` 仅校验最小 finding 结构。

**问题**：规则要求的机检信息没有 schema 承载，guard 会退化成"靠约定猜"。

**修复方案**：

1. §4.1 findings schema 增加可选 `supersedes_finding_uids[]`。
2. role review evidence 增加 `acknowledged_accepted_deviation_uids[]`（与 P1-2 修复 2 同一补丁）。
3. §4.2 digest 的 `finding_dispositions[]` 增加 `route` / `route_reason`，枚举与 §11 route matrix 对齐。
4. 注意：`route` 字段涉及 `explore_complete` 的 digest schema，**属于 Phase 1 范围**，不可推迟。

### P1-5 final source_guidance 的 material metadata 缺 producer contract（外部 review 发现，已核实成立，含一处修正）

**位置**：设计文档 §4.1（L95）、§8（L502）、Phase 4（L653）；实现侧 `evidence.ts` 对 `blocking_findings` / `non_blocking_findings` 仅要求 `finding_id` 非空。

**问题**：Phase 4 要求 final material finding 带 `category` / `material_categories[]` / `decision_scope_key`，但没有任何合同规定 code-reviewer / architect 产出 source_guidance 时必须写这些字段；normalizer 变不出作者性信息。

**修正**：外部 review 把 `finding_uid` 也列入 producer 缺口，不准确——`finding_uid = gate + origin_review_evidence_id + finding_id` 纯机械可推导，normalizer 自行计算即可。真正的 producer 缺口只有 `category`、`material_categories[]`、`decision_scope_key` 三个字段。

**修复方案**：

1. 扩展 review skill 中 source_guidance 的 finding 合同：每个 finding 必须带 `category`（全量枚举）；命中 material categories 时必须带 `material_categories[]` + `decision_scope_key`；`evidence.ts` 校验同步收紧。
2. 与 P0-2 合并落地：分类源自 reviewer，`main_adjudication.finding_adjudications[]` 身份字段与 origin finding 逐字段相等，不等即 block。

### P1-6 glob target 的 stale 判定缺集合语义（v2 深查新增）

**位置**：设计文档 §3 规则 7、§6 guard 规则 4、§7 target map。

**问题**：`design_complete` 等 gate 的 target 含 `specs/**/*.md` glob。guard 规则 4 只要求 "target_refs 与当前 target map 的 blob sha 精确匹配"——若实现按"逐个 pinned ref 检查其 blob 是否仍新鲜"，则 clean round 之后**新增**一个 spec 文件不会使任何 pinned ref 失效：新文件从未被 pin、从未被审，gate 照样 allow。删除文件同理可能漏判。这是真实的逃逸路径。

**修复方案**：

1. 明确 stale 判定是**集合相等**而非逐项新鲜度：check 时枚举当前 glob 命中集合，要求与 digest pinned 集合完全一致（路径集合 + 逐路径 blob sha）；新增、删除、改动任一项均 stale。
2. `review_complete` 的 "changed repo files" 必须给出 canonical 枚举定义（如 merge-base diff + untracked；未提交文件用 `git hash-object` 现算 blob sha），否则存在同样的集合枚举歧义。与 P2-4 的 `code_fingerprint` 共用同一套定义。

---

## 3. P2 级问题

### P2-1 时间序应全部替换为结构序

**位置**：设计文档 §6 伪代码（`latest_review_round_after_last_target_change`）、§4.3（"created_at 晚于 finding"）。

**问题**：时间戳由 agent 书写，可伪造；工作区文件无可靠 mtime 语义。基于时间排序的"最新 round"判定脆弱。

**修复方案**：v1 排序仅依赖两样结构性事实——`target_refs blob sha == 当前 blob`（round 有效性）+ `previous_digest_refs` 链式引用（round 先后序）。`created_at` 降级为仅作展示用途。同时这与 R1（stale 惰性判定）天然一致。

### P2-2 `decision_scope_key` 自由文本可被复用套利

**位置**：设计文档 §4.1、§4.2 baseline 匹配规则。

**问题**：baseline 复用按字符串相等匹配，主线程可为不同问题刻意复用同一 key 套用旧裁决。blob pinning 已部分缓解（artifact 变更即 baseline 失效），但同 blob 内不同问题仍可套利。

**修复方案**：`decision_scope_key` 首次出现时登记其指向的 finding 原文 ref（语义锚点）；后续复用时 guard 校验锚点一致，不一致即 block。

### P2-3 升级迁移缺口：in-flight change 会被新 guard 追溯 block

**位置**：设计文档 Phase 5（仅覆盖历史 change 的 review-only backfill）。

**问题**：新 guard 上线瞬间，已通过 `design_complete` 等 gate 的进行中 change 会因缺 digest 被追溯 block，升级日全员卡死。

**修复方案**：按 `schema_version` 或 change 创建时间做 grandfathering：升级前已通过的 gate 维持原判定口径，升级后新进入的 gate 启用 disclosure 检查。写入 Phase 5。

### P2-4 final test freshness 缺身份模型（外部 review 发现，已核实成立，修复方向需纠偏）

**位置**：设计文档 §7 target map（"final test output refs"）、§8 `adjudication_target_refs[]`；实现侧 `final_test` evidence 仅有 `test_command` + `output_ref` 路径校验。

**问题**：stale-check 拿什么比对未定义；`output_ref` 是日志路径，不是稳定 pinned target。

**修复方向纠偏**：给 output_ref 加 content hash 是错误解法——日志 hash 只能证明"日志没被改"，证明不了"测试跑在当前代码上"。正确的 freshness 语义是后者。

**修复方案**：

1. `final_test` evidence 增加 `code_fingerprint`（运行时 changed-files 的 blob sha 集合或 tree sha）+ `output_sha256`。
2. `main_adjudication` 通过 `verification_evidence_refs` 引用 final_test 的 **evidence_id**，而非把日志路径塞进 target refs。
3. stale 判定 = `final_test.code_fingerprint != 当前 changed-files 指纹`。§7 target map 中 `review_complete` 行的 "final test output refs" 改写为 "final_test evidence (by code_fingerprint)"。

### P2-5 损坏/不可解析的历史 evidence 会永久 block，缺修复路径（v2 深查新增）

**位置**：设计文档 §5（ledger 按 fail-closed 扫描全部历史 evidence，含 superseded）。

**问题**：若某个历史 evidence 文件 JSON 损坏或 schema 无效，要么 ledger 构建失败，要么挂着永远无法终态的 finding——change 永久 block 且没有任何合法修复出口。§4.2 允许 superseded 纠错，但旧文件仍在 ledger 输入集中，问题不消失。

**修复方案**：定义 correction digest 纠错路径——引用损坏 evidence 的路径与文件 sha，经**用户确认**后逐条重申或作废其中的 findings；guard 在存在覆盖该文件的 correction digest 时跳过原始文件解析。不允许主线程单方面跳过损坏文件。

---

## 4. P3 级问题与轮次经济模型（Round Economy）

### 问题描述

1. **重审成本**：每轮 fixed-point 循环 = 多角色 subagent 重跑（`design_complete` 一轮 3 个角色）；按 §3 规则 7 的措辞，artifact 任何一字节改动都使 round stale，若被实现为"修改即触发重审"，成本高且慢，并催生反模式——主线程囤积修改以减少重审次数。
2. **process fatigue → standing authorization 泛化**：用户被频繁打断后倾向签发宽泛授权，机制退化回原状。
3. **A/B/C/D 选项 explore 中心化**：C（"先补 discovery"）在 `test_contract_drafted` 等 gate 语义不通；选项与 §11 route matrix 是平行的两套枚举，应统一。

### 修复方案：轮次经济五规则

**R1 stale 是惰性判定，不是触发器。**改写 §3 规则 7：stale 只在 `check-enter` 时刻惰性计算（`round.target_refs blob sha != 当前 blob` → 该 round 不可用）；编辑期间 guard 不介入。判定纯靠 sha 比对，与 P2-1 一致。

**R2 批处理协议：每 gate 标准节奏为 2 轮。**写入 skill 模板作为强制流程：

1. Round 1（全量审）：所有 required roles **并行**跑一次（角色间无依赖，wall clock = 1 次 review）；
2. 一次性归集：全部 findings 进同一份 digest，全部 `needs_user_decision` material findings 合并为**一个**用户 checkpoint，一次交互逐 finding 给 A/B/C/D；
3. 一次性修改：拿到全部裁决后批量完成所有 artifact 修改；
4. Round 2（收敛审）：再跑一轮，正常 clean，gate 过。

典型成本固定为：每 gate 2 轮 review + 1 次用户交互。

**R3 第 2 轮起使用增量审查合同。**Round k>1 的 reviewer prompt 必须注入（机检 `prompt_ref` 内容）：上一轮全部 findings + dispositions、两轮 blob 之间的 artifact diff、当前 ledger 全部 accepted deviations。reviewer 任务收窄为：确认 fixed 项已修、在 `acknowledged_accepted_deviation_uids[]` 中逐一确认已接受偏差、只对 diff 区域与遗漏的 material 问题提新 finding。R3 同时是成本优化和收敛性保障（解决 P1-2 的振荡问题），一个机制两份收益。

**R3 的锚定风险与对策（v2 深查新增）**：向 reviewer 注入上一轮 dispositions 会引入锚定偏差；且注入内容若由主线程自由书写，等于把"reviewer 看到什么历史"的控制权交回主线程。两条强制对策：

1. ledger 注入文本必须由工具命令**确定性生成**（如 `superspec ledger render --gate ...`），guard 对 `prompt_ref` 中该段做逐字节校验，主线程不得增删改；
2. 增量合同必须写明 reviewer 的验证义务：对 `fixed` 项必须对照 diff 验证修复事实，不得采信 disposition 的文字声明。

**R4 明确拒绝两个伪省钱捷径**（写入非目标）：

- "trivial edit 豁免"不能开：trivial 由主线程判定，等于重开洗白通道；正确做法是用 R3 把重审成本压到可忽略。
- "只重跑提出 finding 的角色"不能开：scope 裁决会改变其他角色结论（test-engineer 的验收口径依赖 critic 确认的范围）；clean round 上 required roles 必须齐，用 R2 并行执行消化 wall clock 成本。

**R5 轮次预算 + 升级路由。**每 gate 全量轮预算建议 3 轮；耗尽仍不 clean 时 guard 强制 route 到用户终局裁决（剩余未终态 findings 整体披露、逐条拍板）。在 §11 route matrix 新增 `escalate_round_budget` route。

**针对 fatigue 的附加规则**：standing authorization 不允许覆盖 `finding_type:"blocker"`，只能按 category 授权——blocker 永远要么修复要么用户裁决。

**针对选项枚举的附加规则**：为每个 gate 定义 A/B/C/D 选项模板，并与 §11 route matrix 统一为一套枚举（C 实质是 route 的用户可选形式，不应平行存在两套）。

---

## 5. 元观察：两个系统性缺陷类与可追溯性检查

本审查发现的问题集中在两个失败类：

1. **规则先行、schema 滞后**（P1-3 / P1-4 / P1-5）：规则文本引用了机检输入（继承表缺行、字段缺定义、分类缺作者），但无 canonical schema 字段或 producer 合同对其负责。
2. **机制依赖文件系统事实，但文件系统无完整性保障**（P0-1 / P1-6 / P2-5）：删除（历史可被抹掉）、伪造（作者性自声明）、损坏（无纠错出口）三种形态，外加 glob 集合枚举不闭合。

人眼审查无法穷尽这两类问题。

**修复方案**：设计文档落地前增加一次性**可追溯性检查**——为 §6 的 12 条 guard 规则逐条标注：

```text
guard 规则 → 输入字段 → 所在 canonical schema 章节 → producer（reviewer / main thread / user / normalizer 推导）
```

任何一条标注不出来的，就是下一个同类缺陷。该表完成后可直接转化为 Phase 1 的 schema 完备性测试清单。

---

## 6. 修复优先级与落地顺序

**Phase 1 动工前必须完成的设计文档改动**（全部为文字工作量）：

1. P0-1 信任假设声明（覆盖删除/伪造/损坏三通道）+ 成功标准措辞修正；引用完整性 + round 连续性机检写入 §6 guard 规则；v2 锚定通道预留。
2. P0-2 / P1-5 合并：分类 producer 合同 + 身份字段逐字段相等的 guard 规则。
3. P1-4 中 Phase 1 范围的 schema 字段：digest `route` / `route_reason`、role review `acknowledged_accepted_deviation_uids[]`、findings `supersedes_finding_uids[]`。
4. P1-2 / R3：ledger 注入 re-review prompt 的机检要求 + R3 锚定对策（工具生成 ledger render、reviewer 验证义务）。
5. P1-1 用户披露渲染契约（写入 explore skill 模板）。
6. P1-6 集合相等 stale 语义（explore 虽是单文件 target，语义必须先写对，避免 Phase 2/3 沿用错误判定）。
7. P2-1 / R1：排序去时间化、stale 惰性判定措辞。
8. §4 新增"轮次经济"一节（R2 / R5），R4 写入非目标。
9. 第 5 节元观察的可追溯性表。

**Phase 4 语义但必须现在改文档的**（否则 Phase 1-3 产出的 schema 与 Phase 4 需求对不上，返工成本更高）：

1. P1-3 继承表补行 + 根语义 + 决策 lineage。
2. P2-4 final_test 身份模型（`code_fingerprint`）。

**Phase 5 补充**：P2-3 grandfathering 规则、P2-5 correction digest 纠错路径。

**残余风险声明**（修完上述全部问题后仍存在、需在文档中明示）：v1 的 guard 验证现存文件的叙事自洽性，不验证作者在场性与历史完整性（P0-1 的 v1 接受项；引用完整性/round 连续性机检只加价、不消除）；reviewer 分类质量本身不在本设计证明范围（设计文档原有非目标，维持）。
