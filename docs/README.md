# SuperSpec 文档入口

本目录保留 SuperSpec 的规范、设计、审计和执行交接文档。整理规则：当前入口层只放仍需优先阅读的文档；开发过程中生成的审计、设计、计划和历史草案分别归档到子目录。

## 阅读顺序

1. `SPEC.md`：当前单一规范源。实现、修改和审查以它为准。
2. `DISTRIBUTION.md`：安装、升级、卸载和 npm 分发方案。
3. `designs/WORKFLOW_CONTEXT_PACKET_FIRST_MERGED_DESIGN.md`：工作流上下文占用压缩合并方案；继续做 packet-first 瘦身或 OpenSpec bridge 迁移时先读。
4. `plans/MASTER_FIX_PLAN_2026-06-10.md`：2026-06-10 审计修复的总控入口；只在继续该批修复时阅读。
5. `audits/WORKFLOW_FULL_AUDIT_2026-06-10.md`：最新全面审计报告；查问题来源和证据时阅读。

## 目录地图

| 目录 | 内容 | 使用方式 |
|---|---|---|
| `.` | `SPEC.md`、`DISTRIBUTION.md`、本文 | 当前入口与权威文档 |
| `designs/` | 正在或曾经用于实现的专题设计 / RFC | 需要理解某个机制设计时阅读；若与 `SPEC.md` 冲突，以 `SPEC.md` 为准 |
| `audits/` | 审计报告、评审发现、proof gap 清单 | 查证问题、风险和历史判断；不直接作为实施规范 |
| `plans/` | 修复计划与交接手册 | 执行既定修复批次时使用 |
| `history/` | 早期草案和已被取代的方案 | 仅用于设计取舍追溯，不作为当前实施依据 |
| `templates/` | sidecar artifact 模板与配置模板 | 规范定义的产物模板 |

## 权威性规则

- `SPEC.md` 是当前规范源。
- `DISTRIBUTION.md` 只负责分发/安装语义；guard 门禁语义仍以 `SPEC.md` 和实现为准。
- `audits/` 和 `plans/` 记录问题与执行批次，不自动覆盖 `SPEC.md`。
- `history/` 下文档默认是历史对照，除非 `SPEC.md` 明确重新采纳其中条款。
