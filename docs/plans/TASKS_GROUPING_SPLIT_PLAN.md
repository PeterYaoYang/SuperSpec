# Tasks 分组与拆分质量轻量改造方案

## 背景

`tasks.md` 的拆分质量直接决定 apply 阶段的执行边界。任务过粗时，RED/GREEN 很难证明覆盖了什么；任务过细但没有结构时，人也很难 review。

OpenSpec 原生 tasks 支持用标题分组和 `1.1`、`1.2` 这类任务编号表达子任务。SuperSpec 当前主解析路径只把顶格 checkbox 行当作 pending task：

```markdown
- [ ] <task_id> ...
```

因此当前最稳的方向不是引入父子任务状态机，而是把 `tasks.md` 规范改成：

```markdown
## Review verifier

- [ ] 1.1 检查 verifier 绑定文档 tdd_required:true
- [ ] 1.2 检查 verifier 绑定执行证据 tdd_required:true
```

也就是：文档上用 OpenSpec 分组，执行上仍然只有顶格叶子任务。

## 当前问题

1. 当前 `tasks.md` 说明容易让人误以为缩进 checkbox 子任务可执行。
2. 当前示例偏扁平，不利于表达真实需求里的任务分组。
3. 任务拆分规则偏弱，容易出现一个 task 混入多个行为变化，导致 apply 改太多、review 难判断。
4. 如果 task id 不清晰稳定，人和 agent 都难以把 RED/GREEN 证据、实现 diff、review 结论对应到同一执行单元。

## 目标

1. 支持实际使用中需要的“子任务体验”。
2. 不引入父子任务状态机。
3. 不修改 parser、transition、record、raw、snapshot。
4. 不修改状态流转。
5. 提升 propose 阶段任务拆分质量，让 apply 的执行边界更清楚。
6. 通过示例和 reviewer 口径让正常路径自然产出顶格叶子任务。

## 非目标

1. 不支持缩进 checkbox 作为可执行子任务。
2. 不增加父任务完成规则。
3. 不增加子任务继承 RED/GREEN 或父子 attempt 绑定。
4. 不新增命令或状态流转。
5. 不让 `tasks.md` 引用 `proposal.md` / `design.md` 里的额外结构字段。
6. 不为缩进 checkbox、重复 task id 等错误输入新增状态机防御。
7. 不把 RED/GREEN 验证细节写进 `tasks.md`。

## 修改方案

### 1. 修改 `superspec-propose` 的 tasks.md 规范

把 `tasks.md` 说明改成：

说明文字：

> 使用 OpenSpec tasks 原生分组结构；每个顶格 checkbox 行是一个 SuperSpec 可执行 task。

示例：

```markdown
# Tasks

## Review verifier

- [ ] 1.1 检查 verifier 绑定文档 tdd_required:true
- [ ] 1.2 检查 verifier 绑定执行证据 tdd_required:true

## Documentation

- [ ] 2.1 更新文档 tdd_required:false no_tdd_reason:documentation-only
```

规则：
- Markdown 标题只用于分组，不是可执行 task。
- 顶格 `- [ ] <task_id> ...` 是可执行 task，`<task_id>` 可以是 `1.1` 或 `TASK-001.1`。
- 每个可执行 task 的 `<task_id>` 必须唯一、稳定。
- 分组标题不要包含可执行 task id token，例如不要写 `## 1.1 Review verifier` 或 `## TASK-001 Review verifier`。
- `task-start` / `task-complete` 只能传顶格 checkbox 行里的 `<task_id>`，不要传分组标题或标题编号。
- 不展示、不推荐缩进 checkbox；如果需要表达 task 内部步骤，用普通 bullet，不用 checkbox。
- `tdd_required:true` 默认用于运行时代码、业务逻辑、数据迁移、权限、外部接口。
- `tdd_required:false` 必须带 `no_tdd_reason:xxx`，只用于纯文档、配置、机械改名、生成物。
- task 行只标记是否需要 TDD，不写 RED/GREEN 命令、断言或预期输出；实际 RED/GREEN 由 apply 阶段执行，并通过 `record test-run` 绑定到 attempt。

### 2. 增加轻量拆分规则

在 `tasks.md` 规则中补充：

- 一个 task 应该对应一个可独立验证的行为变化，或一个明确的非行为改动。
- TDD task 必须能形成清晰 RED/GREEN 闭环，但不要把 RED/GREEN 细节写进 `tasks.md`；细节属于 apply 执行证据。
- 多个行为变化、多个入口、多个运行时模块混在一起，且不能形成同一个 RED/GREEN 闭环时，应拆开。
- 文档、配置、发布流程不要混入无关的运行时代码 task；只有它们是同一个行为变化的必要组成部分时才合并。
- 如果一个 task 需要“顺便”改很多不相邻模块，应在 propose 阶段重新拆分或补充任务，而不是留到 apply 阶段扩大范围。

### 3. 同步 reviewer 口径

`critic`：
- fail task 过粗，无法形成清晰 RED/GREEN 闭环。
- fail 多个独立行为混在一个 task。
- fail task id 不清晰、不稳定，或明显重复。
- fail `tasks.md` 把未完成工作藏在非执行说明里，导致状态机无法自然推进。
- fail 分组标题包含可执行 task id token，避免手动命令误命中标题。
- 在 prompt 中加入负例：一个 task 同时改 review、release、docs 等多个独立行为时，应要求拆分。

`architect`：
- 审查任务分组是否符合系统边界。
- 审查高风险模块是否被拆成可 review 的 task。
- 不要求新增设计字段，不要求 tasks 反向引用 design。

`test-engineer`：
- 审查 TDD task 是否能形成清晰 RED/GREEN 闭环。
- fail `tasks.md` 直接写 RED/GREEN 命令、断言或预期输出；这些内容应由 apply 阶段实际执行并记录。
- fail 无法定义目标测试身份、RED 失败信号、GREEN 覆盖映射，或只靠退出码/笼统命令证明的测试方案。
- 审查 no-TDD task 是否有明确 `no_tdd_reason`。
- 不要求建立新的 test-contract 关联。

`verifier`：
- 最终核对时关注实际改动是否能落到已完成 task。
- 发现未完成工作没有对应已完成 task 时，应 fail。
- TDD 任务的 RED/GREEN 以 `record test-run` 证据为准，不以 `tasks.md` 中的文字描述为准。
- 逐个已完成 TDD task 核对 `task_completed.attempt_id` 对应的 RED/characterization + GREEN test-run；新证据必须带同一 `attempt_id`，缺失 `attempt_id` 只能视为 legacy 兼容，不作为新流程的强证明。
- 核对 test-run 是否包含真实 `command`、`cwd`、`exit_code`、`semantic_status`、目标测试身份和可追溯日志或 test-runner report ref；退出码本身不等于证明，环境错误 / 构建错误不算 RED/GREEN。
- 普通 bullet 只是 task 内说明，不代表独立执行单元；但如果普通 bullet 暗含未完成工作且没有对应已完成 task，应 fail。
- 在 prompt 中加入负例：普通 bullet 写了 `TODO` / `follow-up` / “后续补”，但没有对应已完成 task 时，应 fail。

### 4. 同步 apply 口径

`apply` 阶段沿 `next` 主路径只执行顶格 checkbox 任务。手动执行命令时，也只能把顶格 checkbox 行里的 `<task_id>` 传给 `task-start` / `task-complete`。

如果任务内有普通 bullet 步骤，步骤只是说明，不单独进入状态机。apply 完成该 task 时，仍必须满足该 task 的 RED/GREEN 或 no-TDD 证据要求。

`tasks.md` 不写 RED/GREEN 细节。apply 阶段负责实际跑 RED/GREEN，并通过 `record test-run` 记录真实命令、工作目录、退出码、语义状态、目标测试身份、可追溯日志或 test-runner report ref，以及 attempt 绑定。

新产生的 TDD 证据必须绑定当前 `attempt_id`。历史 digest-only test-run 只作为兼容旧数据的回退，不作为新流程“确实跑了红绿验证”的强证明。

### 5. 测试

更新模板测试：

- 断言 `superspec-propose` 明确 OpenSpec 分组 + 顶格叶子任务。
- 断言 `tasks.md` 示例块不使用缩进 checkbox。
- 断言分组标题不包含可执行 task id token。
- 断言 task id 可以是 `1.1` 或 `TASK-001.1`。
- 断言 `tasks.md` 规范不要求、不鼓励写 RED/GREEN 细节。
- 断言 critic / architect / test-engineer / verifier 有对应轻量审查口径。
- 断言 critic / verifier prompt 含有具体负例和期望 fail 结论，避免只写抽象原则。
- 断言 apply / verifier 口径要求新 test-run 证据绑定同一 `attempt_id`，并核对命令、退出码、语义状态、目标测试身份和可追溯日志或 report ref。
- 补一条轻量 engine 回归：带分组标题和 `1.1` 顶格任务时，`next -> task-start -> task-complete` 仍走叶子 task；普通 bullet 和缩进 checkbox 不进入 pending。
- 继续禁止新增父子 parser、父子状态机、snapshot、raw、record 命令。

## 验收边界

这个方案不承诺 agent 或人工 review 一定能发现所有拆分质量问题。轻量框架下可证明的是：

- 模板会明确生成 OpenSpec 分组 + 顶格叶子 task。
- `next` 主路径会从顶格 checkbox 推进任务。
- reviewer / verifier prompt 会包含具体负例和 fail 结论，避免只靠抽象提醒。
- apply / verifier 口径会把新 RED/GREEN 证明绑定到当前 attempt，而不是绑定到 `tasks.md` 文本描述。
- engine 回归会覆盖 grouped `tasks.md` 的主路径。

不可证明、也不强行做成引擎保证的是：

- 重复 task id 一定在运行前被引擎拒绝。
- 缩进 checkbox 或普通 bullet 一定被命令层拒绝。
- 所有过粗 task 和漏项都能被 agent 语义审查 100% 发现。
- test-run JSON 的自报字段由引擎自动证明为真实命令执行；真实性仍依赖 test-runner/report/verifier 审查。

## 流转协议影响

不引入父子状态流转协议，也不引入新的文件结构协议。

原因：

- `parseTasksMd` 已经把顶格 checkbox 后第一个 token 当作 task id，`1.1` 天然可用。
- `pendingTasksInContent` 仍只看顶格可执行 task。
- `task-start --task 1.1` 和 `task-complete --task 1.1` 不需要新增协议。
- `task_structure_digest` 仍对整个 `tasks.md` 做 checkbox 归一化，不需要改变。
- `task-complete` 仍只自动勾选目标 task 行。
- 当前命令层仍有历史兼容查找逻辑，所以方案不声明“任意手动输入都由引擎强防御”。正常 `next` 主路径只会提供顶格 checkbox task id；手动命令必须遵守同一规则。

因此不会引入缺字段、缺父任务状态、父子同步或重新计算问题。

## 风险与处理

### 风险 1：用户以为标题是父任务

处理：明确标题只分组，不进入状态机；标题不要带可执行 task id token。

### 风险 2：agent 写缩进 checkbox

处理：skill 示例不展示缩进 checkbox；critic/verifier 对“未完成工作藏在非执行说明里”进行 fail。不为这个错误输入新增状态机防御。

### 风险 3：重复 task id 导致流程卡住

处理：critic 在 propose 阶段 fail；测试和文档强调 task id 必须唯一稳定。不为这个错误输入新增状态机防御。这是 reviewer-gated 残余风险，不是引擎层保证。

### 风险 4：task 仍然过粗

处理：critic、architect、test-engineer 在 propose-ready 审查时拦截；不放到 apply 阶段补救。

### 风险 5：过度设计

处理：不引入父子任务结构，不改 parser、状态机和命令，只改文档规范、reviewer 口径和测试。

## 同步范围

必须修改发布源：

- `templates/workflow/skills/superspec-propose/SKILL.md`
- `templates/workflow/skills/superspec-apply/SKILL.md`
- `templates/workflow/prompts/critic.md`
- `templates/workflow/prompts/architect.md`
- `templates/workflow/prompts/test-engineer.md`
- `templates/workflow/prompts/verifier.md`
- `tests/test_skill_templates.ts`
- `tests/test_phase3.ts` 或同类 engine 测试文件，增加 grouped tasks 轻量回归

如果要让当前仓库立即 dogfood 新口径，再通过安装/更新流程同步 `.codex/skills` 和 `.codex/prompts` 的本地副本；发布源仍以 `templates/workflow/**` 为准。

## 预期提升

1. `tasks.md` 更接近 OpenSpec 原生任务写法。
2. 人能用分组理解任务结构。
3. 状态机仍保持扁平、稳定、可预测。
4. apply 的执行边界更清楚。
5. RED/GREEN 证据更容易对应具体任务。
6. review/verifier 更容易判断是否漏项或跑偏。
