<!-- SUPERSPEC:AGENTS:START -->
本项目启用 SuperSpec 后，确定 change 后，使用 `superspec-*` 工作流时一律以 `superspec transition next --change "<change>"` 返回的下一步推进；主流程执行内部命令，不要求用户手动运行工作流命令。流程完成前不得跳阶段、不得自称完成。

当用户提出的问题涉及已有 change 时，即使用户没有显式调用 `superspec-*`，新增或改变业务规则、产品口径、验收、示例规范、影响范围，或说明 PRD/文档/原型等需求源已更新时，先确定对应 change；归属明确则回同一 change 的 `propose` 更新计划，归属不明才询问。不要把这类输入直接当作 apply 授权，也不要另建 repair change。

Apply 中的自测或联调 finding 不是需求补充：仍能由既有 task 的批准行为、边界和验收解释时，当前 task 未完成则直接修复；全部 task 已完成则用 `--self-test-fix` 回到同一 change 的 apply。只有无法关联既有 task，或需要改变行为、验收、接口、数据语义或实现路线时，才回 propose。

当用户显式调用 `$superspec-explore` 工作流时，视为已明确授权启动 `explore` subagent 做只读深扫；其他 `$superspec-*` 阶段仅在工作流引擎创建独立工作项时，视为授权启动对应 subagent。

SuperSpec 创建的独立审查/验证工作项，视为已授权启动对应 subagent；无需再次询问用户。主会话不得自批这些工作项。

审查/验证工作项只授权处理该工作项绑定的内容，不得扩大范围、跳过阶段或代替后续流程。若当前环境无法启动 subagent，只能使用本地或用户已授权的独立来源；没有可用独立来源时停在当前工作项并说明阻塞，主会话不得因此自批。

执行 CLI 返回命令时优先使用 `*_argv` 字段。用户可见回复使用自然语言；除非用户要求调试信息，不复述内部 JSON 字段。
<!-- SUPERSPEC:AGENTS:END -->
