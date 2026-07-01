import type { ReviewRisk } from "./review.ts";
import type { JobRole, ReviewJobGateId } from "./types.ts";

export type WorkflowProfile = "light" | "normal" | "strict";

export interface WorkflowProfileResolution {
  profile: WorkflowProfile;
  risk: ReviewRisk;
  reviewRolesByGate: Partial<Record<ReviewJobGateId, JobRole[]>>;
}

const CURRENT_GATE_ROLES_BY_RISK: Record<ReviewRisk, Partial<Record<ReviewJobGateId, readonly JobRole[]>>> = {
  minimal: {
    "explore.discovery_review": [],
    "propose.final_review": [],
    "review.code_review": ["code-reviewer"],
    "review.final_verifier": ["verifier"],
  },
  normal: {
    "explore.discovery_review": [],
    "propose.final_review": ["critic"],
    "review.code_review": ["code-reviewer"],
    "review.final_verifier": ["verifier"],
  },
  strict: {
    "explore.discovery_review": ["critic"],
    "propose.final_review": ["critic", "architect", "test-engineer"],
    "review.code_review": ["code-reviewer"],
    "review.final_verifier": ["verifier"],
  },
};

export function workflowProfileForRisk(risk: ReviewRisk): WorkflowProfile {
  if (risk === "minimal") return "light";
  if (risk === "normal") return "normal";
  return "strict";
}

export function resolveWorkflowProfile(
  risk: ReviewRisk,
): WorkflowProfileResolution {
  const profile = workflowProfileForRisk(risk);
  const rolesByGate = CURRENT_GATE_ROLES_BY_RISK[risk];
  const reviewRolesByGate: Partial<Record<ReviewJobGateId, JobRole[]>> = {};
  for (const [gateId, roles] of Object.entries(rolesByGate) as [ReviewJobGateId, readonly JobRole[]][]) {
    reviewRolesByGate[gateId] = [...roles];
  }
  return { profile, risk, reviewRolesByGate };
}

export function reviewRolesForGate(gateId: ReviewJobGateId, risk: ReviewRisk): JobRole[] {
  return resolveWorkflowProfile(risk).reviewRolesByGate[gateId] ?? [];
}
