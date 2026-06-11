# SuperSpec

[![npm version](https://img.shields.io/npm/v/@peterxiaoyang/superspec?style=flat-square)](https://www.npmjs.com/package/@peterxiaoyang/superspec)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen?style=flat-square)](https://nodejs.org)
[![OpenSpec overlay](https://img.shields.io/badge/OpenSpec-overlay-6f42c1?style=flat-square)](https://github.com/Fission-AI/OpenSpec)

> 面向 Codex 的 OpenSpec 增强工作流约束层。

SuperSpec 是一个已经发布的 npm 包，适合已经认可 OpenSpec，但觉得默认流程在执行层还不够严格的团队。

它不替换 OpenSpec，也不改 OpenSpec 的工件关系。  
它做的是在 OpenSpec 现有变更生命周期之上，再加一层更强的执行纪律：

- 先做现状调研，再谈设计是否站得住
- 先明确业务不变量，再做实现
- 先写清测试约束，再避免流于表面的测试
- 先经过多角色审查，再允许宣布“完成”
- 先确认归档保全完整，再真正归档

如果你只想用最原生、最轻量的 OpenSpec，而不想增加审查、测试、归档这些额外门禁，那你大概率不需要 SuperSpec。

SuperSpec 的核心定位是：

- **保留 OpenSpec 作为主流程**
- **把执行约束收敛成可复用的叠加层**
- **让阶段推进依赖证据，而不是模型一句“done”**

## 为什么会有 SuperSpec

很多团队在把 OpenSpec 和编码代理结合起来之后，真正出问题的地方往往不是“没有文档”，而是“有流程形状，但没有流程纪律”。

常见问题是：

- 设计文档在，但不够细，指导不了后续实现
- 测试在，但没有证明真正重要的东西
- 任务打勾了，但缺少强校验
- 主线程自己写、自己审、自己宣布通过
- 归档做了，但辅助证据已经散了

SuperSpec 解决的不是“再造一套 OpenSpec”，而是把这些执行层的薄弱点补上。

## SuperSpec 增加了什么

### 1. 更严格的 propose 阶段

SuperSpec 保留 OpenSpec 的原生四件套工件：

- `proposal`
- `specs`
- `design`
- `tasks`

同时补三类辅助产物：

- `discovery.md`：记录现状调研结果、已有行为、约束边界和需要先确认的问题
- `business-invariants.md`：整理这次变更必须守住的业务不变量，避免实现时把关键业务语义改丢
- `test-contract.md`：把测试覆盖范围、测试编号、约束映射和验证责任提前写清楚

这样 `propose` 阶段就不只是“把文档写出来”，而是真正把设计、约束和测试责任提前收拢。

### 2. 显式的多角色审查分工

SuperSpec 会安装这些项目内角色：

- `architect`
- `critic`
- `test-engineer`
- `code-reviewer`
- `verifier`

这意味着审查在 SuperSpec 里是一个正式阶段，不是实现完成后的附带动作。

### 3. 基于证据的门禁

SuperSpec 的 guard 会检查：

- 阶段进入条件
- 任务修改 / 任务完成 条件
- 审查完成 条件
- 可归档条件与归档保全条件

目标很直接：**阶段推进必须依赖证据，而不是靠模型自述。**

### 4. 更完整的辅助目录与归档保全

每个变更下都会有 `.superspec/` 辅助运行目录，用于保存：

- 辅助产物：补足 OpenSpec 原生工件之外的调研、约束和测试文档
- 证据：保存 RED/GREEN、审查、验证、确认等过程证据
- 审查输出：保存各角色的审查结果和主线程的汇总结论
- 状态文件：保存当前 gate、指纹和阶段状态，便于恢复和重算
- ledger：保存关键事件记录，方便追溯流程推进过程
- 归档保全元数据：确保归档前后能核对辅助目录是否完整保留

这让长任务恢复、阶段审计和归档后追溯更稳定。

## 快速开始

### 环境要求

- Node.js `>= 20.19.0`
- 本机 `PATH` 上可用兼容官方 `@fission-ai/openspec` 的 CLI，版本 `>= 1.4.1`，并支持 SuperSpec 依赖的 OpenSpec native surface
- 目标项目准备使用 OpenSpec + Codex 工作流入口

执行 `superspec init` 时，无论选择 `project` 还是 `user` scope，如果未检测到 `openspec`、检测到 `openspec-chinese` 或其他不兼容变体，或版本低于 `1.4.1`，SuperSpec 都会自动尝试安装 / 升级官方 OpenSpec CLI；遇到全局 bin 被不兼容变体占用时会用覆盖模式重试。

Windows PowerShell 中如果遇到 npm 全局 bin 的 `.ps1` 执行策略报错，请显式使用 `.cmd` shim，例如 `superspec.cmd init --scope project`、`superspec.cmd guard check-init --change <change>`、`openspec.cmd status --change <change> --json`。

### 安装

优先走 npm：

```bash
npm install -g @peterxiaoyang/superspec
```


如果你要固定到 GitHub release tarball，也可以：

```bash
npm install -g https://github.com/PeterYaoYang/SuperSpec/releases/download/v0.1.0/superspec-0.1.0.tgz
```

### 初始化

在项目目录里执行：

```bash
superspec init --scope project
```

如果你就在项目目录里直接运行下面这条，通常也够了：

```bash
superspec init
```

如果你要装到用户级目录，而不是当前项目：

```bash
superspec init --scope user
```

`superspec init` 会安装 SuperSpec 的工作流入口，并校验主路径需要的 OpenSpec Codex 入口。  
如果项目里还没有对应的 OpenSpec 初始化内容，且本机可用 `openspec` CLI，SuperSpec 会自动尝试执行：

- `openspec init --tools codex .`
- 必要时再执行 `openspec update --force .`

也就是说，普通使用场景下，你不需要先手动跑一遍 `openspec init`，直接运行 `superspec init` 就可以。

## 用户可见的工作流入口

SuperSpec 当前暴露的工作流入口是：

- `superspec-explore`
- `superspec-propose`
- `superspec-apply`
- `superspec-review`
- `superspec-archive`

## 安装后会落什么东西

项目级安装时，SuperSpec 会把项目内入口写到 `.codex/`，把变更级运行数据写到 `.superspec/`。

主要辅助目录内容包括：

- `.superspec/artifacts/discovery.md`：记录现状调研、边界澄清和上游事实
- `.superspec/artifacts/business-invariants.md`：记录本次变更必须守住的业务不变量
- `.superspec/artifacts/test-contract.md`：记录测试覆盖矩阵、测试编号和约束映射
- `.superspec/evidence/...`：保存测试、审查、验证、用户确认等证据文件
- `.superspec/superspec-state.json`：保存 guard 重算后的状态摘要和指纹
- `.superspec/ledger.jsonl`：保存关键流程事件，便于审计和追溯

SuperSpec 支持：

- `project` scope
- `user` scope
- 基于清单的 `update`
- 基于清单的 `uninstall`

## 设计原则

```text
→ 叠加，不是替代
→ 证据，不是感觉
→ 审查，不是自我批准
→ 保全，不是归档后失忆
→ 更严格，但不过度做重
```

## 致谢与灵感来源

SuperSpec 的思路不是凭空长出来的。它明显受这些项目影响：

- [OpenSpec](https://github.com/Fission-AI/OpenSpec)
- [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)
- [Superpowers](https://github.com/obra/superpowers)
