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

所有状态由工作流引擎管理。循环：

1. `superspec transition next --change "<change>"` 获取下一步
2. 执行返回的命令
3. 登记结果
4. 回到 1

如果下一步提示当前阶段还有用户确认、审查或验证事项，先完成这些事项。完成前不要进入下一阶段，也不要修改业务代码；对用户说明时使用自然语言，不默认复述内部 JSON 字段或完整 packet。

如果下一步需要审查，先按返回的审查说明完成对应审查，再优先用 `superspec record job-submit --change "<change>" --job <JOB> --report -` 从 stdin 提交 JSON 审查报告内容；文件路径模式仍可作为 fallback。

人类可读正文默认使用简体中文；OpenSpec 结构标题、规范关键字、命令、路径、JSON 字段、代码标识符保留原文。
如果 OpenSpec 生成文档语言不符合预期，先检查 `openspec/config.yaml` 的官方 `context` 设置；不要在变更文档里添加自定义 `language` 字段。

本技能默认走完整审查路径。计划阶段进入实现前，工作流会要求 `critic`、`architect`、`test-engineer` 三个独立审查完成。

所有审查工作项必须由独立角色 reviewer 执行，不能由主流程自审代替；报告必须按工作流返回的格式提交，并记录实际审查来源。

## 本阶段做什么

### proposal.md
使用 OpenSpec proposal 原生结构。正文使用简体中文。

SuperSpec 只增加一个轻量要求：在 OpenSpec 原生 `## Impact` 段落中，必须能看出受影响范围和原因。推荐写成：

```markdown
| Area | Reason |
|---|---|
| src/review.ts | 需要核对 review verifier 如何绑定文档和执行证据 |
```

规则：
- `proposal.md` 说明为什么要做、做什么、能力变化和影响范围
- `Area` 可以写代码区域、API、依赖、系统、配置或文档
- `Reason` 只解释为什么该范围受影响，不写详细实现方案
- discovery 含 `## 输入数据来源核查` 的 IDC 项时，相关 `Reason` 须引用对应 `IDC-xxx` 状态（`已证明` / `未知阻塞` / `未知非阻塞`）
- `Area` 不作为路径白名单
- 不写任务拆分
- 只有存在阻塞确认项时才增加 `## 待用户确认`

### specs/
OpenSpec 能力规范增量（`openspec instructions specs` 格式）。

### design.md
使用 OpenSpec design 原生结构。正文使用简体中文。

规则：
- `design.md` 写技术方案、关键决策、替代方案和风险取舍
- 在上述内容中补充实现方向；每个代码影响型需求说明采用的路线，如复用现有链路、改接口、加表、发消息、定时任务或查询聚合
- 实现方向只到路线级；不写字段名、函数名、SQL、类名或逐步代码。路线无法确定时写入 `## 待用户确认`
- 不复制 `proposal.md` 的影响范围表
- 不写任务拆分
- discovery 含 `## 输入数据来源核查` 且影响设计成立时，记录输入完整性决策；相关 `IDC-xxx` 为 `未知阻塞` 时设计不得标 ready
- 只有存在阻塞确认项时才增加 `## 待用户确认`

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
- 标题只分组，不是可执行 task；标题不要包含可执行 task id token，例如不要写 `## 1.1 Review verifier`
- 顶格 `- [ ] <task_id> ...` 才是可执行 task，`<task_id>` 可以是 `1.1` 或 `TASK-001.1`
- 每个可执行 task id 必须唯一、稳定
- 不展示、不推荐缩进 checkbox；task 内部步骤用普通 bullet，不用 checkbox
- `tdd_required:true`（默认）——改运行时代码/业务逻辑/数据迁移/权限/外部接口
- `tdd_required:false` + `no_tdd_reason:xxx`——纯文档/配置/机械改名/生成物
- task 行只标记是否需要 TDD，不写 RED/GREEN 命令、断言或预期输出；实际 RED/GREEN 由 apply 阶段执行，并通过 `record test-run` 绑定到 attempt
- 一个 task 对应一个可独立验证的行为变化，或一个明确的非行为改动
- 多个行为变化、多个入口、多个运行时模块混在一起，且不能形成同一个 RED/GREEN 闭环时，应拆开
- 如果一个 task 需要“顺便”改很多不相邻模块，应在 propose 阶段重新拆分或补充任务，不留到 apply 阶段扩大范围

### business-invariants.md
格式：

```markdown
# Business Invariants

- INV-001 用户密码必须加密存储
- INV-002 订单金额不能为负数
```

### test-contract.md
格式：

```markdown
# Test Contract

| test_id | invariant | scenario |
|---|---|---|
| TEST-001 | INV-001 | 注册时密码被加密 |
| TEST-002 | INV-002 | 订单金额为负时拒绝 |
```

如果 discovery 含 `## 输入数据来源核查` 的 IDC 项，在测试表后增加 `## 输入数据覆盖验证`：

| 核查ID | 验证方式 | 输入链路声明 | 证据或计划 |
|---|---|---|---|
| IDC-001 | 源码锚点 + 聚焦测试 | producer 产生的目标输入会进入 consumer | src/path.ts:10 + TEST-001 |

证明方式可用源码锚点、fixture、targeted test、日志或 trace，须说明证明力；不强制集成测试。只证 consumer 算法、没证 producer→consumer 输入完整性，测试契约不足。

### 待用户确认
如果计划阶段遇到会影响需求范围、验收标准、用户可见行为、方案取舍、测试策略、安全、权限、数据或迁移判断的关键不确定问题，先写入相关计划文档的 `## 待用户确认` 段落：

```markdown
## 待用户确认

- [ ] DEC-001 是否需要兼容历史行为？
```

`next` 会在 propose 阶段检查 `proposal.md`、`design.md` 和 `test-contract.md` 的该段落。存在未确认项时，先向用户提问；收到回答后将 JSON 内容通过 stdin 登记：

```bash
superspec record user-decision --change "<change>" --input -
```

文件路径模式仍可作为 fallback。

然后把用户决定反映到 proposal/design/test-contract，并将对应确认项改为 `[x]` 或移出未确认列表。局部实现细节、命名、普通文件组织和不影响需求/验收/风险的技术微调不要升级为用户确认。

## 完成条件

tasks.md 作为计划文档就绪（不是复选框全完成）+ 基础职责文档齐全 → next 返回 propose-ready 命令。

## Guardrails

- tasks.md 只列任务，不实现
- 不绕过 `## 待用户确认` 中的未确认项
- 不改业务代码
- tdd_required 标注真实
- 不跳过 transition
- 不跳过完整审查路径下的审核工作项
