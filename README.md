# SuperSpec

[![npm version](https://img.shields.io/npm/v/@peterxiaoyang/superspec?style=flat-square)](https://www.npmjs.com/package/@peterxiaoyang/superspec)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen?style=flat-square)](https://nodejs.org)
[![OpenSpec](https://img.shields.io/badge/OpenSpec-compatible-6f42c1?style=flat-square)](https://github.com/Fission-AI/OpenSpec)

AI 写代码很快。真正慢的是之后：范围悄悄变大、完成全凭一张嘴、review 时问一句「这里为什么要改」它才承认不该改。

SuperSpec 是一套跑在 AI 编程代理（Codex 等）下的需求变更工作流引擎。它把「不要乱改、别过度设计、做完要有证据」从 prompt 劝说升级成**机器门禁**——约束写在 CLI 和数据契约里，不靠模型自觉。

```text
Explore → Propose → Apply → Review → Accepted
```

## 它拦得住什么

| 你遇到的问题 | SuperSpec 的机制 |
| --- | --- |
| 「顺手」改了不该改的，加了不该加的方法 | 每个任务绑定五字段执行依据：测试 / 设计 / 来源 / 验收 / 边界，引用可解析性由状态机校验；实现越界必须走结构化的范围说明，而不是一句道歉 |
| 说自己做完了，测过没有无从考证 | 任务启动即冻结证据要求：该 RED 的先失败、该 GREEN 的真通过，测试证据绑定任务尝试；全程事件日志带摘要，可回放、防篡改 |
| 审查抓到了问题，修复时又把新架构夹带回来 | 阻塞问题必须标注类型（漏做 / 破坏已有 / 计划外新增）并**锚定到已批准材料**才能受理；修复任务的指令只兑现锚点，审查建议里的架构永远不是授权 |
| 审查形同虚设，「看起来没问题」就通过 | critic / architect / test-engineer / code-reviewer / verifier 独立角色持密封工作项审查，pass 必须说明覆盖了什么，fail 必须给出可追溯的证据 |

这些约束全部由引擎在提交口强制执行：答不出锚点的阻塞问题直接拒收，而不是等你在对话里追问。

## 快速开始

要求 Node.js `>=20.19.0`。

```bash
npm install -g @peterxiaoyang/superspec@latest
cd <your-project>
superspec install
```

`superspec install` 会把工作流入口、角色配置和运行时目录同步到当前项目，并准备 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 依赖。

然后在 Codex 里对它说话：

```text
superspec-explore change <change-name>。<你的需求>
```

工作流接管之后，每一步该做什么由 `superspec transition next` 决定——AI 不自由发挥流程，只在被授权的范围内干活。

## 工作流入口

| Skill | 作用 |
| --- | --- |
| `superspec-explore` | 调查现状，确认事实和待决策事项 |
| `superspec-propose` | 生成规格、设计和可执行任务 |
| `superspec-apply` | 按已批准任务修改代码并验证 |
| `superspec-review` | 审查实现并完成最终验证 |

修不动会自己拐弯：能由既有任务解释的问题留在 Apply 内闭环；需要改需求、验收或技术取舍的，回到计划阶段重新确认。

## 轻量，且知道自己的边界

- **三档强度**：`minimal` / `normal` / `strict`（`.superspec/config.json`），按变更风险选择计划阶段的审查强度。
- **不绑架日常**：简单的单文件修改不必走完整工作流；普通请求也不会自动进入 SuperSpec，只有显式调用入口才启动。
- **诚实的能力边界**：它是流程与审计辅助，不是安全隔离或发布审批系统；不能替代代码审计、权限控制、合规检查和人工判断。

## 与 OpenSpec 的关系

OpenSpec 负责「这次要改变什么」，提供变更材料与规格结构；SuperSpec 负责「如何在边界内把它交付」，组织 AI 的探索、计划、实现、审查与证据记录。

## 评测

仓库自带密封评测考场（隔离工作区 + 真实 Agent 运行 + 硬门禁 + 双模型语义复盘），用于验证工作流行为本身，而不只是 Prompt 文案。见 [`evals/README.md`](evals/README.md)。

## 致谢

- [OpenSpec](https://github.com/Fission-AI/OpenSpec)
