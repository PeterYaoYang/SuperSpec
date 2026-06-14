# SuperSpec v2 Hook 合约

状态：已实现为 audit-only fallback。严格 profile 只有在目标 Codex 环境同时通过 R-1 deny 验证和 hook-only provenance 验证后才可启用。

默认托管安装只启用子智能体审计：`.codex/hooks.json` 只注册 `SubagentStart` 和 `SubagentStop`，不注册 `PreToolUse` 或 `PostToolUse`。`PreToolUse` 与 `PostToolUse` 的 Guard API 仍保留给显式/manual manifest 或未来实验性的 strict/test-telemetry manifest。

## 入口

- `superspec-hook --change <change>` 从 stdin 读取 Codex hook JSON event。
- 面向 Guard 的 API：
  - `superspec guard hook-check-write --change <change> --event-ref <json>`
  - `superspec guard hook-check-command --change <change> --event-ref <json>`
  - `superspec guard hook-record-test --change <change> --event-ref <json>`
  - `superspec guard hook-record-subagent-start --change <change> --event-ref <json>`
  - `superspec guard hook-record-subagent-stop --change <change> --event-ref <json>`
  - `superspec guard hook-health --change <change>`
  - `superspec guard hook-session-begin/status/end --change <change> ...`

adapter 会规范化 event 并调用 Guard API。显式/manual `PreToolUse` event 无法解析 change 时，会对 SuperSpec state roots、archive 命令、内部 hook writer、非可信生命周期终止、仓库外 target、歧义 active session 等路径采取保守 fail-closed 检查。默认子智能体 telemetry 是 best-effort：无法解析 change 时返回成功诊断，不阻塞 workflow。

## 信任模型

当前 strict decision 输出固定为：

```json
{
  "strict_profile": "unavailable",
  "trust": "audit-only"
}
```

必须降级的原因包括 `r1_deny_spike_not_passed` 和 `hook_provenance_unavailable`；托管 hook manifest 缺失或不匹配时还会加入 `hook_manifest_missing_or_unmanaged`。

`--event-ref`、stdin JSON、环境变量、event id、token-like 字段都只是输入数据。它们不能证明 event 来自 Codex hook runner。直接 CLI 调用和复制/重放 event 可以生成 audit telemetry，但绝不能生成 trusted evidence、trusted runlog 或 trusted active session。

`hook-session-begin/status/end` 和 active-session 记录不会持久化或回显 lifecycle-token / entrypoint-token。兼容输入 `--lifecycle-token` 会被忽略。`hook-session-end` 只有在 terminal Guard condition 通过后才能关闭 audit-only lease：`completed` 需要 `review_complete`，`archived` 需要 `check-archived`。`cancelled` 与 `abandoned` 当前只返回诊断，因为缺少可信终止来源。这个设计能在已证明的 terminal state 后让普通工作回到 inert pass-through 行为，但在 R-1/provenance 不可用时仍不会声称 trusted session-close。

## 执行行为

- 默认托管 manifest：只运行 `SubagentStart` 和 `SubagentStop`。普通文件写入与 Bash/test command completion 默认不会经过 SuperSpec hooks。
- 显式/manual `PreToolUse` manifest：没有 active SuperSpec session 时，普通非 SuperSpec project writes pass-through。SuperSpec state roots 会被 deny 或让 strict health 失败。
- 显式/manual `PreToolUse` manifest 且存在 active audit-only session 时：scoped writes、task checkbox 变更、受保护的 OpenSpec canonical edits、early archive 命令、内部 hook writer 调用、corrupt session、unknown write target 都会 fail closed。
- workflow activation 创建 hook-runtime state 之后，如果 active-session state 缺失或被删除，scoped/protected/unknown SuperSpec writes 会 fail closed；从未 active 的 repo/change 仍对普通非 SuperSpec writes 保持 inert/pass-through。
- 多个 active session 且未设置 `SUPERSPEC_CHANGE` 时，write-capable events fail closed；调用方必须设置 change id 或关闭 stale leases。
- State-root 检查是针对 `.superspec/**`、`.codex/superspec/**`、`openspec/changes/*/.superspec/**` 的路径相交检查；当操作可能覆盖、删除或触碰这些 SuperSpec state roots 时，`.codex` 或 `openspec/changes/<change>` 这类父目录也会被 deny。Codex 自有配置和扩展面，例如 `.codex/hooks.json`、`.codex/config.toml`、`.codex/skills/**`、`.codex/prompts/**`、`.codex/agents/**`、`.omx/state/**`，不属于 SuperSpec hook 保护范围。
- OpenSpec canonical 检查只覆盖当前 change 路径下的 `openspec/changes/<change>/{proposal.md,design.md,tasks.md,specs/**}`；`docs/design.md` 或 `src/specs/*` 这类普通项目文件，在无 session 时保持 pass-through。
- 无 active session 的 unsupported write surfaces 会以 audit-only downgrade pass-through，除非 adapter 收到的 event 含有明确触碰 SuperSpec trust roots 的 write-capable text。active session 下的 unsupported scoped writes 会 fail closed。Node REPL、unified exec 和类似 exec-like surfaces 仍为 strict-unavailable，除非 hook runner 真实把它们的 event 送到 adapter。
- `PostToolUse` 默认不安装。显式/manual manifest 中，它只为被分类为 test 或 validation 的命令写 audit telemetry。
- `SubagentStart/Stop` 默认安装，只写 best-effort audit telemetry。缺少 change context、默认 subagent event malformed 或 telemetry 写入失败时，返回成功诊断，不阻塞 workflow。

## Strict Evidence 前置条件

严格 runtime test evidence 需要 trusted hook provenance、Guard token binding、command fingerprint、数值 exit code、hook event id、raw log pinned refs，以及语义 status/exit code 一致性。

严格 role evidence 需要 trusted matching `SubagentStart` 和 `SubagentStop` 记录、expected role 与 output binding。Audit-only runlog records 不能满足 strict role gates。

## Audit-only 残余路径

- 人工确认和用户意图。
- 默认 hooks 不会物理拦截写入或测试命令完成。
- 当前 Codex invocation 的 R-1 physical deny 未通过。
- 复杂 Bash、shell wrappers、package scripts、`unified_exec`，以及保守分类器覆盖不到的 archive-like filesystem moves。
- Unsupported MCP、Node REPL 和 exec-like write surfaces。
- 直接调用 `hook-record-*`、`hook-session-*` 或 `superspec-hook` CLI。
- 复制/重放 hook stdin、环境变量、event id、entrypoint/lifecycle tokens 或 decision tokens。
- Hooks 被禁用、不可信、非托管、未加载，或缺少 adapter provenance。
