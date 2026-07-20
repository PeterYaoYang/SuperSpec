import type { ReviewRisk } from "./review.ts";
import type { Job, JobRole, ReviewJobGateId, Snapshot } from "./types.ts";
import { reviewRolesForGate } from "./workflow_profile.ts";

export interface ReviewGateRule {
  gate_id: ReviewJobGateId;
  created_from_transition: "explore" | "propose-ready" | "review-ready";
  allowedRoles: JobRole[];
  reviewTargets: string[];
  readOnlyRefs: string[];
  requiredRolesForRisk(risk: ReviewRisk): JobRole[];
  matchesOldJob(job: Job): boolean;
  isJobForGate(job: Job): boolean;
  openJobsForGate(snapshot: Snapshot): Job[];
}

function makeReviewGateRule(input: Omit<ReviewGateRule, "isJobForGate" | "openJobsForGate">): ReviewGateRule {
  const gate: ReviewGateRule = {
    ...input,
    isJobForGate(job: Job): boolean {
      if (!input.allowedRoles.includes(job.role)) return false;
      if (job.gate_id) return job.gate_id === input.gate_id;
      return input.matchesOldJob(job);
    },
    openJobsForGate(snapshot: Snapshot): Job[] {
      return snapshot.open_jobs.filter(job => gate.isJobForGate(job));
    },
  };
  return gate;
}

export const EXPLORE_DISCOVERY_REVIEW_GATE_ID = "explore.discovery_review" as const;
export const PROPOSE_FINAL_REVIEW_GATE_ID = "propose.final_review" as const;
export const REVIEW_CODE_REVIEW_GATE_ID = "review.code_review" as const;
export const REVIEW_FINAL_VERIFIER_GATE_ID = "review.final_verifier" as const;

function defaultReviewScope(gate: ReviewGateRule) {
  return {
    reviewTargets: [...gate.reviewTargets],
    readOnlyRefs: [...gate.readOnlyRefs],
    boundPaths: [...new Set([...gate.reviewTargets, ...gate.readOnlyRefs])],
  };
}

export function reviewScopeForGateRole(
  gate: ReviewGateRule,
  role: JobRole,
  requiredRoles: readonly JobRole[] = gate.allowedRoles,
) {
  if (gate.gate_id !== PROPOSE_FINAL_REVIEW_GATE_ID) return defaultReviewScope(gate);

  if (role === "critic") {
    const ownsDesign = !requiredRoles.includes("architect");
    const ownsTestContract = !requiredRoles.includes("test-engineer");
    const reviewTargets = [
      "proposal.md",
      "specs/",
      ...(ownsDesign ? ["design.md"] : []),
      "tasks.md",
      ...(ownsTestContract ? [".superspec/artifacts/test-contract.md"] : []),
    ];
    const readOnlyRefs = [
      ...(!ownsDesign ? ["design.md"] : []),
      ...(!ownsTestContract ? [".superspec/artifacts/test-contract.md"] : []),
      ".superspec/artifacts/discovery.md",
    ];
    return {
      reviewTargets,
      readOnlyRefs,
      boundPaths: [...reviewTargets, ".superspec/artifacts/discovery.md"],
    };
  }

  if (role === "architect") {
    const reviewTargets = ["design.md"];
    return {
      reviewTargets,
      readOnlyRefs: [
        "proposal.md",
        "specs/",
        "tasks.md",
        ".superspec/artifacts/discovery.md",
        ".superspec/artifacts/test-contract.md",
      ],
      boundPaths: [...reviewTargets],
    };
  }

  if (role === "test-engineer") {
    const reviewTargets = [".superspec/artifacts/test-contract.md", "tasks.md"];
    return {
      reviewTargets,
      readOnlyRefs: [
        "proposal.md",
        "specs/",
        "design.md",
        ".superspec/artifacts/discovery.md",
      ],
      boundPaths: [...reviewTargets],
    };
  }

  return defaultReviewScope(gate);
}

const EXPLORE_DISCOVERY_REVIEW_ROLES: JobRole[] = ["critic"];
const PROPOSAL_REVIEW_ROLES: JobRole[] = ["critic", "architect", "test-engineer"];
const PROPOSAL_REVIEW_ROLE_SET = new Set<JobRole>(PROPOSAL_REVIEW_ROLES);
const REVIEW_CODE_REVIEW_ROLES: JobRole[] = ["code-reviewer"];
const REVIEW_FINAL_VERIFIER_ROLES: JobRole[] = ["verifier"];

export const EXPLORE_DISCOVERY_REVIEW_GATE = makeReviewGateRule({
  gate_id: EXPLORE_DISCOVERY_REVIEW_GATE_ID,
  created_from_transition: "explore",
  allowedRoles: EXPLORE_DISCOVERY_REVIEW_ROLES,
  reviewTargets: [".superspec/artifacts/discovery.md"],
  readOnlyRefs: [],
  requiredRolesForRisk(risk: ReviewRisk): JobRole[] {
    return reviewRolesForGate(EXPLORE_DISCOVERY_REVIEW_GATE_ID, risk);
  },
  matchesOldJob(job: Job): boolean {
    return job.created_from_transition === "explore" && job.role === "critic";
  },
});

export const PROPOSE_FINAL_REVIEW_GATE = makeReviewGateRule({
  gate_id: PROPOSE_FINAL_REVIEW_GATE_ID,
  created_from_transition: "propose-ready",
  allowedRoles: PROPOSAL_REVIEW_ROLES,
  reviewTargets: [
    "proposal.md",
    "tasks.md",
    "design.md",
    "specs/",
    ".superspec/artifacts/test-contract.md",
  ],
  readOnlyRefs: [".superspec/artifacts/discovery.md"],
  requiredRolesForRisk(risk: ReviewRisk): JobRole[] {
    return reviewRolesForGate(PROPOSE_FINAL_REVIEW_GATE_ID, risk);
  },
  matchesOldJob(job: Job): boolean {
    return job.created_from_transition === "propose-ready" && PROPOSAL_REVIEW_ROLE_SET.has(job.role);
  },
});

export const REVIEW_CODE_REVIEW_GATE = makeReviewGateRule({
  gate_id: REVIEW_CODE_REVIEW_GATE_ID,
  created_from_transition: "review-ready",
  allowedRoles: REVIEW_CODE_REVIEW_ROLES,
  reviewTargets: [],
  readOnlyRefs: [],
  requiredRolesForRisk(risk: ReviewRisk): JobRole[] {
    return reviewRolesForGate(REVIEW_CODE_REVIEW_GATE_ID, risk);
  },
  matchesOldJob(job: Job): boolean {
    return job.created_from_transition === "review-ready" && job.role === "code-reviewer";
  },
});

export const REVIEW_FINAL_VERIFIER_GATE = makeReviewGateRule({
  gate_id: REVIEW_FINAL_VERIFIER_GATE_ID,
  created_from_transition: "review-ready",
  allowedRoles: REVIEW_FINAL_VERIFIER_ROLES,
  reviewTargets: [],
  readOnlyRefs: [],
  requiredRolesForRisk(risk: ReviewRisk): JobRole[] {
    return reviewRolesForGate(REVIEW_FINAL_VERIFIER_GATE_ID, risk);
  },
  matchesOldJob(job: Job): boolean {
    return job.created_from_transition === "review-ready" &&
      job.role === "verifier" &&
      typeof job.review_evidence_digest === "string" &&
      job.review_evidence_digest.length > 0;
  },
});
