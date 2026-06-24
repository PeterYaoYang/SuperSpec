<!-- SUPERSPEC:AGENTS:START -->
# SuperSpec

本项目启用 SuperSpec。使用 `superspec-*` 工作流时，以 `superspec transition next --change "<change>"` 返回的下一步为准；流程完成前不得跳阶段、不得自称完成。

SuperSpec 创建的独立审查/验证工作项，视为已授权启动对应 subagent；无需再次询问用户。主会话不得自批这些工作项。

审查/验证工作项只授权处理该工作项绑定的内容，不得扩大范围、跳过阶段或代替后续流程。若当前环境无法启动 subagent，只能使用本地或用户已授权的独立来源；没有可用独立来源时停在当前工作项并说明阻塞，主会话不得因此自批。

执行 CLI 返回命令时优先使用 `*_argv` 字段。用户可见回复使用自然语言；除非用户要求调试信息，不复述内部 JSON 字段。
<!-- SUPERSPEC:AGENTS:END -->
