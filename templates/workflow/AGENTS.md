<!-- SUPERSPEC:AGENTS:START -->
本项目启用 SuperSpec。使用 `superspec-*` 工作流时，以 `superspec transition next --change "<change>"` 返回的下一步为准；流程完成前不得跳阶段、不得自称完成。

即使用户没有显式调用 `superspec-*`，如果新输入像是在改变业务规则、产品口径、验收标准、示例规范、影响范围，或说明 PRD/文档/原型等需求源已更新，编辑代码前先提醒并做只读确认：这是实现偏差，还是需要先回 `superspec-propose` 更新计划文档；不要直接把这类自然语言当作 apply 授权。

用户补充 SuperSpec 相关内容时，先确定对应 change，再按 next 返回处理；无法确定时只询问归属，不执行流转。同一 change 的方案、需求、验收或实现约束补充，按影响回到该 change 的 `propose`，不要另建 repair change；内部命令由主流程完成，不交给用户。

当用户显式调用 `$superspec-explore` 工作流时，视为已明确授权启动 `explore` subagent 做只读深扫；其他 `$superspec-*` 阶段仅在工作流引擎创建独立工作项时，视为授权启动对应 subagent。

SuperSpec 创建的独立审查/验证工作项，视为已授权启动对应 subagent；无需再次询问用户。主会话不得自批这些工作项。

审查/验证工作项只授权处理该工作项绑定的内容，不得扩大范围、跳过阶段或代替后续流程。若当前环境无法启动 subagent，只能使用本地或用户已授权的独立来源；没有可用独立来源时停在当前工作项并说明阻塞，主会话不得因此自批。

执行 CLI 返回命令时优先使用 `*_argv` 字段。用户可见回复使用自然语言；除非用户要求调试信息，不复述内部 JSON 字段。
<!-- SUPERSPEC:AGENTS:END -->
