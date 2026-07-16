<!-- SUPERSPEC:AGENTS:START -->
只有当用户显式调用 `superspec-*`，或明确要求继续处理某个已有 SuperSpec change 时，才进入或续转 SuperSpec 工作流。普通开发、修复、排查、测试或审查请求，即使项目已安装 SuperSpec，也不得自行启动工作流、创建 change、执行 `transition next`，或切换到某个 `superspec-*` 阶段。

一旦用户已显式启动工作流或明确指定 change，使用 `superspec-*` 工作流时一律以 `superspec transition next --change "<change>"` 返回的下一步推进；主流程执行内部命令，不要求用户手动运行工作流命令。流程完成前不得跳阶段、不得自称完成。

每完成 `next` 返回的当前事项（材料更新、用户答复回写、实现、验证、审查或修复时），立即再次运行 `superspec transition next --change "<change>"` 并继续处理。完成单个事项不等于完成整个 change；只有工作流明确需要用户决定、当前独立工作项尚未返回结果、遇到真实阻塞或整个 change 已完成时才暂停。

当用户显式调用 `$superspec-explore`，或明确要求继续处于 Explore 的已有 change 时，视为已明确授权启动 `explore` subagent 做只读深扫；其他 `$superspec-*` 阶段仅在工作流引擎创建独立工作项时，视为授权启动对应 subagent。

Explore 中需要用户决定业务、验收、范围或关键取舍时，先简要说明当前理解、影响和建议，再一次只请用户决定一件事；收到明确答复后，更新相关 discovery 结论，再继续工作流。其他阶段要求用户确认、选择处理方向或补齐材料时，按当前工作流返回的要求登记结论或更新相应材料；不得把这类答复默认写入 discovery。

当前 change 的自测、联调或用户指出的问题若仍能由既有 task 的批准行为、边界和验收解释，就在同一 change 内处理：

- 当前 task 尚未完成时，在其范围内直接修复；不要为同一实现问题新增 task 或回 propose。
- 所有 task 已完成后，若问题仍能关联一个已完成 task、且不改变已批准行为和方案，主流程执行 `superspec transition reopen --change "<change>" --to apply --self-test-fix "<task>" --reason "<reason>"`，让工作流创建修复事项；随后继续 `next`，不得手改 tasks。
- 无法关联既有 task，或需要改变行为、验收、接口、数据语义或实现路线时，才回 propose。

在用户已显式启动工作流或明确指定 change 后，若新增或改变业务规则、产品口径、验收、示例规范、影响范围，或说明 PRD/文档/原型等需求源已更新时，先确定对应 change；归属明确则回同一 change 的 `propose` 更新计划，归属不明才询问。不要把这类输入直接当作 apply 授权，也不要另建 repair change。

SuperSpec 创建的独立审查/验证工作项，视为已授权启动对应 subagent；无需再次询问用户。主会话不得自批这些工作项。

审查/验证工作项只授权处理该工作项绑定的内容，不得扩大范围、跳过阶段或代替后续流程。若当前环境无法启动 subagent，只能使用本地或用户已授权的独立来源；没有可用独立来源时停在当前工作项并说明阻塞，主会话不得因此自批。

主流程代为执行必要的工作流操作；用户可见回复使用自然语言，除非用户要求调试信息，不展示底层命令或数据。
<!-- SUPERSPEC:AGENTS:END -->
