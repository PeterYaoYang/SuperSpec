# SuperSpec

[![npm version](https://img.shields.io/npm/v/@peterxiaoyang/superspec?style=flat-square)](https://www.npmjs.com/package/@peterxiaoyang/superspec)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen?style=flat-square)](https://nodejs.org)
[![OpenSpec](https://img.shields.io/badge/OpenSpec-compatible-6f42c1?style=flat-square)](https://github.com/Fission-AI/OpenSpec)

SuperSpec 是一套面向 AI 编程代理的需求变更工作流。它在 OpenSpec 材料之上增加阶段控制、审查和验证记录，帮助 AI 从需求理解推进到可回放的交付结果。

```text
Explore → Propose → Apply → Review → Accepted
```

SuperSpec 适合跨模块、涉及接口或需要方案审查的变更。简单的单文件修改不必强行使用完整工作流。普通请求也不会自动进入 SuperSpec，只有明确调用对应入口或继续已有 change 时才会启动。

## 安装

要求 Node.js `>=20.19.0`。

```bash
npm install -g @peterxiaoyang/superspec@latest
cd <your-project>
superspec install
```

`superspec install` 会把工作流入口、角色配置和运行时目录同步到当前项目，并准备 OpenSpec 依赖。`superspec init --scope project` 是兼容别名。

检查安装：

```bash
superspec version
superspec status
```

## 工作流入口

在 Codex 中显式调用对应 Skill。新需求通常从 `superspec-explore` 开始；已有 change 则从当前阶段继续。

| Skill | 作用 |
| --- | --- |
| `superspec-explore` | 调查现状，确认事实和待决策事项 |
| `superspec-propose` | 生成规格、设计和可执行任务 |
| `superspec-apply` | 按已批准任务修改代码并验证 |
| `superspec-review` | 审查实现并完成最终验证 |

工作流会根据问题性质留在当前阶段修复，或回到计划阶段重新确认需求、验收和技术取舍。

## 配置

项目级配置位于 `.superspec/config.json`。未创建配置或未声明模式时，默认使用 `normal`：

```json
{
  "workflow": {
    "mode": "normal",
    "hosts": ["codex"]
  }
}
```

可选模式为 `minimal`、`normal` 和 `strict`。模式主要影响计划阶段的审查强度；最终代码审查和验证仍由 Review 阶段负责。

## 与 OpenSpec 的关系

OpenSpec 负责变更材料和规格结构；SuperSpec 负责组织 AI 的探索、计划、实现、审查与证据记录。两者互补：

```text
OpenSpec：这次要改变什么
SuperSpec：如何在边界内把它交付
```

## 设计边界

SuperSpec 是流程和审计辅助工具，不是安全隔离或发布审批系统。它不能替代代码审计、权限控制、合规检查和人工判断。

## 致谢

- [OpenSpec](https://github.com/Fission-AI/OpenSpec)
