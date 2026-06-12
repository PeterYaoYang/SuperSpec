export type ZhHint = { label_zh: string; hint_zh: string };
export type WorkflowTermHint = { term: string; label_zh: string; hint_zh: string };

const COMMAND_ZH: Record<string, ZhHint> = {
  init: { label_zh: "初始化", hint_zh: "初始化 SuperSpec 工作流所需的目录和文件。" },
  status: { label_zh: "状态检查", hint_zh: "查看当前变更的检查状态和摘要。" },
  recompute: { label_zh: "重新计算状态", hint_zh: "重新计算检查状态指纹和阶段摘要。" },
  "check-init": { label_zh: "初始化前置检查", hint_zh: "检查项目是否具备运行 SuperSpec 的基础内容。" },
  "check-artifact": { label_zh: "工件前置检查", hint_zh: "检查某个 OpenSpec 工件是否允许开始编写。" },
  "check-enter": { label_zh: "进入阶段前检查", hint_zh: "检查是否可以进入指定流程阶段。" },
  "check-apply-ready": { label_zh: "进入实现前检查", hint_zh: "检查提案阶段是否已经处理完成，可以进入实现阶段。" },
  "check-task-reopen": { label_zh: "任务重开检查", hint_zh: "检查被审查打回的任务是否满足重开条件。" },
  "check-task-edit": { label_zh: "任务编辑前检查", hint_zh: "检查任务在开始实现前是否满足测试与范围前置条件。" },
  "check-task-complete": { label_zh: "任务完成检查", hint_zh: "检查任务在勾完成前是否满足 GREEN 或替代验证要求。" },
  "workflow-packet": { label_zh: "流程数据包", hint_zh: "只读生成当前流程 gate 的紧凑执行数据包。" },
  "review-packet": { label_zh: "审查数据包", hint_zh: "只读生成审查角色或主线程的最小任务包。" },
  "ledger-render": { label_zh: "问题清单渲染", hint_zh: "渲染审查轮次的确定性问题清单文本。" },
  "check-review-ready": { label_zh: "进入审查前检查", hint_zh: "检查实现阶段是否已经处理完成，可以进入审查阶段。" },
  "check-review-complete": { label_zh: "审查完成检查", hint_zh: "检查审查阶段证据是否齐备并允许通过。" },
  "check-verify-ready": { label_zh: "验证完成检查", hint_zh: "检查最终验证证据是否完整。" },
  "check-archive-ready": { label_zh: "归档前检查", hint_zh: "检查是否满足 archive 前的确认与保全要求。" },
  "check-archived": { label_zh: "归档结果检查", hint_zh: "检查 change 是否已经被正确归档。" },
};

const GATE_ZH: Record<string, ZhHint> = {
  status: { label_zh: "状态", hint_zh: "当前变更的总览状态，不对应单个阶段。" },
  init: { label_zh: "初始化", hint_zh: "项目或 change 级别的初始化检查。" },
  recompute: { label_zh: "重新计算状态", hint_zh: "重新计算 state 与检查指纹的辅助步骤。" },
  openspec_preflight: { label_zh: "OpenSpec 前置检查", hint_zh: "确认 OpenSpec CLI 已满足 SuperSpec 运行要求。" },
  project_init: { label_zh: "项目初始化", hint_zh: "为当前仓库安装或修复 SuperSpec 项目文件。" },
  project_update: { label_zh: "项目级更新", hint_zh: "更新当前仓库中的 SuperSpec 项目文件。" },
  project_uninstall: { label_zh: "项目级卸载", hint_zh: "卸载当前仓库中的 SuperSpec 项目文件。" },
  user_install: { label_zh: "用户级安装", hint_zh: "在用户级 Codex 目录安装 SuperSpec 文件。" },
  user_update: { label_zh: "用户级更新", hint_zh: "更新用户级 Codex 目录中的 SuperSpec 文件。" },
  user_uninstall: { label_zh: "用户级卸载", hint_zh: "卸载用户级 Codex 目录中的 SuperSpec 文件。" },
  guard_error: { label_zh: "命令执行异常", hint_zh: "当前检查或初始化命令在执行过程中返回了错误。" },
  preset_upgrade: { label_zh: "预设升级确认", hint_zh: "需要先确认是否接受更高强度的流程预设。" },
  branch_handling: { label_zh: "分支处理确认", hint_zh: "需要先确认当前分支与工作区的处理方式。" },
  apply_isolation: { label_zh: "实现隔离确认", hint_zh: "需要先确认实现阶段允许写入的隔离范围。" },
  scope_expansion: { label_zh: "范围扩张确认", hint_zh: "需要先确认本次变更是否允许扩大范围。" },
  verify_failure_handling: { label_zh: "失败验证处理确认", hint_zh: "需要先确认失败验证是继续修复还是接受偏差。" },
  explore_complete: { label_zh: "探索完成", hint_zh: "探索记录、审查问题说明和必要的用户确认都已完成。" },
  proposal_reviewed: { label_zh: "提案审查完成", hint_zh: "提案已经完成严格审查，并完成必要的问题说明或用户确认。" },
  design_complete: { label_zh: "设计完成", hint_zh: "设计与规格审查已经完成。" },
  invariants_reviewed: { label_zh: "业务不变量审查完成", hint_zh: "业务不变量文档已经完成审查和必要的问题说明。" },
  test_contract_drafted: { label_zh: "测试契约起草完成", hint_zh: "测试契约已经完成审查和必要的问题说明。" },
  tasks_complete: { label_zh: "任务映射完成", hint_zh: "任务映射、测试引用和上游约束已经处理完成。" },
  propose_complete: { label_zh: "提案阶段完成", hint_zh: "从探索到任务映射的提案链路已经全部通过。" },
  task_reopen: { label_zh: "任务重开", hint_zh: "审查打回后的任务重开流程。" },
  task_edit: { label_zh: "任务编辑", hint_zh: "实现前检查 RED 或现状锁定测试等前置条件。" },
  task_complete: { label_zh: "任务完成", hint_zh: "任务勾完成前的证据检查。" },
  review_ready: { label_zh: "进入审查前准备完成", hint_zh: "可以开始审查阶段。" },
  review_complete: { label_zh: "审查完成", hint_zh: "审查和最终验证证据都已经处理完成。" },
  verify_complete: { label_zh: "验证完成", hint_zh: "最终验证已完成。" },
  archive_ready: { label_zh: "归档准备完成", hint_zh: "满足 archive 之前的所有保全与确认要求。" },
  archived: { label_zh: "已归档", hint_zh: "change 已完成 archive。" },
};

const REASON_ZH: Record<string, ZhHint> = {
  missing_review_digest: { label_zh: "缺少审查问题记录", hint_zh: "当前轮次的审查问题还没有整理成给用户看的记录。" },
  needs_user_decision_pending: { label_zh: "等待用户确认", hint_zh: "当前问题需要用户确认，请先选择 A/B/C/D 中的一项。" },
  finding_unresolved: { label_zh: "历史问题未处理完", hint_zh: "旧问题还没有最终处理结果，不能靠新一轮无问题审查把它忽略掉。" },
  finding_undisclosed: { label_zh: "本轮问题未说明", hint_zh: "审查角色提出的问题还没有写进本轮审查问题记录并展示给用户。" },
  user_decision_unbound: { label_zh: "用户确认未绑定", hint_zh: "关键问题的最终处理结果没有正确关联到用户确认或有效授权。" },
  standing_authorization_unbound: { label_zh: "长期授权不适用", hint_zh: "当前问题不能被现有长期授权覆盖。" },
  review_round_stale: { label_zh: "审查轮次已过期", hint_zh: "审查轮次记录的工件版本已经不是当前版本，需要重新审查。" },
  review_digest_stale: { label_zh: "审查问题记录已过期", hint_zh: "审查问题记录对应的工件集合已过期，需要按当前版本重新整理。" },
  review_round_discontinuous: { label_zh: "审查轮次断档", hint_zh: "审查轮次编号必须连续，不能跳过中间轮次。" },
  digest_chain_broken: { label_zh: "审查问题记录链不完整", hint_zh: "后一轮审查问题记录没有正确引用前一轮记录。" },
  finding_identity_mismatch: { label_zh: "问题身份不一致", hint_zh: "主流程在审查问题记录里改写了审查方原始问题的分类或身份字段。" },
  finding_summary_not_verbatim: { label_zh: "问题原文未逐字保留", hint_zh: "展示给用户的问题说明没有逐字保留审查方的原始摘要。" },
  accepted_deviation_unacknowledged: { label_zh: "已接受偏差未被重审确认", hint_zh: "新一轮无问题审查没有明确确认已接受的偏差。" },
  ledger_injection_missing: { label_zh: "缺少问题清单", hint_zh: "增量重审输入中缺少工具生成的问题清单。" },
  round_budget_exhausted: { label_zh: "审查轮次已达上限", hint_zh: "同一流程阶段超过预算轮次仍未处理完成，需要升级给用户。" },
  missing_characterization: { label_zh: "缺少现状锁定测试", hint_zh: "行为保持重构在动代码前，必须先用 GREEN 测试锁住当前行为。" },
  missing_red_evidence: { label_zh: "缺少 RED 证据", hint_zh: "新增行为或修 bug 的任务在实现前需要先有失败测试证据。" },
  missing_green_evidence: { label_zh: "缺少 GREEN 证据", hint_zh: "任务完成前需要通过成功测试或等价验证。" },
  invalid_tdd_mode: { label_zh: "TDD 模式无效", hint_zh: "task 上声明的 tdd_mode 不在允许枚举里。" },
  invalid_no_tdd_reason: { label_zh: "免 TDD 理由无效", hint_zh: "task 上声明的 no_tdd_reason 不在允许枚举里。" },
  missing_discovery: { label_zh: "缺少探索记录", hint_zh: "探索阶段缺少 discovery.md，或者该文件内容为空。" },
  missing_proposal: { label_zh: "缺少提案工件", hint_zh: "提案工件还没有完成。" },
  missing_proposal_review: { label_zh: "缺少提案审查", hint_zh: "提案审查阶段还没有收集到严格审查证据。" },
  explore_complete_failed: { label_zh: "探索阶段未通过", hint_zh: "后续阶段依赖的探索完成检查还没有通过。" },
  proposal_reviewed_failed: { label_zh: "提案审查阶段未通过", hint_zh: "后续阶段依赖的提案审查完成还没有通过。" },
  validate_failed: { label_zh: "OpenSpec 校验失败", hint_zh: "openspec validate 还没有通过。" },
  review_not_ready: { label_zh: "尚未达到审查条件", hint_zh: "进入审查阶段之前的检查还没有全部通过。" },
  apply_isolation_unconfirmed: { label_zh: "实现隔离尚未确认", hint_zh: "实现阶段缺少用户对写入隔离范围的确认。" },
  scope_expansion_unconfirmed: { label_zh: "范围扩张尚未确认", hint_zh: "tasks 结构变化扩大了范围，但还没有新的用户确认。" },
  state_concurrent_update: { label_zh: "状态写入发生并发变更", hint_zh: "决策和写入之间输入发生变化，需要等变更稳定后重新运行。" },
  project_init_failed: { label_zh: "项目初始化失败", hint_zh: "项目级 SuperSpec 初始化没有成功完成。" },
  openspec_cli_too_old: { label_zh: "OpenSpec 版本过低", hint_zh: "当前 openspec CLI 低于 SuperSpec 要求的最低版本。" },
  openspec_cli_unavailable: { label_zh: "OpenSpec CLI 不可用", hint_zh: "PATH 中没有可执行的 openspec CLI。" },
  openspec_native_surface_missing: { label_zh: "OpenSpec 原生能力缺失", hint_zh: "当前 openspec CLI 不是受支持版本，或缺少 SuperSpec 依赖的子命令。" },
  openspec_auto_install_unavailable: { label_zh: "OpenSpec 无法自动安装", hint_zh: "当前环境没有可用包管理器完成 OpenSpec 自动安装或升级。" },
  openspec_auto_install_failed: { label_zh: "OpenSpec 自动安装失败", hint_zh: "OpenSpec 自动安装或升级命令没有成功完成。" },
  project_update_failed: { label_zh: "项目级更新失败", hint_zh: "项目级 SuperSpec 文件更新失败。" },
  project_uninstall_failed: { label_zh: "项目级卸载失败", hint_zh: "项目级 SuperSpec 文件卸载失败。" },
  user_install_failed: { label_zh: "用户级安装失败", hint_zh: "用户级 SuperSpec 安装失败。" },
  user_update_failed: { label_zh: "用户级更新失败", hint_zh: "用户级 SuperSpec 更新失败。" },
  user_uninstall_failed: { label_zh: "用户级卸载失败", hint_zh: "用户级 SuperSpec 卸载失败。" },
  guard_error: { label_zh: "检查执行失败", hint_zh: "guard 命令执行过程中发生了可报告错误。" },
  guard_internal_error: { label_zh: "检查器内部错误", hint_zh: "guard 内部抛出了异常，需要查看错误信息排查。" },
};

const WORKFLOW_TERMS_ZH: Record<string, WorkflowTermHint> = {
  "check-enter": { term: "check-enter", label_zh: "进入阶段前检查", hint_zh: "进入某个流程阶段前先运行的检查命令。" },
  acceptance: { term: "acceptance", label_zh: "验收标准", hint_zh: "这个 change 交付后必须满足的结果和边界。" },
  characterization: { term: "characterization", label_zh: "现状锁定测试", hint_zh: "先把当前真实行为测出来并锁住，重构后保持一致。" },
  main_review_digest: { term: "main_review_digest", label_zh: "审查问题记录", hint_zh: "主流程把本轮审查问题整理给用户看的记录。" },
  user_review_decision: { term: "user_review_decision", label_zh: "用户确认记录", hint_zh: "用户对 A/B/C/D 选项做出的正式确认记录。" },
};

const TRUST_WARNING_ZH: Record<string, string> = {
  "v1 evidence is audit-only/self-reported unless explicitly backed by OpenSpec facts": "v1 证据默认只作审计参考或自报信息；除非另有 OpenSpec 事实支撑，否则不能单独当作强证明。",
  "v1 role evidence cannot mechanically prove a native subagent ran; it only checks schema, freshness, output refs, and non-direct authorship markers": "v1 角色证据无法机械证明本地子代理一定实际运行；当前只校验 schema、时效、output ref 与非直接作者标记。",
  ".superspec runtime data is never touched by install/update/uninstall; only manifest-managed files are": "install / update / uninstall 不会改动 .superspec 运行态数据，只会处理 manifest 接管的文件。",
  "project init installs project surfaces only; change sidecars are created lazily by later superspec phases": "project init 只安装项目级内容；change sidecar 会在后续 superspec 阶段按需创建。",
};

const ACTION_ZH_EXACT: Record<string, string> = {
  "continue with superspec-explore/propose/apply guard checks": "继续执行探索、提案和实现阶段的前置检查。",
  "create/select a change during superspec-explore, then run change-scoped guard checks": "先在探索阶段创建或选择一个变更，然后运行该变更范围内的前置检查。",
  "review *.new files for user-modified surfaces, then rerun superspec guard check-init": "先检查因用户改动而生成的 *.new 文件，然后重新运行初始化前置检查；Windows PowerShell 中使用 superspec.cmd guard check-init。",
  "review *.new files for user-modified user-level surfaces": "先检查用户级内容对应的 *.new 文件。",
  "user-level SuperSpec Codex surfaces installed; use superspec init --scope project inside a repo when project-local surfaces are needed": "用户级 SuperSpec 配套内容已安装；如果仓库里还需要项目级内容，请在仓库内运行 superspec init --scope project；Windows PowerShell 中使用 superspec.cmd init --scope project。",
  "finish remaining unchecked tasks and mark them complete only after check-task-complete passes": "先完成剩余未勾选任务，并且仅在任务完成检查通过后再标记完成。",
  "record final_test pass evidence and reference it from verification_review": "记录最终测试通过证据，并在验证审查证据中引用它。",
};

const ACTION_STATUS_ZH: Record<string, string> = {
  ok: "正常",
  created: "已创建",
  updated: "已更新",
  skipped: "已跳过",
  removed: "已移除",
  would_remove: "待移除",
  failed: "失败",
};

const ROLE_ZH: Record<string, string> = {
  architect: "架构审查",
  critic: "严格审查",
  "test-engineer": "测试审查",
  "code-reviewer": "代码审查",
  verifier: "验证审查",
};

const EVIDENCE_KIND_ZH: Record<string, string> = {
  source_guidance: "审查指导证据",
  verification_review: "验证审查证据",
  final_test: "最终测试通过证据",
  main_adjudication: "主流程最终判断记录",
  main_review_digest: "审查问题记录",
  user_review_decision: "用户确认记录",
  human_confirmation: "人工确认证据",
  test_run: "测试运行证据",
  alternative_verification: "替代验证证据",
  manual_verification: "人工验证证据",
  task_reopen: "任务重开证据",
  task_reopen_resolved: "任务重开完成证据",
};

const FIELD_ZH: Record<string, string> = {
  reviewed_files: "审查文件列表",
  rollback_targets: "回滚目标",
  source_evidence_refs: "来源证据引用",
  verification_evidence_refs: "验证证据引用",
  blocking_source_evidence_refs: "阻塞来源证据引用",
  required_claim_ids: "必需结论项",
  required_load_refs: "必需加载引用",
  claim_adjudications: "结论项判断",
  finding_adjudications: "问题处理判断",
  request_changes_route: "打回路由",
  reopen_task_ids: "需重开任务列表",
  output_ref: "输出引用",
  prompt_ref: "提示词引用",
  target_refs: "目标引用",
  openspec_validate_ref: "OpenSpec 校验引用",
  scope_drift_ref: "范围漂移引用",
  task_matrix_ref: "任务矩阵引用",
  invariant_matrix_ref: "不变量矩阵引用",
  test_evidence_refs: "测试证据引用",
  base_ref: "基线提交引用",
  head_ref: "当前提交引用",
  raw_artifact_refs: "原始工件引用",
  raw_log_refs: "原始日志引用",
  result_summary: "结果摘要",
};

const NOUN_ZH: Record<string, string> = {
  source_guidance: "审查指导证据",
  verification_review: "验证审查证据",
  final_test: "最终测试通过证据",
  main_adjudication: "主流程最终判断记录",
  main_review_digest: "审查问题记录",
  review_digest: "审查问题记录",
  review_round: "审查轮次",
  final_verification_review: "最终验证审查",
  business_invariants: "业务不变量",
  coverage_matrix: "覆盖矩阵",
  test_contract: "测试契约",
  task_reopen: "任务重开",
  reopen_successor: "重开后继证据",
  archive_manifest: "归档清单",
  archive_preservation_plan: "归档保全计划",
  target_refs: "目标引用",
  source_evidence_refs: "来源证据引用",
  verification_evidence_refs: "验证证据引用",
  blocking_source_evidence_refs: "阻塞来源证据引用",
  raw_artifact_refs: "原始工件引用",
  raw_log_refs: "原始日志引用",
  task_test_refs: "任务测试引用",
  task_invariant_refs: "任务不变量引用",
  verification_evidence: "验证证据",
  review_evidence: "审查证据",
  task_evidence: "任务证据",
  native_subagent_evidence: "本地子代理证据",
  claim_adjudication: "结论项判断",
  claim_adjudications: "结论项判断",
  finding_adjudication: "问题处理判断",
  test_contract_review: "测试契约审查",
  invariant_review: "不变量审查",
  missing_roles: "缺失角色",
  rollback_targets: "回滚目标",
  reviewed_files: "审查文件列表",
  required_loads: "必需加载项",
  claims: "结论项",
  blocking_findings: "阻塞问题",
  human_confirmation: "人工确认",
  scope_drift: "范围漂移",
  openspec_cli: "OpenSpec CLI",
  openspec_native_surface: "OpenSpec 原生配套内容",
  openspec_artifacts: "OpenSpec 工件",
  superspec_skill: "SuperSpec 技能",
  superspec_agent: "SuperSpec 角色代理",
  superspec_prompt: "SuperSpec 角色提示词",
  test_run: "测试运行",
  alternative_verification: "替代验证",
  manual_verification: "人工验证",
  output_ref: "输出引用",
  prompt_ref: "提示词引用",
  base_ref: "基线提交引用",
  head_ref: "当前提交引用",
  task_id: "任务标识",
  reopen_id: "重开标识",
  change_update: "变更回改",
};

const TOKEN_ZH: Record<string, string> = {
  missing: "缺少",
  invalid: "无效",
  unknown: "未知",
  unexpected: "非预期",
  ambiguous: "不唯一",
  unresolved: "未处理完",
  stale: "已过期",
  failed: "失败",
  incomplete: "不完整",
  blocked: "未通过",
  unavailable: "不可用",
  mismatch: "不匹配",
  duplicate: "重复",
  unreferenced: "未被引用",
  unloaded: "未加载",
  required: "必需",
  preserved: "已保全",
  proposal: "提案",
  design: "设计",
  task: "任务",
  tasks: "任务",
  review: "审查",
  verification: "验证",
  source: "来源",
  guidance: "指导",
  archive: "归档",
  manifest: "清单",
  state: "状态",
  fingerprint: "指纹",
  dirty: "脏工作区",
  worktree: "工作区",
  reopen: "重开",
  successor: "后继",
  final: "最终",
  tests: "测试",
  artifacts: "工件",
  artifact: "工件",
  invariant: "不变量",
  invariants: "不变量",
  contract: "契约",
  coverage: "覆盖",
  matrix: "矩阵",
  refs: "引用",
  ref: "引用",
  role: "角色",
  roles: "角色",
  lane: "审查线",
  native: "本地",
  subagent: "子代理",
  evidence: "证据",
  adjudication: "最终判断",
  claim: "结论项",
  claims: "结论项",
  finding: "问题",
  findings: "问题",
  complete: "完成",
  propose: "提案",
  apply: "实现",
  gate: "阶段",
  rereview: "重新审查",
  rollback: "回滚",
  target: "目标",
  human: "人工",
  confirmation: "确认",
  scope: "范围",
  drift: "漂移",
  green: "GREEN",
  red: "RED",
  characterization: "现状锁定测试",
  validate: "校验",
  cli: "命令行",
  schema: "结构",
  surface: "配套内容",
  workflow: "工作流",
};

function fallbackZh(kind: string): ZhHint {
  return {
    label_zh: kind,
    hint_zh: "这是内部工作流标识；界面层应优先展示对应的中文说明，而不是直接向普通用户暴露原始标识。",
  };
}

export function command_zh(command: string): ZhHint {
  return COMMAND_ZH[command] ?? { label_zh: noun_phrase_zh(command) ?? "内部命令", hint_zh: "这是内部命令标识；界面层应优先展示对应的中文说明。" };
}

export function gate_zh(gate: string): ZhHint {
  return GATE_ZH[gate] ?? { label_zh: noun_phrase_zh(gate) ?? "内部流程阶段", hint_zh: "这是内部流程阶段标识；界面层应优先展示对应的中文说明。" };
}

export function reason_zh(code: string): ZhHint {
  return REASON_ZH[code] ?? auto_reason_zh(code);
}

export function decision_zh(decision: string): string {
  if (decision === "allow") return "通过";
  if (decision === "block") return "未通过";
  if (decision === "status") return "状态";
  return "内部结果";
}

function hasHan(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function refs_suffix_zh(refs: string[]): string {
  if (refs.length === 0) return "";
  return ` 关联：${refs.join("，")}`;
}

function sortedKeysDesc(map: Record<string, string>): string[] {
  return Object.keys(map).sort((a, b) => b.length - a.length);
}

function role_label_zh(role: string): string {
  return ROLE_ZH[role] ?? role;
}

function noun_phrase_zh(raw: string): string | null {
  if (!raw) return null;
  if (NOUN_ZH[raw]) return NOUN_ZH[raw];
  if (FIELD_ZH[raw]) return FIELD_ZH[raw];
  if (EVIDENCE_KIND_ZH[raw]) return EVIDENCE_KIND_ZH[raw];
  if (ROLE_ZH[raw]) return ROLE_ZH[raw];
  for (const key of sortedKeysDesc(NOUN_ZH)) {
    if (raw.includes(key)) return raw.replaceAll(key, NOUN_ZH[key]);
  }
  const parts = raw.split(/[_-]+/u).filter(Boolean);
  if (parts.length === 0) return null;
  const mapped = parts.map((part) => TOKEN_ZH[part] ?? FIELD_ZH[part] ?? null);
  if (mapped.some((item) => item === null)) return null;
  return mapped.join("");
}

function auto_reason_zh(code: string): ZhHint {
  const render = (subjectRaw: string, labelPrefix: string, hintSuffix: string): ZhHint => {
    const subject = noun_phrase_zh(subjectRaw) ?? subjectRaw;
    return { label_zh: `${labelPrefix}${subject}`, hint_zh: `当前${subject}${hintSuffix}` };
  };
  const patterns: Array<[RegExp, (subject: string) => ZhHint]> = [
    [/^missing_(.+)$/u, (subject) => render(subject, "缺少", "缺失，需要补齐后再继续。")],
    [/^invalid_(.+)$/u, (subject) => render(subject, "", "不符合预期格式或约束。")],
    [/^unknown_(.+)$/u, (subject) => render(subject, "未知", "无法被当前流程识别。")],
    [/^unexpected_(.+)$/u, (subject) => render(subject, "出现非预期的", "超出了当前流程允许范围。")],
    [/^ambiguous_(.+)$/u, (subject) => render(subject, "", "不唯一，需要先消歧。")],
    [/^unresolved_(.+)$/u, (subject) => render(subject, "", "尚未处理完成，需要先处理。")],
    [/^stale_(.+)$/u, (subject) => render(subject, "", "已经过期，需要基于最新内容重做。")],
    [/^(.+)_failed$/u, (subject) => render(subject, "", "未通过当前检查。")],
    [/^(.+)_invalid$/u, (subject) => render(subject, "", "不符合预期格式或约束。")],
    [/^(.+)_incomplete$/u, (subject) => render(subject, "", "还不完整，需要补齐。")],
    [/^(.+)_missing$/u, (subject) => render(subject, "缺少", "缺失，需要补齐后再继续。")],
    [/^(.+)_unavailable$/u, (subject) => render(subject, "", "当前不可用。")],
    [/^(.+)_unreferenced$/u, (subject) => render(subject, "", "尚未被正确引用。")],
    [/^(.+)_unloaded$/u, (subject) => render(subject, "", "尚未被正确加载。")],
    [/^(.+)_mismatch$/u, (subject) => render(subject, "", "与预期不一致。")],
    [/^(.+)_duplicate$/u, (subject) => render(subject, "", "出现重复。")],
    [/^(.+)_blocked$/u, (subject) => render(subject, "", "当前未通过。")],
    [/^(.+)_required$/u, (subject) => render(subject, "需要", "是当前流程的必需项。")],
    [/^(.+)_not_honored$/u, (subject) => render(subject, "", "尚未被满足。")],
    [/^(.+)_not_ready$/u, (subject) => render(subject, "", "尚未就绪。")],
    [/^(.+)_not_complete$/u, (subject) => render(subject, "", "尚未完成。")],
    [/^not_(.+)$/u, (subject) => render(subject, "不是", "与当前操作目标不匹配。")],
    [/^non_default_(.+)$/u, (subject) => render(subject, "未使用默认", "与当前流程要求不一致。")],
  ];
  for (const [pattern, make] of patterns) {
    const match = code.match(pattern);
    if (match) return make(match[1]);
  }
  const label = noun_phrase_zh(code);
  if (label) return { label_zh: label, hint_zh: "当前流程触发了这条未通过原因，请结合上下文继续排查。" };
  return fallbackZh("未通过原因");
}

function translate_message_tokens_zh(raw: string): string {
  let out = raw;
  const phraseReplacements: Array<[RegExp, string | ((...args: string[]) => string)]> = [
    [/main_review_digest/giu, "审查问题记录"],
    [/user_review_decision/giu, "用户确认记录"],
    [/review_standing_authorization/giu, "长期授权记录"],
    [/review_round_id/giu, "审查轮次编号"],
    [/finding_uid/giu, "问题唯一标识"],
    [/decision_scope_key/giu, "确认范围标识"],
    [/confirmed_refs/giu, "已确认内容引用"],
    [/source_review_evidence_refs/giu, "来源审查证据引用"],
    [/previous_digest_refs/giu, "上一轮审查问题记录引用"],
    [/finding_dispositions/giu, "问题处理结果"],
    [/needs_user_decision/giu, "等待用户确认"],
    [/ledger_injection_missing/giu, "缺少问题清单"],
    [/round_budget_exhausted/giu, "审查轮次已达上限"],
    [/source_guidance evidence/giu, "审查指导证据"],
    [/verification_review evidence/giu, "验证审查证据"],
    [/final_test pass evidence/giu, "最终测试通过证据"],
    [/human confirmation evidence/giu, "人工确认证据"],
    [/scope drift report/giu, "范围漂移报告"],
    [/passing review evidence/giu, "通过的审查证据"],
    [/native_subagent ([A-Za-z-]+)/giu, (role) => `本地子代理${role_label_zh(role)}`],
    [/missing roles/giu, "缺失角色"],
    [/review rounds/giu, "审查轮次"],
    [/live\/pass/giu, "仍然有效且通过的"],
    [/request_changes/giu, "打回"],
    [/change update/giu, "变更回改"],
  ];
  for (const [pattern, replacement] of phraseReplacements) {
    out = out.replace(pattern, (...args) => typeof replacement === "string" ? replacement : replacement(...args.slice(1, -2)));
  }
  const tokenMap: Record<string, string> = {
    requires: "需要",
    require: "需要",
    missing: "缺少",
    invalid: "无效",
    unknown: "未知",
    exactly: "恰好",
    one: "一条",
    live: "有效",
    authored: "生成",
    before: "之前",
    after: "之后",
    must: "必须",
    include: "包含",
    includes: "包含",
    reference: "引用",
    references: "引用",
    referencing: "引用",
    cover: "覆盖",
    covers: "覆盖",
    load: "加载",
    readable: "可读取",
    empty: "为空",
    done: "完成",
    pass: "通过",
    failed: "失败",
    by: "由",
    and: "和",
    or: "或",
    not: "未",
  };
  out = out.replace(/\b[A-Za-z][A-Za-z0-9_.-]*\b/gu, (token) => {
    const lower = token.toLowerCase();
    if (tokenMap[lower]) return tokenMap[lower];
    if (ROLE_ZH[token]) return ROLE_ZH[token];
    if (FIELD_ZH[token]) return FIELD_ZH[token];
    if (EVIDENCE_KIND_ZH[token]) return EVIDENCE_KIND_ZH[token];
    if (COMMAND_ZH[token]) return COMMAND_ZH[token].label_zh;
    if (GATE_ZH[token]) return GATE_ZH[token].label_zh;
    const noun = noun_phrase_zh(token);
    return noun ?? token;
  });
  out = out
    .replace(/\s+/gu, " ")
    .replace(/\s+([:,\)])+/gu, "$1")
    .replace(/\(\s+/gu, "(")
    .trim();
  return out;
}

function display_term_zh(value: string): string {
  const trimmed = value.trim();
  const firstToken = trimmed.split(/\s+/u)[0] ?? "";
  if (ROLE_ZH[trimmed]) return ROLE_ZH[trimmed];
  if (EVIDENCE_KIND_ZH[trimmed]) return EVIDENCE_KIND_ZH[trimmed];
  if (FIELD_ZH[trimmed]) return FIELD_ZH[trimmed];
  if (COMMAND_ZH[firstToken]) return COMMAND_ZH[firstToken].label_zh;
  if (GATE_ZH[trimmed]) return GATE_ZH[trimmed].label_zh;
  if (REASON_ZH[trimmed]) return REASON_ZH[trimmed].label_zh;
  if (/^[a-z0-9_]+$/u.test(trimmed)) return reason_zh(trimmed).label_zh;
  return noun_phrase_zh(trimmed) ?? trimmed;
}

function render_roles_zh(raw: string): string {
  return raw.split(/\s*,\s*/u).filter(Boolean).map((item) => role_label_zh(item)).join("、");
}

export function translate_action_zh(action: string): string {
  const exact = ACTION_ZH_EXACT[action];
  if (exact) return exact;
  const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
    [/^managed SuperSpec surfaces removed; run superspec init --scope (.+) to reinstall$/u, (scope) => `SuperSpec 管理的文件已移除；如需重新安装，请运行 superspec init --scope ${scope}；Windows PowerShell 中使用 superspec.cmd init --scope ${scope}。`],
    [/^install or upgrade @fission-ai\/openspec >= ([0-9.]+), then rerun `superspec init --scope (.+)`$/u, (version, scope) => `先安装或升级 @fission-ai/openspec 到 ${version} 或更高版本，然后重新运行 superspec init --scope ${scope}；Windows PowerShell 中使用 superspec.cmd init --scope ${scope}。`],
    [/^fix ([A-Za-z0-9_.-]+) reasons, then rerun(?: (.+))?$/u, (problem, cmd) => {
      const label = display_term_zh(problem);
      return cmd ? `先处理${label}对应问题，然后重新运行相关命令。` : `先处理${label}对应问题，然后重新运行相关检查。`;
    }],
    [/^fix openspec validate failures for (.+)$/u, (change) => `修复 ${change} 的 openspec validate 失败项。`],
    [/^collect ([A-Za-z0-9_.-]+) source_guidance from missing roles: (.+)$/u, (gate, roles) => `补齐${display_term_zh(gate)}所缺的审查指导证据（角色：${render_roles_zh(roles)}）。`],
    [/^collect verification_review evidence from missing roles: (.+)$/u, (roles) => `补齐验证审查证据（角色：${render_roles_zh(roles)}）。`],
    [/^repair source_guidance evidence fields so every review lane has base\/head refs, reviewed_files, and rollback_targets$/u, () => "修复审查指导证据字段，确保每条审查线都包含基线/当前提交引用、审查文件列表和回滚目标。"],
    [/^write exactly one live main_adjudication referencing every live source_guidance and final verification evidence$/u, () => "补写且仅保留一条有效的主流程最终判断记录，并引用全部有效的审查指导证据和最终验证证据。"],
    [/^repair main_adjudication so it references all source_guidance\/final verification evidence and explicitly covers required loads, claims, and blocking findings$/u, () => "修复主流程最终判断记录，确保它引用全部审查指导证据与最终验证证据，并明确覆盖必需加载项、结论项和阻塞问题。"],
    [/^repair verification_review references so openspec_validate_ref, matrices, scope drift report, and test evidence refs are readable$/u, () => "修复验证审查证据引用，确保 OpenSpec 校验引用、各类矩阵、范围漂移报告和测试证据引用都可读取。"],
    [/^resolve scope drift before review close: narrow the change or record accepted\/none with evidence$/u, () => "先处理范围漂移，再结束审查：要么收窄本次变更范围，要么补充证据后明确记录为已接受或无漂移。"],
    [/^record ([A-Za-z0-9_.-]+) pass evidence and reference it from ([A-Za-z0-9_.-]+)$/u, (kind, target) => `记录${display_term_zh(kind)}，并在${display_term_zh(target)}中引用它。`],
    [/^AskUserQuestion for apply isolation\/execution mode and record gate="apply_isolation" human_confirmation$/u, () => "请先让用户确认实现隔离范围或执行方式，并记录对应的人工确认证据。"],
    [/^run the proposal critic review \(round-tagged, findings\[\]\) and record a main_review_digest disclosing every finding$/u, () => "先完成提案的严格审查，并记录一条向用户说明所有问题的审查问题记录。"],
    [/^pass (.+) before entering (.+)$/u, (name, stage) => `进入${display_term_zh(stage)}之前先通过${display_term_zh(name)}。`],
    [/^pass (.+) first$/u, (name) => `先通过${display_term_zh(name)}。`],
    [/^pass (.+)$/u, (name) => `先通过${display_term_zh(name)}。`],
    [/^rerun (.+)$/u, (cmd) => `重新运行${display_term_zh(cmd)}。`],
    [/^run (.+)$/u, (cmd) => `运行${display_term_zh(cmd)}。`],
    [/^fix (.+), then rerun (.+)$/u, (_problem, cmd) => `先修复相关问题，然后重新运行 ${cmd}。`],
    [/^fix (.+)$/u, (problem) => hasHan(problem) ? `修复 ${problem}。` : "先修复当前未通过项。"],
    [/^inspect (.+), then rerun (.+)$/u, (target, cmd) => `先检查 ${target}，然后重新运行 ${cmd}。`],
    [/^keep (.+) checked, fix (.+), then rerun (.+)$/u, (target, _problem, cmd) => `保持 ${target} 处于已勾选状态，修复当前问题，然后重新运行 ${cmd}。`],
    [/^continue with (.+)$/u, (what) => `继续执行 ${what}。`],
    [/^record (.+) human_confirmation evidence, then rerun (.+)$/u, (kind, cmd) => `记录${display_term_zh(kind)}对应的人工确认证据，然后重新运行${display_term_zh(cmd)}。`],
    [/^stop review completion and hand off to apply task_reopen for (.+)$/u, (taskIds) => `停止当前审查完成流程，转回实现阶段处理任务重开：${taskIds}。`],
    [/^stop review completion and hand off to apply task_reopen$/u, () => "停止当前审查完成流程，转回实现阶段处理任务重开。"],
    [/^stop review completion and hand off to propose\/change update$/u, () => "停止当前审查完成流程，转回提案阶段处理变更回改。"],
    [/^do not add allow-path verification_review\/final_test evidence to this request_changes round$/u, () => "本轮打回处理中不要补写仅用于通过审查的验证审查证据或最终测试通过证据。"],
    [/^repair request_changes_route and hand off the review round before retrying review_complete$/u, () => "先修复打回路由并完成当前审查轮次交接，再重新尝试审查完成检查。"],
    [/^AskUserQuestion for the failed-verification disposition \(fix or accept deviation\) and record gate="verify_failure_handling" human_confirmation referencing the failed evidence ids$/u, () => "请用户确认失败验证的处理方式：继续修复，或接受这次偏差；并补记引用失败证据的人工确认。"],
  ];
  for (const [pattern, render] of patterns) {
    const match = action.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return "先处理当前未通过项，再重新运行相关检查。";
}

export function reason_message_zh(code: string, rawMessage: string, refs: string[] = []): string {
  const zh = reason_zh(code);
  if (hasHan(rawMessage)) return `${translate_message_tokens_zh(rawMessage)}${refs_suffix_zh(refs)}`;
  if (Object.prototype.hasOwnProperty.call(REASON_ZH, code) && zh.hint_zh) return `${zh.label_zh}：${zh.hint_zh}${refs_suffix_zh(refs)}`;
  const translated = translate_message_tokens_zh(rawMessage);
  if (translated && translated !== rawMessage && !/[A-Za-z]{4,}/u.test(translated)) return `${zh.label_zh}：${translated}${refs_suffix_zh(refs)}`;
  if (zh.hint_zh) return `${zh.label_zh}：${zh.hint_zh}${refs_suffix_zh(refs)}`;
  return `${zh.label_zh}${refs_suffix_zh(refs)}`;
}

export function trust_warning_zh(warning: string): string {
  return TRUST_WARNING_ZH[warning] ?? "注意：这条提示属于信任边界说明，请结合当前证据一起判断。";
}

export function action_status_zh(status: string): string {
  return ACTION_STATUS_ZH[status] ?? "状态未知";
}

export function action_label_zh(action: string): string {
  const exact: Record<string, string> = {
    openspec_cli_surface: "检查 OpenSpec CLI 能力",
    superspec_repo_local_roles: "检查 SuperSpec 本地角色与提示词",
  };
  if (exact[action]) return exact[action];
  const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
    [/^install (.+)$/u, (target) => `安装 ${target}`],
    [/^update (.+)$/u, (target) => `更新 ${target}`],
    [/^uninstall rmdir (.+)$/u, (target) => `删除空目录 ${target}`],
    [/^uninstall (.+)$/u, (target) => `卸载 ${target}`],
  ];
  for (const [pattern, render] of patterns) {
    const match = action.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return "执行由 SuperSpec 管理的文件操作";
}

export function action_detail_zh(detail: string): string {
  const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
    [/^existing file backed up to (.+)$/u, (target) => `已有文件已备份到 ${target}。`],
    [/^pre-existing file with different content kept; rerun with --force to overwrite \(backs up \*\.bak\)$/u, () => "已有不同内容文件已保留；如需覆盖，请使用 --force，覆盖前会备份为 *.bak。"],
    [/^preexisting file is never touched$/u, () => "既有文件不会被改动。"],
    [/^user-modified file kept; new version written to (.+)$/u, (target) => `已保留用户修改版本；新版本写入 ${target}。`],
    [/^managed file no longer shipped$/u, () => "该文件在当前版本中已不再分发。"],
    [/^no longer shipped but user-modified; kept$/u, () => "该文件在当前版本中已不再分发，但因存在用户修改而被保留。"],
    [/^preexisting\/unmanaged file is never touched$/u, () => "既有文件或非 SuperSpec 管理的文件不会被改动。"],
    [/^already absent$/u, () => "该文件原本就不存在。"],
    [/^user-modified since install; kept$/u, () => "该文件在安装后已被用户修改，因此会被保留。"],
  ];
  for (const [pattern, render] of patterns) {
    const match = detail.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return hasHan(detail) ? detail : system_failure_zh(detail, "该操作包含补充说明，请结合当前阶段与相关证据一起查看。");
}

export function system_failure_zh(raw: string, fallback = "命令执行失败，请查看终端日志后重试。"): string {
  const text = raw.trim();
  if (!text) return fallback;
  if (hasHan(text)) return text;
  if (/permission denied/i.test(text)) return "权限不足，请检查当前用户是否有权限执行该命令。";
  if (/command not found|is not recognized/i.test(text)) return "系统未找到需要的命令，请确认相关工具已安装并已加入 PATH。";
  if (/no such file or directory/i.test(text)) return "找不到需要的文件或目录，请确认路径和安装环境是否正确。";
  if (/timed out|timeout/i.test(text)) return "命令执行超时，请稍后重试。";
  if (/network|econn|enotfound|fetch failed|connection refused|connection reset/i.test(text)) {
    return "网络访问失败，请检查网络连接后重试。";
  }
  const exit = text.match(/\bexit status\s+([0-9]+)/i);
  if (exit) return `命令执行失败（退出状态码 ${exit[1]}）。`;
  return fallback;
}

export function workflow_terms_zh_for(command: string | undefined, _gate: string, reasonCodes: string[]): WorkflowTermHint[] {
  const keys = new Set<string>();
  if (command === "check-enter") keys.add("check-enter");
  if (reasonCodes.some((code) => code === "needs_user_decision_pending" || code === "missing_review_digest" || code === "user_decision_unbound")) {
    keys.add("main_review_digest");
    keys.add("user_review_decision");
    keys.add("acceptance");
  }
  if (reasonCodes.includes("missing_characterization")) keys.add("characterization");
  return [...keys].map((key) => WORKFLOW_TERMS_ZH[key]).filter(Boolean);
}
