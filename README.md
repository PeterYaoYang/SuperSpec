# SuperSpec

[![npm version](https://img.shields.io/npm/v/@peterxiaoyang/superspec?style=flat-square)](https://www.npmjs.com/package/@peterxiaoyang/superspec)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen?style=flat-square)](https://nodejs.org)
[![OpenSpec](https://img.shields.io/badge/OpenSpec-compatible-6f42c1?style=flat-square)](https://github.com/Fission-AI/OpenSpec)

AI 写代码很快。真正慢的是之后：范围悄悄变大、完成全凭一张嘴、review 时问一句「这里为什么要改」它才承认不该改。

SuperSpec 是一套跑在 AI 编程代理（Codex、Claude Code、OMP）下的需求变更工作流引擎。它补上 AI 自己补不上的东西：你没说出口的期望、它不了解的项目约定、实现该有的分寸。流程顺序、你的决定和证据是否一致由引擎守住；怎么调查、怎么实现，交给模型根据仓库事实自己判断。

```text
Explore → Propose → Apply → Review → Accepted
```

## 设计初衷

AI 做出来的东西偏离期望，往往不是因为它不够聪明，而是缺了三样它自己补不上的东西：

1. **需求往往只有一句话。** 业务口径、验收标准，以及「该复用什么、别新增什么」这类实现上的期望，都在使用者脑子里；没说出来，模型再强也推断不出。
2. **每次都是新会话。** 模型不了解这个项目：分层怎么约定、公共工具在哪、已有哪些开关和字段。不知道，就容易重复造轮子、把逻辑放错位置。
3. **实现要有分寸。** 不过度设计、该用公共方法就用公共方法、只做本次需要的改动。这些注意事项要有人明确说出来，并在审查时对照。

所以 SuperSpec 的作用是**设定边界、提供引导，而不是控制模型**：

- 进入实现前，把「要做什么、逻辑放哪、复用什么、新增什么」摆给你校准。
- 每个阶段和每个审查角色都以项目自己的约定为依据，而不是每次从头摸索。
- 引擎只守住必须固定的东西：阶段顺序、你的决定、审查结论、证据与材料是否一致。

模型越强，工作流里的逻辑应该越少。新增任何机制之前先问：它是在补上面这三样缺口，还是在规定模型该怎么走？后者不加。

## 引擎守住什么

| 你遇到的问题 | SuperSpec 的机制 |
| --- | --- |
| 「顺手」改了不该改的，加了不该加的方法 | design 的结构变更清单列出本次已批准的结构，代码审查据此判断是否多做；每个任务绑定五字段执行依据（测试 / 设计 / 来源 / 验收 / 边界），引用由状态机校验；实现超出边界时要写结构化的范围说明，而不是一句道歉 |
| 说自己做完了，测过没有无从考证 | 任务开始时冻结证据要求（是否先 RED 再 GREEN 由本轮执行策略决定），测试登记绑定到任务尝试，记下执行者上报的命令、目录与退出码；最近一次通过的测试早于最后一次代码改动时，审查材料和交付会如实说明；全程事件日志带摘要，可回放 |
| 审查抓到了问题，修复时又把新架构夹带回来 | 阻塞问题必须标注类型（漏做 / 破坏已有 / 计划外新增）并**锚定到已批准材料**才能受理，锚点写错可以在同一工作项修正后重交；修复任务只兑现锚点，审查建议里的架构永远不是授权 |
| 审查形同虚设，「看起来没问题」就通过 | 每个 change 都有独立的最终验证（verifier），有代码改动时还有独立的代码审查（code-reviewer），`normal` 档在探索和计划阶段各多一道 critic 审查；派发说明（`superspec jobs dispatch`）由引擎生成，主流程原样转交，报告骨架不带默认结论；pass 必须回执覆盖范围，fail 必须给出可追溯的证据，不阻塞的审查意见在交付时列给使用者 |

这些是流程与事实层面的约束，由引擎在登记时核对：答不出锚点的阻塞问题不予受理，而不是等你在对话里追问。模型怎么调查、怎么实现不在其中。

## 快速开始

要求 Node.js `>=20.19.0`。

```bash
npm install -g @peterxiaoyang/superspec@latest
cd <your-project>
superspec install
```

`superspec install` 会把工作流入口、角色配置和运行时目录同步到当前项目，并准备 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 依赖。已安装的项目升级用 `superspec update`：把 CLI 升到 npm latest，并同步已选宿主的入口与角色配置。

宿主可交互选择，也可以用 `--hosts codex,omp,claude` 指定（可多选）。选 Claude Code 时，入口和角色写到 `.claude/skills`、`.claude/agents`，`CLAUDE.md` 会导入 `AGENTS.md`，并在 `.claude/settings.json` 中只放行 `superspec` 命令；不想改权限就加 `--no-claude-permissions`。之后换宿主，SuperSpec 只清理自己写入且没被改过的文件。这份写入记录是本机文件（`.superspec/install-manifest.json`，不提交），所以新克隆的仓库或从旧版本首次升级时没有记录，换宿主前留下的旧文件需要手动删除。

然后在所选宿主（Codex、Claude Code 或 OMP）里对它说话：

```text
superspec-explore change <change-name>。<你的需求>
```

工作流接管之后，下一步做什么由 `superspec transition next` 决定；每一步里怎么查、怎么做，由 AI 根据仓库事实自己判断，但只在被授权的范围内。

## 工作流入口

| Skill | 作用 |
| --- | --- |
| `superspec-explore` | 调查现状，确认事实和待决策事项 |
| `superspec-propose` | 生成规格、设计和可执行任务 |
| `superspec-apply` | 按已批准任务修改代码并验证 |
| `superspec-review` | 审查实现并完成最终验证 |

修不动会自己拐弯：能由既有任务解释的问题留在 Apply 内闭环；需要改需求、验收或技术取舍的，回到计划阶段重新确认。

## 轻量，且知道自己的边界

- **按 change 选档**：新 change 在探索阶段完成初步调查后，独立选择 `minimal` 或 `normal`；你指定优先，否则由 Agent 按已核实的事实决定。两档的差别只是 `normal` 在探索和计划阶段各多一道独立 critic 审查，并启用计划规模与修复轮次上限（`.superspec/config.json` 的 `workflow.budget`）；代码审查和最终验证两档相同。需要你拍板的业务口径或关键取舍、或会改变对外契约与兼容性时选 `normal`，受影响的文件数量本身不是依据。选择只作用于这个 change，历史 change 沿用项目配置。
- **可升不可降**：`minimal` 之后出现推翻选档依据的新事实时，回到探索阶段升级为 `normal` 补齐审查，这时要维持 `minimal` 只能由你明确决定；`normal` 一旦进入计划或审查就不能降档，回退阶段也不会解除这条约束。
- **不绑架日常**：简单的单文件修改不必走完整工作流；普通请求也不会自动进入 SuperSpec，只有显式调用入口才启动。
- **用项目自己的约定**：项目根 `AGENTS.md`（SuperSpec 区块之外）及其指向的文档是约定来源：宿主会加载它，审查角色以其中成文的约定为审查依据；进入实现前把计划的「实现落点」（逻辑放哪、复用什么、新增什么）交给你校准；change 完成后把本次得到的通用约定整理成候选，经你同意后再补进项目文档。
- **诚实的能力边界**：它是流程与审计辅助，不是安全隔离或发布审批系统；不能替代代码审计、权限控制、合规检查和人工判断。

## 与 OpenSpec 的关系

OpenSpec 负责「这次要改变什么」，提供变更材料与规格结构；SuperSpec 负责「如何在边界内把它交付」，组织 AI 的探索、计划、实现、审查与证据记录。

## 评测

仓库自带密封评测考场（隔离工作区 + 真实 Agent 运行 + 硬门禁 + 双模型语义复盘），用于验证工作流行为本身，而不只是 Prompt 文案。见 [`evals/README.md`](evals/README.md)。

## 致谢

- [OpenSpec](https://github.com/Fission-AI/OpenSpec)
