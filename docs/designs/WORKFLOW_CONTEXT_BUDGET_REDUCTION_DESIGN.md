# SuperSpec 工作流上下文预算压缩设计

> 状态：RFC / 已吸收 architect + critic 审查意见
> 目标：在不放松 guard 状态机、review disclosure 和 archive preservation 约束的前提下，把 SuperSpec workflow 的固定上下文面压缩至少 50%，并把后续实测上下文成本做成可回归指标。

## 1. 结论

当前上下文膨胀的主因不是 `src/state.ts`、`src/gates.ts` 这类状态机实现本身，而是**同一套流程契约被重复写在多个 skill、role prompt、agent TOML 和 OpenSpec bridge skill 中**。这些静态文本在 explore / propose / review 多阶段被反复装载，远早于真正的 change 事实进入上下文。

仅压缩措辞或继续依赖会话压缩不够。要在不损坏状态机可控性的前提下把上下文占用明显打下来，必须采用 **packet-first** 方案：

1. 先把 gate 规则、review 合同和 round>1 prompt 需求收敛到 CLI 生成的、版本化的 packet。
2. 再把 `superspec-*` workflow skill、role prompt 和 agent TOML 缩成薄包装层。
3. 最后迁移 OpenSpec bridge，去掉当前“先读 SuperSpec skill，再读 repo-local OpenSpec skill”的双重上下文面。

这条路线是本轮 architect / critic 审查后唯一保留下来的方案。直接删 prompt / skill 文案而不先做 packet，会把状态机真相拆成多份，风险不可接受。

## 2. 目标与非目标

### 2.1 目标

- 把 workflow 固定上下文面压缩至少 50%。
- 保持 `src/gates.ts`、`src/evidence.ts`、`src/disclosure.ts` 仍是状态与 gate 语义唯一真相源。
- 保持 `prompt_ref` 可读、非空，并继续支持 round>1 的 deterministic ledger 注入校验。
- 保持 `check-init`、distribution、SPEC 和测试一起演进，不制造“实现改了、安装协议没改”的半迁移状态。
- 为后续优化建立真实的上下文成本基线，而不是只看文件长度。

### 2.2 非目标

- 不改变现有 gate 拓扑、review disclosure 语义或 archive preservation fail-closed 语义。
- 不把 `prompt_ref` 改成纯 JSON 或不可读二进制产物。
- 不在第一步就删除 repo-local OpenSpec bridge skill。
- 不宣称“只靠文档整理”就能保证端到端 50% token 降幅；实际节省必须以后续实测为准。

## 3. 基线与证据

### 3.1 固定上下文面基线

本轮统计的是当前 repo 中最容易被 workflow 反复触达的固定文本面：

| 类别 | 文件数 | 字符数 | 说明 |
| --- | --- | ---: | --- |
| SuperSpec workflow skills | 5 | 41,427 | `templates/workflow/skills/superspec-*.md` |
| SuperSpec role prompts | 5 | 17,370 | `templates/workflow/prompts/*.md` |
| Codex agent TOML | 5 | 35,046 | `adapters/codex/agents/*.toml` |
| repo-local OpenSpec bridge skills | 5 | 28,764 | `.codex/skills/openspec-*/SKILL.md` |
| 合计 | 20 | 122,607 | 这是当前 source/install surface 的静态上界，还未计入 change facts、diff、review 输出和测试日志 |

这组数字说明当前仓库可触达的 workflow 静态协议面至少有约 12.3 万字符，但**它不是单次会话真实装载量**。真实每阶段装载成本需要在 Phase 0 用 materialized measurement 单独测出来。

### 3.2 重复证据

SuperSpec 五个 workflow skill 中，以下大段协议被重复出现并被测试锁定：

- `## 语言规则 / Language`
- `## 命令执行 / Shell`
- `## 上下文读取纪律 / Context Budget`
- `普通 workflow 命令使用 --format agent`
- 多条“用户可见文案如何翻译内部协议”的规则

这些重复在以下文件中都存在：

- `templates/workflow/skills/superspec-explore/SKILL.md`
- `templates/workflow/skills/superspec-propose/SKILL.md`
- `templates/workflow/skills/superspec-apply/SKILL.md`
- `templates/workflow/skills/superspec-review/SKILL.md`
- `templates/workflow/skills/superspec-archive/SKILL.md`

并且 `tests/test_superspec_skills.test.ts` 当前还显式断言了这类重复文本必须存在。

### 3.3 OpenSpec bridge 叠加

SuperSpec skill 当前普遍要求先读 repo-local OpenSpec skill，再执行本阶段逻辑。例如：

- `superspec-explore` 先读 `.codex/skills/openspec-explore/SKILL.md`
- `superspec-propose` 先读 `.codex/skills/openspec-propose/SKILL.md`
- `superspec-archive` 会参考 `.codex/skills/openspec-archive-change/SKILL.md`

与此同时，`check-init` / 安装与规范仍把这些 repo-local OpenSpec skills 视为硬依赖的一部分。这意味着一次 SuperSpec 工作流往往要同时携带两套长文本协议：SuperSpec overlay 自己的一套，加上 OpenSpec bridge 的一套。

### 3.4 review / disclosure 额外约束

当前 review disclosure 的关键语义已经在代码里实现，并且不能丢：

- deterministic ledger render 在 `src/disclosure.ts`
- `round>1` prompt 必须注入 ledger 的 fail-closed 校验也在 `src/disclosure.ts`
- `prompt_ref` 必须可读、非空的契约在 `src/evidence.ts`

这说明真正该保留的真相已经在代码里，问题是外层 prompt/skill 仍在重复叙述这套合同。

## 4. 根因分析

### 4.1 根因一：流程契约分散在多层静态文本里

当前 workflow 的状态机真相主要在代码里，但**模型真正消耗上下文时读到的是多份手写协议**：

- workflow skill 写一遍
- role prompt 再写一遍
- agent TOML 再包装一遍
- OpenSpec bridge skill 又写一遍

这会产生两个问题：

1. 固定成本过高，和 change 复杂度无关。
2. 同一协议散落多处，后续每次修 gate 或 review 合同时都容易继续放大文本面。

### 4.2 根因二：OpenSpec bridge 采用“读技能文档”而不是“读结构化上下文”

SuperSpec 当前不是直接把 OpenSpec 所需上下文结构化注给模型，而是要求模型再去读一层 repo-local OpenSpec skill。这样做最稳，但上下文代价很高，且和 SuperSpec 自己的阶段说明大量重叠。

### 4.3 根因三：review 合同既在代码里，也在 prompt 文本里重复展开

`review_complete` 的 `source_guidance`、`main_adjudication`、`verification_review` 等必填合同已经在 `src/evidence.ts` / `src/gates.ts` 可机判，但 `superspec-review`、role prompt 和 agent 定义仍要全文展开这些字段、动作和 stop condition。

结果是 review 阶段成了最重的一段固定上下文面，而这恰恰是最容易多轮反复进入的阶段。

### 4.4 根因四：prompt_ref / ledger 需求没有独立产出面

critic 审查指出，不能简单把 round>1 prompt 压成“见历史 ledger”。原因是 guard 会对 prompt 中 injected ledger 做逐字校验，且 `prompt_ref` 必须是可读文本。

这意味着必须有一个**专门生成 prompt 文本的第一类接口**，而不能靠人工在 skill/prompt 里拼接长说明。当前缺失的正是这个接口。

### 4.5 根因五：缺少真实上下文成本指标

当前只有文件大小和主观体感，没有真正回答下面几个问题：

- explore / propose / review 各阶段到底装载了哪些固定文本面？
- round>1 review prompt 的真实大小是多少？
- 去掉重复协议后，真实 materialized packet 是否真的降低了 50% 以上？

没有这层指标，后续很容易“文件变短了，但真实工作流上下文没怎么降”。

## 5. 不可破坏约束

本设计必须同时满足以下硬约束：

1. **状态机真相仍在代码里。**
   - `src/state.ts`、`src/gates.ts`、`src/evidence.ts`、`src/disclosure.ts` 继续是判定真相。
   - 新 packet 只能从这些代码生成，不能变成第二套手写规范。

2. **`prompt_ref` 仍是可读文本。**
   - `src/evidence.ts` 已要求 role evidence 的 `prompt_ref` 可读、非空。
   - 新方案不能把 reviewer prompt 退化成仅有 JSON path。

3. **round>1 ledger 注入语义必须保留。**
   - `src/disclosure.ts` 当前对 injected ledger 做 deterministic 比对。
   - 新 reviewer prompt 必须继续包含 tool-rendered ledger block，而不是摘要化替代品。

4. **OpenSpec bridge 不能半迁移。**
   - 只要 `check-init`、distribution、SPEC、安装 manifest 还要求 `.codex/skills/openspec-*`，就不能单独删 skill bridge。

5. **测试必须同步改。**
   - 当前 skill smoke 测试直接锁定了重复文本。
   - packet-first 落地后，测试要从“锁定大段文案”转为“锁定 wrapper 行为 + packet 契约”。

## 6. 设计原则

### 6.1 Packet 是唯一新增真相层

允许新增的只有**由 CLI 代码生成的 packet**。不允许再出现一份“文档里是 A、skill 里是 B、prompt 里是 C”的静态协议副本。

### 6.2 让 skill / prompt 只保留薄包装职责

workflow skill、role prompt、agent TOML 只保留：

- 角色职责
- 必须调用的 packet 命令
- 用户可见语言和停止规则的最小不变量

所有 gate-specific 细节都从 packet 读取。

### 6.3 结构化给模型，文本化给 evidence

同一份 packet 应同时服务两种消费：

- `--format agent`：给主流程 / role 使用的紧凑结构化上下文
- `--format prompt` 或等价文本格式：给 `prompt_ref` 落盘的可读 reviewer prompt

这样既保留 guard 可校验的文本证据，又避免把长协议手写在 prompt 里。

### 6.4 先量化，再宣称节省

压缩目标必须绑定到真实 materialized surface，而不是仅比较源文件长度。

## 7. 方案设计

### 7.1 新增一等 packet CLI

为避免先改顶层 CLI 再改 guard surface，Phase 1 的 canonical packet 命令面应先落在现有 `superspec guard` 子命令树下。建议新增三类命令：

```text
superspec guard workflow-packet --change "<change>" --gate "<gate>" --format agent
superspec guard review-packet --change "<change>" --gate "<gate>" --role "<role>" --round <n> --format agent
superspec guard review-packet --change "<change>" --gate "<gate>" --role "<role>" --round <n> --format prompt
superspec guard ledger-render --change "<change>" --gate "<gate>" [--round <n>]
```

说明：

- 这套命令面与当前 `src/cli_args.ts` / `src/cli.ts` 的 guard 架构对齐，Phase 1 不要求修改顶层 `superspec <command>` 路由。
- 若后续需要 `superspec workflow-packet ...` 这类顶层别名，应另作为独立 CLI ergonomics 变更处理，并同步修改 `superspec.ts`、help、distribution 文档与测试；它不属于本设计的首期收敛目标。

职责划分：

- `workflow-packet`
  - 输出某个 gate 当前需要的最小协议面
  - 含必需 artifact、前置 gate、用户确认点、stop condition、合法命令、失败出口
- `review-packet --format agent`
  - 输出 reviewer lane 的最小任务说明、目标 refs、输出 schema、必须覆盖的 claims/load/finding 契约
- `review-packet --format prompt`
  - 生成将要落成 `prompt_ref` 的最终文本
  - round>1 时嵌入 deterministic ledger block
- `ledger-render`
  - 继续作为 reviewer prompt 的唯一 ledger 生成器

### 7.2 Packet 由现有 guard / disclosure / evidence 代码生成

packet 不能再维护一份手写协议。它应直接消费已有真相源，例如：

- `src/gates.ts`
  - gate 前置链
  - default next actions
  - OpenSpec / SuperSpec init 依赖
- `src/evidence.ts`
  - evidence 必填字段
  - `prompt_ref` / `output_ref` / pinned refs / role evidence 合同
- `src/disclosure.ts`
  - round 语义
  - digest chain
  - ledger injection
- `src/util.ts`
  - agent-safe 渲染和用户可见输出边界

必要时可以补一个 `packet_schema.ts` / `packet_render.ts`，但它必须是**生成层**，不是第二状态机。

### 7.3 Thin workflow skills

五个 `superspec-*` workflow skill 改为薄包装：

1. 说明本阶段职责。
2. 调 `superspec guard ... --format agent` 或 `superspec guard workflow-packet ... --format agent`。
3. 按 packet 指示读取必要 artifact / 调 OpenSpec / 停在用户确认点。

保留最小跨阶段不变量：

- 默认中文用户可见输出
- 普通命令使用 `--format agent`
- guard block 立即停止
- 不暴露内部 reason code 给用户

但不再在每个 skill 内重复整套 gate 合同、字段清单和 review disclosure 细节。

### 7.4 Thin role prompts 与 agent TOML

role prompt 和 agent TOML 也做同样瘦身：

- prompt 只保留角色目标、输出态度和“先读 `review-packet`”的规则
- 详细 evidence schema、required_load_refs、claim/finding adjudication 等从 `review-packet` 注入
- agent TOML 不再内嵌大段协议文本，只保留最小启动配置与 prompt 绑定

这一步能消掉当前 review 阶段最重的重复文本面。

### 7.5 OpenSpec bridge 迁移

packet-first 之后，再把当前“读取 `.codex/skills/openspec-*`”迁移成更轻的结构化桥接：

- `workflow-packet` 直接告诉模型当前需要哪个 OpenSpec CLI surface：
  - `openspec list --json`
  - `openspec status`
  - `openspec instructions <artifact>`
  - `openspec instructions apply`
  - `openspec validate`
  - `openspec archive -y`
- `check-init` 从“必须有 repo-local OpenSpec skill 文本”迁移到“必须有可用的 OpenSpec CLI surface / 兼容协议”
- 迁移必须同一提交内一起改完以下链路，不能拆半：
  - `src/project_init.ts` 中 `ensureOpenSpecCodex()` 的自动修复逻辑
  - `src/init_cli.ts` 的 project-scope `superspec init/update` 路径
  - `docs/SPEC.md`、`docs/DISTRIBUTION.md`
  - install/update manifest 与相关测试
  - skill smoke / guard / install-engine 测试
- 在上述链路未同时切换前，不允许删除 `.codex/skills/openspec-*` 依赖，也不允许先把缺失 skill 从 `check-init` 的 block 条件中拿掉。

注意：这一步必须在 packet 稳定、测试到位之后再做，不能倒序。

### 7.6 上下文指标内建

需要新增一套可回归的上下文预算指标，最少包括：

- `fixed_surface_chars`
  - 当前安装到 `.codex/skills`、`.codex/prompts`、`.codex/agents` 的固定文本面总量
- `materialized_workflow_packet_chars`
  - explore / propose / review / archive 的 packet 输出长度
- `materialized_review_prompt_chars`
  - 每个 role 在 r1 / r2 的 `prompt_ref` 文本长度；r2 额外拆出 `ledger_block_chars` 与 `prompt_body_chars`
- `bridge_surface_chars`
  - OpenSpec bridge 在迁移前后的固定文本面
- `representative_loaded_surface_chars`
  - 针对 explore / propose / review 代表场景的真实已装载 surface，总和必须能和上面几个分项对账

这些指标应进入自动化测试或 snapshot，不再靠手工估算。

## 8. 分阶段改造

### Phase 0：先补真实度量

目标：

- 建一个上下文面基线测试或脚本，能对当前工作流做 materialized measurement。
- 把“12.3 万字符固定面”明确标成 source/install static upper bound，并额外测出真实阶段装载面。

输出：

- 新测试或测量命令
- 一组固定的 benchmark 场景基线报告；场景集合必须写死进仓库，不允许按人随意切换。最少包含：
  - explore：`check-init -> explore_complete`，覆盖 `openspec list --json` / `openspec status`
  - propose：`proposal_reviewed -> design_complete -> test_contract_drafted`
  - review：`review_complete` allow path，覆盖 `source_guidance` / `verification_review` / `final_test`
  - disclosure：至少一个 round>1 reviewer prompt，覆盖 deterministic ledger 注入

### Phase 1：落 packet CLI

目标：

- 在 `src/cli_args.ts`、`src/cli.ts` 增加 `superspec guard {workflow-packet,review-packet,ledger-render}` 子命令
- 从 `src/gates.ts`、`src/evidence.ts`、`src/disclosure.ts` 生成 packet
- 保持旧 skill / prompt 仍可运行

验收：

- packet 首期必须覆盖完整的 gate family，而不是只挑最容易的样本：至少包含 `explore_complete`、`proposal_reviewed`、`design_complete`、一个 Phase 3 propose gate（`invariants_reviewed` 或 `test_contract_drafted`）、`review_complete`、`archive_ready`，以及一个 round>1 review prompt
- round>1 prompt 仍能通过 ledger 注入校验
- 不要求同一阶段引入新的顶层 `superspec <packet-command>` 别名；若需要顶层别名，必须另立 CLI surface 变更并同步 `superspec.ts`、help、分发文档与测试

### Phase 2：瘦身 workflow skill

目标：

- 五个 `templates/workflow/skills/superspec-*.md` 改成薄包装
- `.codex/skills/superspec-*` 的安装产物同步更新
- `tests/test_superspec_skills.test.ts` 改成校验 wrapper 行为，不再锁定大段重复文案

验收：

- workflow skill 的 installed surface chars 相对当前基线下降至少 50%，并且 `.codex/skills/superspec-*` 安装产物与模板同步
- gate 语义无回归

### Phase 3：瘦身 review prompts 与 agent TOML

目标：

- `templates/workflow/prompts/*.md` 改成 packet 驱动 prompt
- `adapters/codex/agents/*.toml` 删除重复协议说明

验收：

- review lane 仍能生成符合 guard 合同的 evidence
- `prompt_ref` / `output_ref` / required refs 契约测试继续通过
- `review_complete` 的关键语义无回归：`allow-only` 主裁决、`request_changes` handoff、`main_adjudication` 作者边界、`source_guidance` / `verification_review` / `final_test` 绑定、以及 fail verification 的用户确认要求继续由测试覆盖

### Phase 4：迁移 OpenSpec bridge

目标：

- 去掉 workflow 对 `.codex/skills/openspec-*` 的强依赖
- 改为 packet 指向 OpenSpec CLI surface
- `check-init`、`project_init`、`init_cli`、distribution、SPEC、安装 manifest、测试同步改造

验收：

- `check-init` 不再因为缺 repo-local OpenSpec skill 文本而 block
- `superspec init --scope project` / `superspec update --scope project` 不再自动回补 `.codex/skills/openspec-*`
- 仍能 fail-closed 地发现 OpenSpec CLI surface 缺失或不兼容
- explore 迁移后仍保留 `openspec list --json` 的 grounding 语义，并有对应测试

## 9. 影响面

实现这套方案至少会碰到以下区域：

| 区域 | 预计改动 |
| --- | --- |
| `src/cli_args.ts` / `src/cli.ts` | 在 guard surface 下新增 packet 子命令 |
| `src/gates.ts` | 暴露 gate 级 packet 所需的前置链、默认动作、依赖信息 |
| `src/evidence.ts` | 继续作为 reviewer output contract 真相源，并为 packet render 提供字段定义 |
| `src/disclosure.ts` | 复用 ledger render 与 round>1 prompt 生成 |
| `src/util.ts` | 复用 agent-safe / user-safe render |
| `src/project_init.ts` / `src/init_cli.ts` | OpenSpec bridge 从 skill 依赖迁移到 CLI surface 时，安装与自动修复逻辑必须同步切换 |
| `templates/workflow/skills/*.md` | 从长协议改为薄包装 |
| `templates/workflow/prompts/*.md` | 从长 prompt 改为 packet 驱动 prompt |
| `adapters/codex/agents/*.toml` | 去掉重复协议 |
| `docs/SPEC.md` / `docs/DISTRIBUTION.md` | 更新 packet 与 OpenSpec bridge 协议 |
| `tests/test_superspec_skills.test.ts` | 从文案锁定改为 packet / wrapper 锁定 |
| `tests/test_superspec_guard.test.ts` | 补 packet / prompt_ref / ledger 回归测试 |
| `tests/test_install_engine.test.ts` | 覆盖 install/update 不再依赖 repo-local OpenSpec skill 文本后的行为 |

## 10. 成功标准

本设计完成时，至少满足：

1. 固定上下文面相对当前基线下降至少 50%。
2. 代表性 explore / propose / review 场景的 materialized packet 面相对当前流程下降至少 50%。
3. `materialized_review_prompt_chars` 被单独度量并纳入验收：r1 prompt 总长度相对当前基线下降至少 50%；r2 prompt 至少满足 `prompt_body_chars` 相对当前基线下降至少 50%，且 `ledger_block_chars` 与总 prompt 长度必须进入 aggregate workflow budget 报表，防止把成本转移进 `prompt_ref`。
4. `review_complete`、`proposal_reviewed`、`design_complete` 等关键 gate 的状态机语义无回归；尤其是 review lane 的 `allow-only`、`request_changes` handoff、主线程 adjudication 和 fail-verification user disposition 语义继续受测试保护。
5. round>1 `prompt_ref` 仍然是可读文本，并且 ledger 注入校验继续 fail-closed。
6. 删除 `.codex/skills/openspec-*` 之前，`check-init` / `project_init` / `init_cli` / install / SPEC / tests 已全部同步迁移。

说明：第 1、2、3 条是本设计对“上下文减少 50%”的正式口径。它针对的是**workflow 固定面、materialized workflow packet，以及 reviewer prompt 文本面**。整个会话总 token 降幅会受到用户输入、代码 diff、测试日志和 review 输出长度影响，必须以实测为准。

## 11. 审查结论回放

### 11.1 architect 审查

architect 的核心要求是：**状态机真相不能从 guard 代码挪到另一份手写 packet 文档里**。本设计已按此约束收敛，packet 被定义为 CLI 生成层，而不是第二规范源。

### 11.2 critic 审查

critic 的核心结论是：**“直接删 prompt / slim skill”方案 reject，除非先做 packet-first**。主要原因：

- `prompt_ref` 不能失去可读文本和 deterministic ledger
- OpenSpec bridge 不能只删 skill 不改 init/spec/tests
- review 合同若还散在 prompt prose 中，后续仍会继续膨胀

本设计已经把这些反对意见转成硬约束和阶段顺序。

## 12. 明确拒绝的替代方案

### 12.1 只改文案，不改结构

拒绝原因：只能小幅缩短文本，不能消除重复真相源，也不能解决 review prompt / OpenSpec bridge 双重加载。

### 12.2 先删 OpenSpec bridge

拒绝原因：`check-init`、distribution、SPEC 和测试当前都还把 repo-local OpenSpec skill 当成依赖；先删会造成安装协议和运行协议脱节。

### 12.3 把 reviewer prompt 改成只给一个 JSON path

拒绝原因：会直接违反 `prompt_ref` 可读、非空和 ledger 注入可校验的现有 guard 契约。

## 13. 下一步

推荐实施顺序：

1. 先补真实上下文度量。
2. 落 `superspec guard workflow-packet` / `review-packet` / `ledger-render`。
3. 再瘦身 SuperSpec 自己的 workflow skill。
4. 再瘦身 role prompt / agent TOML。
5. 最后迁移 OpenSpec bridge 与安装协议。

如果这条顺序被打乱，最容易出现的问题是：上下文确实变短了，但状态机真相、prompt_ref 合同和安装协议开始分叉，长期维护成本反而更高。
