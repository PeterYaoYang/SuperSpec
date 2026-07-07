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

执行 propose-ready 前，对照 critic / architect / test-engineer 的阻塞条件快速自检（非穷尽）：Impact 与 CHAIN/IDC 对账、specs 增量与 proposal 能力变化互相对应、design 路线能推出 tasks、DEC 已有行内结论并回写、task 粒度单一行为且顺序可执行、不变量可证伪且覆盖核心行为变化、test-contract 覆盖已引用的 CHAIN。自检不替代审查工作项，只为减少驳回往返。

人类可读正文默认使用简体中文；OpenSpec 结构标题、规范关键字、命令、路径、JSON 字段、代码标识符保留原文。OpenSpec 生成文档语言不符合预期时，先检查 `openspec/config.yaml` 的官方 `context` 设置；不要在变更文档里添加自定义 `language` 字段。

## 本阶段做什么

### proposal.md
使用 OpenSpec proposal 原生结构，说明为什么做、做什么、能力变化和影响范围。`## Impact` 段落必须能看出受影响范围和原因，推荐写成：

```markdown
| Area | Reason |
|---|---|
| src/review.ts | 需要核对 review verifier 如何绑定文档和执行证据 |
```

规则：
- `Area` 可以写代码区域、API、依赖、系统、配置或文档；不作为路径白名单
- `Reason` 只解释为什么该范围受影响，不写详细实现方案
- discovery 含 `## 输入数据来源核查` 的 IDC 项时，相关 `Reason` 须引用对应 `IDC-xxx` 状态（`已证明` / `未知阻塞` / `未知非阻塞`）
- discovery 含 `## 链路五要素` 时，`## Impact` 须与非 `未知阻塞` 链路行中已确证的下游消费者/视图差异对账：受本次改动影响的写入 Area/Reason 并引用对应 `CHAIN-xxx`；不受影响的在 `## Impact` 中写明排除理由（可按组书写，排除理由不回写 discovery.md）。对账不要求逐行进入 Impact；同一链路已由 `IDC-xxx` 覆盖时，引用其一并注明对应即可
- 不写任务拆分

### specs/
OpenSpec 能力规范增量（`openspec instructions specs` 格式）。

规则：
- `specs/` 只放 Markdown 规范文件，非 `.md` 文件不纳入审查绑定
- `proposal.md` 声明的每个能力变化都有对应规范增量；specs 不引入 proposal 未声明的能力变化
- 规范写系统应满足的行为要求和场景，不写实现路线（实现路线属于 design.md）
- specs 归档时会合入长期规范，是本次变更留下的长期资产：requirement / scenario 正文按变更后的目标状态书写，不写「本次改动」「原来是 X 现在改成 Y」这类过程性描述；OpenSpec 增量结构标题（ADDED/MODIFIED/REMOVED/RENAMED）照常使用

### design.md
使用 OpenSpec design 原生结构，写技术方案、关键决策、替代方案和风险取舍。

规则：
- 每个代码影响型需求说明采用的路线，如复用现有链路、改接口、加表、发消息、定时任务或查询聚合
- 实现方向只到路线级；不写字段名、函数名、SQL、类名或逐步代码。路线无法确定时写入 `## 待用户确认`
- 不复制 `proposal.md` 的影响范围表
- 不写任务拆分
- discovery 含 `## 输入数据来源核查` 且影响设计成立时，记录输入完整性决策；相关 `IDC-xxx` 为 `未知阻塞` 时设计不得标 ready
- discovery 含 `## 链路五要素` 时，实现方向不得基于与已确证链路事实不符的现状假设，例如上游已完成的处理在下游重做兜底（确需重复防御时写明理由）；有意变更已确证的规则变形或持久化语义时，在 design.md 写明该变更属于本次目标

### tasks.md
使用 OpenSpec tasks 原生分组结构。每个顶格 checkbox 行是一个 SuperSpec 可执行 task，Markdown 标题只用于分组。

```markdown
# Tasks

## Review verifier

- [ ] 1.1 检查 verifier 绑定文档 tdd_required:true
- [ ] 1.2 检查 verifier 绑定执行证据 tdd_required:true

## Documentation

- [ ] 2.1 更新文档 tdd_required:false no_tdd_reason:documentation-only
```

规则：
- `<task_id>` 可以是 `1.1` 或 `TASK-001.1`，必须唯一、稳定；标题不要包含 task id token，例如不要写 `## 1.1 Review verifier`
- task 内部步骤用普通 bullet，不用缩进 checkbox——引擎只解析顶格 checkbox 行，缩进的会变成无人执行的暗任务
- `tdd_required:true`（默认）——改运行时代码/业务逻辑/数据迁移/权限/外部接口
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
| IDC-001 | 源码锚点 + 聚焦测试 | producer 产生的目标输入会进入 consumer | src/path.ts:10 + TEST-001 |

证明方式可用源码锚点、fixture、targeted test、日志或 trace，须说明证明力；不强制集成测试。只证 consumer 算法、没证 producer→consumer 输入完整性，测试契约不足。

discovery 含 `## 链路五要素` 时，`proposal.md` `## Impact` 中引用的 `CHAIN-xxx` 应映射到测试场景（scenario 内引用对应 `CHAIN-xxx`），或在测试表后写明不覆盖理由。

### 待用户确认
遇到会影响需求范围、验收标准、用户可见行为、方案取舍、测试策略、安全、权限、数据或迁移判断的关键不确定问题，先写入相关计划文档的 `## 待用户确认` 段落；没有阻塞确认项的文档不加该段落：

```markdown
## 待用户确认

- [ ] DEC-001 [方案] 是否需要兼容历史行为？影响：迁移成本与验收口径（CHAIN-003）。选项：A 兼容（加开关、保留旧路径）/ B 不兼容（一次性迁移）。建议 A：存量数据仍被报表消费
```

每个确认项只含一个决策点，带稳定 ID `DEC-xxx`：决策类写明影响面（引用相关 `CHAIN-xxx` / `IDC-xxx`）、候选项及后果、建议默认值及理由；事实类写明需要用户提供什么信息、为什么阻塞。选项和补充说明用普通文本或普通 bullet，不要写成 `- [ ]`，引擎会把它们计为未确认项。

`next` 会在 propose 阶段检查 `proposal.md`、`design.md` 和 `test-contract.md` 的该段落。存在未确认项时，汇总一次向用户提问（按影响排序并说明问题间依赖，不逐个往返）；收到回答后用驱动方式中的 `record user-decision` 命令登记，JSON 经 stdin 传入（scope 建议引用 `DEC-xxx`，一条决策可列多个 ID；此为留痕约定，引擎不校验格式）。

答案来自用户时，先登记再勾选；答案来自需求文档、代码证据等外部事实核对时，行内写明证据来源，不伪造用户决策。用户回答含糊、与候选项不匹配或引出新问题时，不视为已确认；复述理解并获得明确答复后再登记。把结论反映到 proposal/design/test-contract 相关内容，勾选行内注明结论要点；确认项作废或重复时改为 `[x]` 并注明理由，不要删除确认项。局部实现细节、命名、普通文件组织和不影响需求/验收/风险的技术微调不要升级为用户确认。

进入 propose 后出现新的业务规则、产品口径、验收标准、示例规范或需求源更新时，不要静默覆盖原计划；默认先在 `proposal.md` 记录 `## 需求变化`，说明变化来源、变化内容、影响范围和处理方式（更新当前 change / 新建后续 change / 暂不处理）。只有影响技术路线、测试契约或业务不变量时，才同步更新 `design.md`、`test-contract.md` 或 `business-invariants.md`。

## 完成条件

tasks.md 作为计划文档就绪（不是复选框全完成）+ 基础职责文档齐全 → next 返回 propose-ready 命令。

## Guardrails

- 只产出计划文档，不改业务代码、不做实现
- 不绕过 `## 待用户确认` 中的未确认项
- tdd_required 标注真实
- 不跳过 transition
- 不跳过完整审查路径下的审核工作项
- 审查通过后、推进前不做非必要的文档编辑；绑定审查的内容（proposal/design/tasks/specs/discovery/business-invariants/test-contract）变更会作废已通过的审查并触发重审。
