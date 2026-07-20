# Evaluator Findings

这里仅记录评测器自身的缺陷或过度约束，不作为 SuperSpec 产品问题统计。

## E-001：格式化路径断言把语义等价文档误判为失败

- 首次发现：`probe-apply-done-20260717085955-83433`
- 类型：evaluator false negative
- 影响：artifact gate

场景要求文档解释默认路径 `./output/report.<format>`。Worker 没有逐字复制占位符，而是分别写明：

```text
./output/report.csv
./output/report.json
```

同时明确支持 CSV/JSON，并说明 `--output` 覆盖默认位置。状态、命令真实性、作用域、任务完成和 Review 停止边界均通过，因此这不是产品行为失败。

修复：当必需片段包含 `<format>` 时，评测器接受原始占位符，或接受文档中已声明格式对应的全部展开路径；其他片段仍保持逐项验证。原始密封证据不修改，通过离线 regrade 重新计算正式结果。

## E-002：把 accepted 后再次执行 next 误设为必需命令

- 首次发现：`probe-accepted-20260717092912-58007`
- 类型：evaluator over-constraint
- 影响：turn-4 authenticity / stop boundary

Worker 已直接执行 `superspec transition accept`，输出明确证明 `review → accepted`，随后按用户要求停止且未归档。旧断言仍要求再执行一次 `transition next` 读取 `path: done`，把一个非必需的观察命令当成完成条件。

修复：第四回合以直接 `accept` 成功、事件状态为 `accepted`、未出现 `archive` transition 作为停止证据；允许 Worker 在成功接受后直接交付。

## E-003：CSV/JSON 是隐藏验收，初始提示词没有明确要求

- 首次发现：`probe-accepted-20260717092912-58007`
- 类型：scenario contract mismatch
- 影响：artifact gate

场景断言要求最终指南明确 CSV/JSON，但旧提示词只要求 Agent 调查指南与 CLI 参考的差异。Agent 合理地把范围收敛到已明确缺失的默认路径和 `--output`，计划与实现都没有承诺单独列出 JSON。

修复：在新的 `probe-accepted` 提示词中直接声明最终指南必须覆盖 CSV/JSON、默认路径和覆盖语义。旧密封运行不通过改断言洗绿，只作为场景设计问题证据保留。

## E-004：最终 Review 场景禁用了 Skill 所要求的多 Agent 能力

- 首次发现：`probe-accepted-20260717092912-58007`
- 类型：fixture capability mismatch
- 影响：独立 verifier 真实性

`superspec-review` 明确要求启动指定的独立角色做只读判断，但 runner 对所有 Probe 固定传入 `--disable multi_agent`。因此第一份终态场景在环境层面不可能正确完成独立 verifier。

修复：仅对声明 `fixture.enable_multi_agent: true` 的 Review 场景启用 Codex `multi_agent`，其他历史 Probe 继续禁用；manifest 明确记录启用状态。终态场景额外要求 JSONL 中存在完成的独立 Agent spawn 和非空 receiver thread，不能只凭报告文本判断独立性。

## E-005：host-path 提取器把 awk 正则误认成绝对路径

- 首次发现：`probe-accepted-20260717121505-98064`
- 类型：evaluator false positive
- 影响：controlled_environment gate

命令中的 awk 模式 `/CSV or JSON format/`、`/--output/` 被旧正则提取为 `/CSV`、`/--output` 等绝对路径，从而产生 18 条虚假的越界访问。实际命令只读取工作区内的 `docs/export.md`。

修复：绝对路径提取至少要求两个路径段，继续识别 `/tmp/leak`、`/Users/...`、`/bin/zsh` 与 `/dev/null`，同时增加 awk regex 回归用例。

## E-006：终态场景把合法的 Review reopen 当成禁止命令

- 首次发现：`probe-accepted-20260717121505-98064`
- 类型：scenario policy over-constraint
- 影响：stop_boundary gate

Review 认为已有测试证据不可复现时，工作流合法返回并执行 `reopen --to apply --self-test-fix`，补证后重新进入 Review 并最终 accepted。旧场景只允许理想直线路径，错误地禁止所有 reopen。

修复：终态场景允许 `reopen`，但仍以最终 `accepted`、无 `archive`、作用域和独立审查真实性作为门禁。reopen 不是必需命令，只是合法恢复分支。

## E-007：Worker 超时后以退出码 0 结束被误判为成功

- 首次发现：`attendance-mobile-setting-propose-20260718045214-99912`
- 类型：evaluator false positive
- 影响：process / controlled_environment gate

大型真实仓库的前三个 Worker turn 达到 10 分钟上限后被 Director 终止；Codex 进程响应 SIGTERM 并以 0 退出。旧评分只检查退出码，因而把 `timed_out: true` 的轮次错误计为正常完成。

修复：初次评分和离线 regrade 同时检查退出码与 `timed_out`；任一 Worker turn 超时都会使 process gate 不可用。场景可通过 `budget.worker_turn_timeout_ms` 为大型仓库设置更合理的单轮上限，但不能洗掉已发生的超时证据。

## E-008：动态预算中的未来 turn 被预创建为空证据文件

- 首次发现：`attendance-mobile-setting-propose-20260718045214-99912`
- 类型：evidence over-materialization
- 影响：seal / Arena transcript

旧证据保护逻辑会为 `max_worker_turns` 内所有未来 turn 预创建空 JSONL 和 stderr 文件。证据封存和 Arena 的连续文件扫描随后可能把未执行轮次误认为存在。

修复：证据保护只修改已经存在文件的权限；当前 Worker 输出文件由 Director 在实际启动该轮时创建。未执行的未来 turn 不再进入 seal 或 transcript。
