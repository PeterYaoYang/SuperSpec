---
name: superspec-propose
description: "二.编写计划文档（proposal/specs/design/tasks）"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Propose

你是计划阶段。职责：把探索结论转化为可执行的计划——写 proposal.md / specs / design.md / tasks.md + business-invariants.md + test-contract.md。

## 驱动方式

所有状态由工作流引擎管理：

1. `superspec transition next --change "<change>"`
2. 执行返回的命令、工作项或用户确认
3. 用户确认用 `superspec record user-decision --change "<change>" --input -`；工作项审查报告用 `superspec record job-submit --change "<change>" --job <JOB> --report -`（文件路径模式仍可作为 fallback）
4. 回到第 1 步

进入下一阶段前，必须先处理 next 返回的用户确认、审查或验证事项。默认完整审查路径下，进入实现前会要求 `critic`、`architect`、`test-engineer` 三个独立审查工作项完成；审查必须由独立角色执行，不能由主流程自审代替，报告按工作流返回的格式提交并记录实际审查来源。

什么问题需要用户确认，判定标准见「待用户确认」一节；就绪或审查后向用户只概括任务可验证性、关键风险/证据覆盖和下一步。

执行 propose-ready 前，对照 critic / architect / test-engineer 的阻塞条件快速自检（非穷尽）：Impact 与 CHAIN/IDC 对账、specs 增量与 proposal 能力变化互相对应、design 的功能点与实现方案能推出 tasks、DEC 已有行内结论并回写、task 粒度单一行为且顺序可执行、每个普通 TDD task 有完整可定位的 `执行依据:`（声明的 TEST 都存在于 test-contract，`边界`/`原因` 具体到该 task 而非套话）、不变量可证伪且覆盖核心行为变化、test-contract 覆盖 Impact 引用的 CHAIN、test-contract 中未绑定任何 task 的 TEST 有明确取舍（绑定到 task 或留待用户豁免决策）。自检不替代审查工作项，只为减少驳回往返。

人类可读正文默认使用简体中文；OpenSpec 结构标题、规范关键字、命令、路径、JSON 字段、代码标识符保留原文。OpenSpec 生成文档语言不符合预期时，先检查 `openspec/config.yaml` 的官方 `context` 设置；不要在变更文档里添加自定义 `language` 字段。

路径/锚点写法：proposal/design/tasks/test-contract 正文里的代码区域和源码证据默认使用短写法，例如 `MatchingProcessor`、`AttendanceReportCalculationRuleController#getSelectShiftBlockStrategy`、`ShiftBlockMatchStrategyType.java:8`。不要写绝对路径，也不要反复写项目相对长路径；只有短名在当前仓库无法唯一定位时，才加最短必要目录前缀（如 `meta/ShiftBlockMatchStrategyType.java:8`）。文档引用仍须带文件名前缀，例如 `design.md#Verifier 文档绑定：沿用现有校验入口`、`test-contract.md#TEST-001`、`specs/review/spec.md#verifier 绑定`；CLI 参数、job packet、JSON 报告字段和 `.superspec/artifacts/...` 补充材料路径仍按协议保留原始路径。

## 本阶段做什么

### proposal.md
严格使用 `openspec instructions proposal` 给出的原生结构。`proposal.md` 用于说明为什么需要这个 change、准备改变哪些能力、范围边界和影响面，不负责定义具体实现方案。

规则：
- `Why` 只说明当前问题、机会、造成的影响和现在需要处理的原因，不提前给出解决路线
- `What Changes` 以用户或系统可辨识的能力变化为粒度，说明新增、修改或移除什么，已知破坏性变化按 OpenSpec 要求标记 `**BREAKING**`；`Capabilities` 只按原生 New / Modified 分类登记精确 capability 名称和简述，不自创分类
- 能力变化只描述目标结果和范围，不展开 requirement / scenario，也不写类、函数、字段、算法、数据流、调用顺序或复用机制；这些内容分别属于 specs 和 design
- 可以说明必须保持不变的相邻能力、兼容边界和高层发布影响，但不为完整而编造非目标；具体顺序、回滚步骤和技术方案属于 design
- `## Impact` 必须能看出受影响范围和原因，写成：

```markdown
| Area | Reason |
|---|---|
| review.ts | 需要核对 verifier 如何绑定文档和执行证据 |
```

- `Area` 可以写代码区域、API、依赖、系统、配置或文档；优先使用模块、类、接口等简短定位，不写成待修改文件白名单
- `Reason` 只解释该范围为什么受影响、会暴露什么变化或承担什么兼容责任，不展开具体实现方案
- discovery 含 `## 输入数据来源核查` 的 IDC 项时，相关 `Reason` 须引用对应 `IDC-xxx` 状态（`已证明` / `未知阻塞` / `未知非阻塞`）
- discovery 含 `## 链路五要素` 时，`## Impact` 须与非 `未知阻塞` 链路行中已确证的下游消费者 / 视图差异对账：受本次改动影响的写入 Area / Reason 并引用对应 `CHAIN-xxx`；不受影响的写明排除理由，可按组书写，排除理由不回写 discovery.md。对账不要求逐行进入 Impact；同一链路已由 `IDC-xxx` 覆盖时，引用其一并注明对应即可
- 不写设计决策、字段归属、测试场景、RED/GREEN 过程、任务拆分、文件修改顺序或执行日志

### specs/
严格使用 `openspec instructions specs` 给出的增量格式。`specs/` 定义 change 完成后系统必须满足的长期行为契约，回答“系统应表现为什么”，不回答“内部如何实现”。

规则：
- `specs/` 只放 Markdown 规范文件，非 `.md` 文件不纳入审查绑定
- `proposal.md` 声明的每个能力变化都有对应规范增量；specs 不引入 proposal 未声明的能力变化
- ADDED / MODIFIED / REMOVED / RENAMED 的选择以 `openspec/specs/` 中是否已存在对应 requirement 为依据，不以代码是否已经存在为依据；MODIFIED 必须包含完整更新后的 requirement，REMOVED 必须提供 Reason / Migration，RENAMED 必须提供 FROM / TO
- 每条 requirement 定义一个可独立理解的行为规则，并至少包含一个符合 OpenSpec 格式的 scenario
- requirement / scenario 按归档后的目标状态书写，不使用「本次改动」「新增规则」「旧有行为」「变更前」「继续保持」等依赖变更历史的表述；OpenSpec 增量结构标题照常使用
- 只写可观察行为、公开接口契约和会改变业务结果的稳定语义；私有类、函数、仅服务于当前实现的内部字段、处理阶段、复用机制和清理步骤属于 design。内部数据若构成稳定的跨模块契约或会改变可观察结果，specs 写其语义约束，具体承载方式仍由 design 定义。判断标准是：更换内部实现后仍必须成立的规则属于 specs，只有采用某种实现方式时才成立的内容属于 design
- scenario 应明确前置条件、触发行为和确定的可观察结果；强制性结果直接使用清晰、可判定的自然语言说明“必须做到什么”或“不得发生什么”，不依赖特定规范关键词，也不使用模糊的多选表达或「保持原有行为」代替可判定结论。只有可选性本身属于契约时才写成可选，并同时说明允许范围和始终成立的不变量
- 一个 scenario 可以包含同一触发下紧密相关的一组结果，但不得混合多个能够独立失败的责任边界
- 同一业务规则只保留一个权威 requirement；不同边界情况作为其 scenario，不重复建立语义重叠的 requirement
- 不写实现路线、测试代码、测试命令、测试数据准备过程或文件修改清单

### design.md
`design.md` 说明“怎么实现”：审查者从目录能看出涉及什么功能、各自采用什么路线；实现者从正文能读出实现机制、影响边界和不能自行决定的关键契约。

```markdown
# 设计

## 背景
<本次变更要解决的设计问题，以及会影响技术路线的现状和约束>

## 设计目标
<本次方案必须达成的技术能力、质量属性和边界>

## 非目标
- <明确不处理的能力或路线，以及边界原因>

## 总体方案
<用 2～5 句说明各功能点的关系、主要数据流或调用关系>

## 实现方案

### <功能点、运行阶段或系统边界>：<采用的技术路线或实现结论>
<用自然段、表格、流程图或必要的伪代码说明实现方式>

<!-- 可选：本方案存在真实可行且容易误走的替代路线时保留 -->
**不采用：** <替代路线> — <不采用原因>

<!-- 可选：同一取舍横跨多个功能点时保留，否则优先写在对应方案内 -->
## 整体方案取舍
| 方案 | 收益 | 代价 | 结论 |
|---|---|---|---|
| <方案> | <收益> | <代价> | <采用或放弃原因> |

<!-- 可选：同一契约被多个功能点共享时保留，局部契约写在对应方案内 -->
## 关键契约

### <契约名称>
<数据、接口、状态、优先级或一致性规则>

<!-- 可选：选定方案仍有非显然风险或明确接受的代价时保留 -->
## 风险 / 取舍
| 风险或代价 | 影响 | 缓解或验证 |
|---|---|---|
| <风险> | <可能结果> | <控制方式或测试映射> |

<!-- 可选：存在阻塞确认项时保留，并使用本文“待用户确认”的 DEC-xxx 格式 -->
## 待用户确认
- [ ] DEC-xxx <阻塞决策>
```

规则：
- 写 design 前对照 discovery / proposal / specs，把影响实现的事实和约束转成具体安排；不记录调查过程，不复制 Impact、specs 行为、discovery 证据或 tasks 拆分。
- `## 实现方案` 是主体。代码影响型需求必须能映射到可定位的方案，但不要求需求与小节一一对应；紧密相关需求可以共用方案，只有存在独立技术路线时才拆分。
- 方案按业务功能、运行时阶段或系统边界组织。标题同时写明“针对什么”和“怎么实现”，例如 `班段内最新入/最早出：复用既有 START/END 选择策略`；不要只写“策略复用”“数据处理”“接口调整”等泛称。
- 每个方案整体说明实现机制、影响范围、设计依据和边界约束；不要求固定字段，只写本次实际涉及的数据、接口、流程和运行边界。共享契约集中定义一次，其他方案引用。
- 当本次 change 确实新增或改变行为、数据语义、接口兼容、状态、优先级、一致性、并发或恢复结果，且不同选择会影响已声明验收时，才明确对应契约；未改变的既有语义不重新设计。可以使用必要的模块、接口、表 / 字段、关键函数、数据流、状态机、优先级矩阵和简短伪代码。
- 声明“复用现有逻辑”或“保持行为不变”时，说明复用对象、接入位置、本次差异和需要保持的语义，不能只写抽象结论。
- 复用现有基础设施或通用机制时，只设计本次接入和差异，不重新证明或升级该机制的一般可靠性。除非用户、proposal 或 specs 明确提升对应质量等级，不新增未经确认的基础设施、可靠性模式或版本协调机制。
- 可以描述运行时算法、数据 / 控制流、状态转换和事务顺序；不写逐行代码、完整 SQL、文件修改顺序、task、测试命令或 RED/GREEN 步骤。
- discovery 的 `## 输入数据来源核查` 影响方案时，分别写清 producer→consumer 的输入完整性和 consumer 处理方式；相关 `IDC-xxx` 为 `未知阻塞` 时 design 不得 ready。
- discovery 含 `## 链路五要素` 时，方案不得违背已确证链路事实。design 可以引用 CHAIN 解释路线；若发现 Impact 未记录的消费者、视图差异或用户 / 系统可观察行为影响，先回写 Impact，再进入 test-contract 映射。
- `## 非目标` 和 `## 总体方案` 必须生成：非目标写最容易被误认为本次范围的相邻能力或技术路线，不编造无关项；总体方案用 2～5 句概括功能点关系、主要数据流或调用关系，不展开任务步骤。
- 模板中的可选注释只用于判断是否生成，不写入成品。替代路线、整体方案取舍、关键契约、风险 / 取舍与回滚没有真实内容时连标题一起省略；替代路线优先写在对应方案内，只有横跨多个功能点时才集中说明；只有阻塞确认项才追加 `## 待用户确认`。

### tasks.md
使用 OpenSpec tasks 原生分组结构。每个顶格 checkbox 行是一个 SuperSpec 可执行 task，Markdown 标题只用于分组。

```markdown
# Tasks

## Review verifier

- [ ] 1.1 检查 verifier 绑定文档 tdd_required:true
  执行依据:
  - 测试: test-contract.md#TEST-001
  - 设计: design.md#Verifier 文档绑定：沿用现有校验入口
  - 来源: proposal.md#Impact；specs/review/spec.md#verifier 绑定
  - 原因: 独立可验收行为，可由 TEST-001 验收
  - 边界: 保持既有 job 提交协议不变
- [ ] 1.2 检查 verifier 绑定执行证据 tdd_required:true
  执行依据:
  - 测试: test-contract.md#TEST-002,TEST-003
  - 设计: design.md#执行证据核对：复用现有证据链
  - 来源: proposal.md#Impact；discovery.md#CHAIN-001
  - 原因: 证据核对与文档绑定是两个独立验收入口
  - 边界: 不改变历史证据的判定语义

## Documentation

- [ ] 2.1 更新文档 tdd_required:false no_tdd_reason:documentation-only
```

规则：
- 每个普通 TDD task（`tdd_required:true`）必须紧跟一个 `执行依据:` 块，包含五个字段：`测试`（该 task 必须兑现的 test-contract 场景，引用 `test-contract.md#TEST-xxx`，多个用逗号合并）、`设计`（执行路线在 `design.md` 的位置或短摘录）、`来源`（task 产生依据，如 `proposal.md#Impact`、spec delta、`discovery.md#CHAIN-xxx,IDC-xxx`，已有明确文件路径的补充材料用 `.superspec/artifacts/...`）、`原因`（为什么单独拆出这个 task）、`边界`（执行时需要保护的边界）
- `执行依据:` 必须紧跟所属 task 行（中间最多允许一个空行）；字段不得重复；块内不得出现 checkbox（`- [ ]` / `- [x]`），否则会变成无人执行的暗任务并被引擎拒绝
- `设计`、`来源` 的标题或短摘录引用必须使用带文件名前缀的可定位格式，如 `design.md#...`、`proposal.md#...`、`specs/.../spec.md#...`；只有 ID 型引用（TEST/CHAIN/IDC）可以逗号合并。`边界` 默认直接写可对照 diff 的具体保护语义，不需要文件前缀；只有主动引用既有文档原文时才写对应文件和锚点
- 声明的每个 `TEST-xxx` 必须存在于 `test-contract.md`，否则 `propose-ready` 和 `start-apply` 会被阻断
- 五个字段的内容必须针对该 task 具体可核验，执行者和审查者要拿它们对照实现：`边界` 写出改动不应触碰的具体行为、模块或语义（能对着 diff 判断有没有越界），不写"不破坏现有功能"这类放在任何 task 上都成立的套话；`原因` 说明这个 task 独立存在的理由，不写"需要单独实现"；不同 task 的执行依据不应互相复制
- 写不出可定位的 `设计` 引用时，说明 `design.md` 缺少该 task 的实现方案或边界约束——先补设计，不编造引用
- 单个 task 声明的测试超过 3 个时，`原因` 必须说明为什么不再拆分
- `tdd_required:false` task 可以写执行依据，`测试` 字段按需填写；特征化任务（characterization task，指为固化既有行为而写保护测试、不引入新行为的任务）用 `tdd_required:false no_tdd_reason:characterization` 标记，只有这类任务可以在执行阶段以特征化通过作为测试证据
- `REVIEW-FIX-*` task 由引擎在审查返工时追加，不需要手写执行依据
- `<task_id>` 可以是 `1.1` 或 `TASK-001.1`，必须唯一、稳定；标题不要包含 task id token，例如不要写 `## 1.1 Review verifier`
- task 内部步骤用普通 bullet，不用缩进 checkbox——引擎只解析顶格 checkbox 行，缩进的会变成无人执行的暗任务
- `tdd_required:true`（默认）——改运行时代码/业务逻辑/权限/外部接口
- `tdd_required:false` + `no_tdd_reason:xxx`——纯文档/配置/机械改名/生成物
- task 行只标记是否需要 TDD，不写 RED/GREEN 命令、断言或预期输出；实际 RED/GREEN 由 apply 阶段执行并记录
- 一个 task 对应一个可独立验证的行为变化，或一个明确的非行为改动
- 多个行为变化、入口或运行时模块不能形成同一个 RED/GREEN 闭环时拆开；需要“顺便”改多个不相邻模块的 task 在 propose 阶段就拆分或补充任务，不留到 apply 阶段扩大范围
- 任务按可执行顺序排列：引擎忽略标题、按全文顶格 checkbox 行的先后顺序逐个驱动执行，被依赖的任务必须排在依赖它的任务之前，跨组同样如此（顺序与分组冲突时调整任务归组或拆组）；跨组依赖可在任务行内注明依赖的 task id 作为提示，但注明不改变执行顺序

### business-invariants.md
格式：

```markdown
# Business Invariants

- INV-001 用户密码必须加密存储
- INV-002 订单金额不能为负数
```

规则：
- 不变量是本次改动必须保持或新确立的业务规则，必须可违反、可验证——存在能让它失败的具体操作和可观察结果；「系统应稳定」「代码应可维护」这类不可证伪的陈述不算
- 覆盖本次行为变化触及的核心规则即可，不堆砌与本次改动无关的通用约束

### test-contract.md
格式：

```markdown
# Test Contract

| test_id | invariant | scenario |
|---|---|---|
| TEST-001 | INV-001 | 注册时提交明文密码，落库字段为加密值且不含明文 |
| TEST-002 | INV-002 | 已登录用户提交金额为 -1 的订单，下单被拒绝并返回校验错误 |
```

scenario 写到能推导断言的程度：给定什么条件、发生什么动作、观察到什么结果；不写测试命令和断言代码。「验证功能正常」这类无法推导断言的写法不合格。

如果 discovery 含 `## 输入数据来源核查` 的 IDC 项，在测试表后增加 `## 输入数据覆盖验证`：

| 核查ID | 验证方式 | 输入链路声明 | 证据或计划 |
|---|---|---|---|
| IDC-001 | 源码锚点 + 聚焦测试 | producer 产生的目标输入会进入 consumer | path.ts:10 + TEST-001 |

证明方式可用源码锚点、fixture、targeted test、日志或 trace，须说明证明力；不强制集成测试。只证 consumer 算法、没证 producer→consumer 输入完整性，测试契约不足。

discovery 含 `## 链路五要素` 时，`proposal.md` `## Impact` 中引用的 `CHAIN-xxx` 应映射到测试场景（scenario 内引用对应 `CHAIN-xxx`），或在测试表后写明不覆盖理由。design 只引用 CHAIN 作为方案依据时不重复产生映射要求；若 design 暴露新的消费者、视图差异或用户 / 系统可观察行为影响，先补入 Impact，再按同一规则映射测试。

### 待用户确认
遇到会影响需求范围、验收标准、用户可见行为、方案取舍、测试策略、安全、权限、数据判断的关键不确定问题，先写入相关计划文档的 `## 待用户确认` 段落；没有阻塞确认项的文档不加该段落：

```markdown
## 待用户确认

- [ ] DEC-001 [方案] 是否需要兼容历史行为？影响：验收口径（CHAIN-003）。选项：A 兼容（加开关、保留旧路径）/ B 不兼容。建议 A：存量数据仍被报表消费
```

每个确认项只含一个决策点，带稳定 ID `DEC-xxx`：决策类写明影响面（引用相关 `CHAIN-xxx` / `IDC-xxx`）、候选项及后果、建议默认值及理由；事实类写明需要用户提供什么信息、为什么阻塞。选项和补充说明用普通文本或普通 bullet，不要写成 `- [ ]`，引擎会把它们计为未确认项。

`next` 会在 propose 阶段检查 `proposal.md`、`design.md` 和 `test-contract.md` 的该段落。存在未确认项时，汇总一次向用户提问（按影响排序并说明问题间依赖，不逐个往返）；收到回答后用驱动方式中的 `record user-decision` 命令登记，JSON 经 stdin 传入（scope 建议引用 `DEC-xxx`，一条决策可列多个 ID；此为留痕约定，引擎不校验格式）。

答案来自用户时，先登记再勾选；答案来自需求文档、代码证据等外部事实核对时，行内写明证据来源，不伪造用户决策。用户回答含糊、与候选项不匹配或引出新问题时，不视为已确认；复述理解并获得明确答复后再登记。把结论反映到 proposal/design/test-contract 相关内容，勾选行内注明结论要点；确认项作废或重复时改为 `[x]` 并注明理由，不要删除确认项。局部实现细节、命名、普通文件组织和不影响需求/验收/风险的技术微调不要升级为用户确认。

进入 propose 后出现新的业务规则、产品口径、验收标准、示例规范或需求源更新时，不要静默覆盖原计划；默认先在 `proposal.md` 记录 `## 需求变化`，说明变化来源、变化内容、受影响能力、直接修改的文档章节、确认保持不变的范围和处理方式（更新当前 change / 新建后续 change / 暂不处理）。该段是后续增量审查判断“本轮变化”的权威锚点；不得把未受影响的历史设计重新列为本轮待审范围。只有影响技术路线、测试契约或业务不变量时，才同步更新 `design.md`、`test-contract.md` 或 `business-invariants.md`。

审查报告是待验证的独立意见，不会自动创造新需求。主流程处理 finding 时先分离 underlying problem 与 recommendation：根据本次 change 的目标、直接证据和明确验收独立判断问题是否成立；问题成立时选择满足既有需求的最小修复。Recommendation 只是非绑定建议，不是验收标准；与用户决定、已确认复用路线或 `## 非目标` 冲突的具体方案不实施，也不得仅为通过审查增加未经确认的基础设施、兼容、额外任务、故障场景或测试义务。若 reviewer 指出的事实证据证明现有方案无法满足用户已确认的强制需求、规格约束或明确验收结果，补足对应结果、契约或证据，而不是默认采用 reviewer 指定的架构；Reviewer 不得自行新增或升级强制要求。

## 完成条件

tasks.md 作为计划文档就绪（不是复选框全完成）+ 基础职责文档齐全 → next 返回 propose-ready 命令。

## Guardrails

- 只产出计划文档，不改业务代码、不做实现
- 不绕过 `## 待用户确认` 中的未确认项
- tdd_required 标注真实
- 不跳过 transition
- 不跳过完整审查路径下的审核工作项
- 审查通过后、推进前不做非必要的文档编辑；绑定审查的内容（proposal/design/tasks/specs/discovery/business-invariants/test-contract）变更会作废已通过的审查并触发重审。
