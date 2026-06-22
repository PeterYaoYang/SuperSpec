# SuperSpec

[![npm version](https://img.shields.io/npm/v/@peterxiaoyang/superspec?style=flat-square)](https://www.npmjs.com/package/@peterxiaoyang/superspec)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen?style=flat-square)](https://nodejs.org)
[![OpenSpec](https://img.shields.io/badge/OpenSpec-compatible-6f42c1?style=flat-square)](https://github.com/Fission-AI/OpenSpec)

> SuperSpec 是一套“先想清楚，再动手”的工作流。

它解决的是一个很常见的问题：AI 编程工具写代码很快，但有时候还没搞清楚需求、现有代码和测试边界，就已经开始改文件了。

SuperSpec 会把一次需求变更拆成 5 步：

```text
探索需求 -> 写方案 -> 做实现 -> 做审查 -> 归档收尾
```

这样做的目的很简单：

- 改代码前先弄清楚现状
- 写实现前先有方案和任务
- 任务完成前先有测试或验证记录
- 宣布完成前先经过审查
- 归档时保留关键过程记录

## 适合谁

适合已经在用 AI 编程工具或命令行代理做项目开发，并希望流程更稳一点的团队或个人。

如果你遇到过这些情况，SuperSpec 会有帮助：

- 需求还没说清楚，AI 就开始写代码
- 方案写得很粗，后面实现时靠猜
- 测试只跑了命令，但没人说明它证明了什么
- 代码写完后缺少真正的审查
- 过几天想回看当时为什么这么改，却找不到过程记录

如果你只是想让 AI 快速改一个很小的文件，且不需要完整方案、审查和记录，那 SuperSpec 可能会显得偏重。

## 和 OpenSpec 有什么区别

一句话区别：

```text
OpenSpec 管“这次要改什么”。
SuperSpec 管“AI 应该怎样把这次改动做稳”。
```

更具体一点：

| 问题 | OpenSpec 主要负责 | SuperSpec 额外补上 |
|---|---|---|
| 这次变更是什么 | 方案、规格、设计、任务和归档 | 要求 AI 在写方案前先调查现状 |
| 方案怎么写 | 提供标准的变更文档结构 | 要求方案前后有范围、风险、业务约束和测试思路 |
| 代码怎么做 | 记录任务清单和完成状态 | 要求按任务实现，并留下测试或验证记录 |
| 做完怎么算稳 | 可以校验规格和归档 | 增加代码审查、架构审查、反方审查和最终验证 |
| 以后怎么追溯 | 保留 OpenSpec 的变更文档 | 额外保留探索、测试、审查和收尾记录 |

举个例子：

OpenSpec 会帮你记录“要增加登录功能、需要哪些规格、设计和任务”。
SuperSpec 会进一步要求 AI 先看看现有登录/权限代码在哪里、哪些业务规则不能破坏、哪些场景必须测试、实现后要经过哪些审查，最后再归档。

所以 SuperSpec 不是 OpenSpec 的替代品。它更像是 OpenSpec 外面的一层执行纪律，专门约束 AI 编程工具不要跳过关键步骤。

## 快速开始

### 1. 安装

```bash
npm install -g @peterxiaoyang/superspec@latest
```

需要 Node.js `>= 20.19.0`。

### 2. 初始化当前项目

进入你的项目根目录，然后运行：

```bash
superspec install
```

这条命令的意思是：把 SuperSpec 当前可用的工作流入口安装到项目里。
当前 beta 会安装 `.superspec/` 引擎目录、`.codex/skills/superspec-*` 阶段入口、`.codex/prompts/*.md` 角色 prompt、`.codex/agents/*.toml` 子智能体配置，并补齐 `.codex/config.toml` 的多 agent 开关。`superspec init --scope project` 仍作为兼容别名可用。

Windows PowerShell 如果拦截 npm 的 `.ps1` 脚本，请改用：

```powershell
superspec.cmd install
```

### 3. 按步骤使用

在你使用的 AI 编程工具或 CLI 里，按下面的阶段入口推进。不同工具的触发方式可以不同，但入口名和顺序保持一致。

开始时先探索需求：

```text
使用 superspec-explore，帮我梳理这个需求：……
```

探索完成后，写正式方案：

```text
使用 superspec-propose，把刚才的探索结果整理成方案。
```

方案确认后，开始实现：

```text
使用 superspec-apply，按任务实现。
```

实现完成后，审查：

```text
使用 superspec-review，检查实现、测试和风险。
```

审查通过后，归档：

```text
使用 superspec-archive，归档这个变更。
```

## 五个入口分别做什么

| 入口 | 什么时候用 | 它会要求做什么 |
|---|---|---|
| `superspec-explore` | 需求刚开始时 | 读代码、查现状、整理范围和风险；这一步不改业务代码 |
| `superspec-propose` | 需求已经清楚后 | 写正式方案、规格、设计和任务，并提前规划测试 |
| `superspec-apply` | 方案通过后 | 按任务实现代码，记录测试或验证结果 |
| `superspec-review` | 实现完成后 | 做代码审查、架构审查、反方审查和最终验证 |
| `superspec-archive` | 审查通过后 | 用 OpenSpec 完成归档，并检查关键记录是否保留 |

你日常主要记住这五个入口就够了。

CLI 不带 `--risk` 时默认走完整审查路径；需要轻量路径时显式传 `--risk normal` 或 `--risk minimal`。探索阶段会创建 `critic` 工作项审查需求澄清记录；计划阶段会创建 `critic`、`architect` 和 `test-engineer` 工作项后再进入实现准备。

## 它会多保存哪些记录

SuperSpec 会在每次变更下面保存一些辅助记录，方便后续追溯。

主要包括：

- 探索记录：这次需求是什么、当前代码是什么情况、有哪些风险
- 业务约束：哪些业务规则不能被改坏
- 测试约定：哪些场景必须验证
- 实现记录：每个任务怎么验证通过
- 审查记录：谁检查了什么、发现了什么、最后为什么通过或退回

这些记录默认放在：

```text
openspec/changes/<变更ID>/.superspec/
```

这里的 `<变更ID>` 就是一次需求变更的名字。

`.superspec/` 要不要提交到 git，由你的团队决定。
如果不提交，删掉后就没有 git 历史可以恢复。

## Hook 会做什么

SuperSpec 默认安装的 hook 只在子智能体启动和停止时运行：

- 子智能体启动和停止时：记录这次子智能体运行的基本信息

这些 hook 的默认超时时间是 `120` 秒。这个时间限制的是 hook 自己的检查过程，不限制 `npm test`、构建命令或子智能体本身能运行多久。

hook 不是安全沙箱。默认 hook 只留下子智能体审计线索；它不会机械阻止写入，也不能把记录变成不可伪造的安全证明。

## 重要边界

SuperSpec 能让流程更规范，但它不是安全锁。

它能帮助你：

- 减少 AI 还没想清楚就改代码的情况
- 让测试、审查和用户确认留下记录
- 在进入下一步前提醒缺少什么
- 让一次变更之后更容易回看原因

它不能保证：

- 阻止人手动绕过流程直接改文件
- 阻止人删除过程记录
- 阻止恶意伪造记录
- 替代正式的安全审计、合规审计或法律证明

也就是说，SuperSpec 目前是“流程纪律 + 审计辅助工具”，不是“强制安全系统”。默认 hook 只增强子智能体活动的可见性；显式/manual `PreToolUse` 才会进入保守写入策略，但仍然不能替代正式的安全控制。

## 常用命令

查看当前 SuperSpec CLI 版本：

```bash
superspec --version
```

安装到当前项目：

```bash
superspec install
```

`superspec init --scope project` 是兼容别名，也会执行同一套安装逻辑。

### OpenSpec 中文输出

OpenSpec 生成文档的语言应通过官方项目配置控制。在 `openspec/config.yaml` 中使用 `context`：

```yaml
schema: spec-driven

context: |
  语言：中文（简体）
  所有产出物必须用简体中文撰写。
```

`superspec install` 会创建缺失的 `openspec/config.yaml`，或在没有顶层 `context` 时追加这段官方中文 context。如果文件已经有顶层 `context`，SuperSpec 不会覆盖它。

可以用下面的命令检查生成的 instructions 是否包含语言上下文：

```bash
openspec instructions proposal --change <change>
```

检查当前项目的 OpenSpec 探测结果：

```bash
superspec status
```

同步当前项目的 SuperSpec 工作流入口：

```bash
superspec update
```

这条命令会先检查 npm 上的 latest 版本；如果有新版，会自动执行全局升级并用新版 CLI 重新同步项目入口。同步内容包括补齐 `.superspec/changes` 运行时目录，并把当前 CLI 内置的 `.codex/skills/superspec-*`、`.codex/prompts/*.md`、`.codex/agents/*.toml` 同步到项目里。

## 进阶信息

以当前内置的 Codex 适配器为例，初始化后项目里会出现这些入口文件：

```text
.codex/
  skills/superspec-explore/
  skills/superspec-propose/
  skills/superspec-apply/
  skills/superspec-review/
  skills/superspec-archive/
  prompts/architect.md
  prompts/code-reviewer.md
  prompts/critic.md
  prompts/executor.md
  prompts/explore.md
  prompts/test-engineer.md
  prompts/test-runner.md
  prompts/verifier.md
  agents/architect.toml
  agents/code-reviewer.toml
  agents/critic.toml
  agents/executor.toml
  agents/explore.toml
  agents/test-engineer.toml
  agents/test-runner.toml
  agents/verifier.toml
  config.toml
```

当前 beta 的阶段入口由 `superspec transition next --change <变更ID>` 驱动，不再提供旧版 `superspec check ...` surface。

如果你要开发 SuperSpec 本身：

```bash
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

更多细节见：

- `docs/plans/SUPERSPEC_TRANSITION_ENGINE_SPEC_LITE.md`：transition engine 设计
- `templates/workflow/skills/superspec-*/SKILL.md`：当前 Codex 适配器使用的阶段入口说明

## 致谢与灵感来源

- [OpenSpec](https://github.com/Fission-AI/OpenSpec)
- [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)
- [Superpowers](https://github.com/obra/superpowers)
