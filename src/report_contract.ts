/**
 * 报告契约单源：字段形状与取值、覆盖类提示消息、骨架渲染。
 *
 * 范围止于「形状」：字段名/类型/枚举/必填与否 + 跨字段条件 + 可直接填写的骨架。
 * 面向模型的说明文字仍由 packet 的 output_instructions 承载，判据仍由 record.ts 的
 * 校验函数执行（交叉规则与跨文件解析不声明化）。这样契约表不是第二份散文，
 * 也不与校验器争谁说了算。
 *
 * packet 的 report_skeleton、`superspec jobs contract` 与提交校验共用这里的定义。
 */
import type { Job, JobRole } from "./types.ts";

export const REVIEW_REPORT_REQUIRED_FIELDS = ["role", "verdict", "findings"] as const;
export const REVIEW_REPORT_OPTIONAL_FIELDS = ["summary", "evidence_refs", "risks", "open_questions"] as const;

/** reviewer.kind 允许取值：契约、packet 与提交校验共用。 */
export const REVIEWER_KINDS = ["subagent", "codex-subagent", "human", "external-agent"] as const;

/** 需要 reviewer 来源字段的角色。 */
const REVIEWER_ROLE: Partial<Record<JobRole, true>> = {
  critic: true,
  architect: true,
  "test-engineer": true,
  "code-reviewer": true,
};

/** 需要 review_scope 覆盖回执的角色。 */
const REVIEW_SCOPE_ROLE: Partial<Record<JobRole, true>> = {
  ...REVIEWER_ROLE,
  verifier: true,
};

/** 审查/验证类角色：报告需要 review_scope 覆盖回执。 */
export function isReviewRole(role: JobRole): boolean {
  return REVIEW_SCOPE_ROLE[role] === true;
}

/** 需要 reviewer.kind/id 的角色。 */
export function requiresReviewer(role: JobRole): boolean {
  return REVIEWER_ROLE[role] === true;
}

/** 需要 review_scope 覆盖回执的工作项。 */
export function requiresReviewScope(job: Job): boolean {
  return job.boundFiles.length > 0 && isReviewRole(job.role);
}

/** 提交校验与契约共用的覆盖类提示消息：改这里即同时影响两侧。 */
export const COVERAGE_MESSAGES = {
  codeReviewScopeMissing: "代码审查报告缺少覆盖范围字段 review_scope",
  reviewScopeMissing: "审查报告缺少覆盖范围字段 review_scope",
  checkedPathsNotStringArray: "代码审查覆盖范围里的 checked_paths 必须是字符串数组",
  reviewCheckedPathsNotStringArray: "审查报告覆盖范围里的 checked_paths 必须是字符串数组",
  checkedDocsNotStringArray: "代码审查覆盖范围里的 checked_docs 必须是字符串数组",
  uncheckedNotArray: "代码审查覆盖范围里的 unchecked 必须是数组",
  uncheckedItemNotObject: "代码审查覆盖范围里的未检查项必须是包含 path/reason 的对象",
  passWithUncheckedBoundFile: "代码审查结论为 pass 时不能包含未检查的绑定文件",
} as const;

export interface ReportFieldContract {
  type: "string" | "array" | "object";
  required?: boolean;
  values?: readonly string[];
  pattern?: string;
  item?: string;
}

export interface ReportSchemaContract {
  role: JobRole;
  required_fields: string[];
  optional_fields: string[];
  /** 顶层字段与 review_scope / findings 子字段的形状，键用点路径表示。 */
  fields: Record<string, ReportFieldContract>;
  /** 跨字段条件；校验器拒绝时的措辞与此保持一致。 */
  conditions: string[];
}

const FINDING_TYPES = ["implementation", "spec", "mixed"] as const;
const CLAIM_KINDS = ["missing_approved", "breaks_existing", "unjustified_addition"] as const;
const SUGGESTED_ACTIONS = ["apply", "propose"] as const;

/**
 * 工作项报告契约：只描述形状与取值。模型需要的解释性文字见 packet 的
 * `output_instructions` 与 `字段说明`；判据由 record.ts 执行。
 */
export function reportSchemaForJob(job: Job): ReportSchemaContract {
  const isCodeReviewer = job.role === "code-reviewer";
  const hasScope = requiresReviewScope(job);
  const fields: Record<string, ReportFieldContract> = {
    role: { type: "string", required: true, values: [job.role] },
    verdict: { type: "string", required: true, values: ["pass", "fail"] },
    findings: { type: "array", required: true },
    summary: { type: "string" },
    evidence_refs: { type: "array" },
    risks: { type: "array" },
    open_questions: { type: "array" },
  };
  const conditions: string[] = ["verdict 只能是 pass 或 fail。"];

  if (requiresReviewer(job.role)) {
    fields.reviewer = { type: "object", required: true };
    fields["reviewer.kind"] = { type: "string", required: true, values: REVIEWER_KINDS };
    fields["reviewer.id"] = { type: "string", required: true };
  }

  if (isCodeReviewer) {
    fields.review_scope = { type: "object", required: true };
    fields["review_scope.job_id"] = { type: "string", required: true, values: [job.job_id] };
    fields["review_scope.packet_digest"] = { type: "string", required: true, values: [job.packet_digest] };
    fields["review_scope.checked_paths"] = { type: "array", required: true, item: "path" };
    fields["review_scope.checked_docs"] = { type: "array", required: true, item: "path" };
    fields["review_scope.unchecked"] = { type: "array", required: true, item: "{path, reason}" };
    fields["findings[blocking=true].id"] = { type: "string", required: true, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
    fields["findings[blocking=true].type"] = { type: "string", required: true, values: FINDING_TYPES };
    fields["findings[blocking=true].claim_kind"] = { type: "string", required: true, values: CLAIM_KINDS };
    fields["findings[blocking=true].suggested_action"] = { type: "string", required: true, values: SUGGESTED_ACTIONS };
    fields["findings[blocking=true].source_refs"] = { type: "array", required: true, item: "path:line" };
    fields["findings[blocking=true].approved_refs"] = { type: "array", item: "已批准锚点" };
    for (const field of ["description", "evidence", "impact"] as const) {
      fields[`findings[blocking=true].${field}`] = { type: "string", required: true };
    }
    conditions.push(
      "verdict=pass 时不得存在 blocking:true 的问题。",
      "verdict=pass 时 unchecked 中不得包含绑定文件；范围外观察写 unchecked 或 risks 都不会导致拒收。",
      "checked_paths 与 unchecked[].path 合起来必须覆盖全部绑定文件。",
      "verdict=fail 时必须给出至少一个字段完整的 blocking 问题，字段缺失会被判为不可处理报告。",
      "claim_kind=missing_approved 且 suggested_action=apply 时，approved_refs 必须含可解析的 TEST 或 spec Requirement；缺口属于计划或验收本身时，改用 type=mixed 且 suggested_action=propose。",
      "提交时引擎会比对冻结范围与当前代码状态：绑定文件已变化会被判为过期报告，需等 next 重建工作项，不要补写指纹。",
    );
  } else if (hasScope) {
    fields.review_scope = { type: "object", required: true };
    fields["review_scope.checked_paths"] = { type: "array", required: true, item: "path" };
    conditions.push("checked_paths 必须覆盖全部绑定文件。");
  }

  if (job.role !== "code-reviewer" && job.role !== "verifier") {
    conditions.push("verdict=fail 时 findings 至少包含一个问题。");
  }

  return {
    role: job.role,
    required_fields: isCodeReviewer
      ? [...REVIEW_REPORT_REQUIRED_FIELDS, "reviewer", "review_scope"]
      : [
          ...REVIEW_REPORT_REQUIRED_FIELDS,
          ...(requiresReviewer(job.role) ? ["reviewer"] : []),
          ...(hasScope ? ["review_scope"] : []),
        ],
    optional_fields: [...REVIEW_REPORT_OPTIONAL_FIELDS],
    fields,
    conditions,
  };
}

/**
 * 可直接填写的报告骨架。
 *
 * 只预填工作项常量（job_id / packet_digest）与空数组：code-reviewer 的 checked_paths
 * 必须由审查者按实际浏览填写，预填会架空覆盖回执的意义。
 * 普通 reviewer / verifier 的 checked_paths 仍按既有协议预填全部绑定文件。
 */
export function reportSkeletonForJob(job: Job): Record<string, unknown> {
  const skeleton: Record<string, unknown> = {
    role: job.role,
    verdict: "pass",
    findings: [],
  };
  if (requiresReviewer(job.role)) {
    skeleton.reviewer = { kind: "subagent", id: "<agent-id>" };
  }
  if (job.role === "code-reviewer") {
    skeleton.review_scope = {
      job_id: job.job_id,
      packet_digest: job.packet_digest,
      checked_paths: [],
      checked_docs: [],
      unchecked: [],
    };
  } else if (requiresReviewScope(job)) {
    skeleton.review_scope = { checked_paths: job.boundFiles.map(file => file.path) };
  }
  return skeleton;
}

/** 骨架中必须由审查者替换的空值，供 packet 与 CLI 给出同一份填写提示。 */
export function reportSkeletonFillItems(job: Job): string[] {
  const items = ["verdict", "findings"];
  if (requiresReviewer(job.role)) items.push("reviewer.id");
  if (job.role === "code-reviewer") {
    items.push("review_scope.checked_paths", "review_scope.checked_docs", "review_scope.unchecked");
  }
  return items;
}

/** 报告里声明"未检查"且不属于绑定文件的条目（pass 的置信边界，供事件流与门禁透出）。 */
export function outOfScopeUncheckedFromReport(
  report: Record<string, unknown> | null,
  boundFiles: { path: string }[],
): { path: string; reason: string }[] {
  const scope = report?.review_scope as { unchecked?: unknown } | undefined;
  if (!scope || !Array.isArray(scope.unchecked)) return [];
  const bound = new Set(boundFiles.map(file => file.path));
  const items: { path: string; reason: string }[] = [];
  for (const raw of scope.unchecked) {
    const item = raw as { path?: unknown; reason?: unknown };
    if (typeof item?.path !== "string" || typeof item?.reason !== "string") continue;
    if (bound.has(item.path)) continue;
    items.push({ path: item.path, reason: item.reason });
  }
  return items;
}
