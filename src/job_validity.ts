import {
  reviewEvidenceDigest,
  reviewVerifierStaleReason,
} from "./review.ts";
import {
  codeReviewJobStaleReason,
  currentCodeReviewWorkingPaths,
} from "./code_review.ts";
import type { Event, Job } from "./types.ts";

const MISSING_REVIEW_EVIDENCE_REASON = "最终验证工作项缺少执行证据版本";

export interface SubmittedReportValidityContext {
  projectRoot: string;
  changeRoot: string;
  events: Event[];
  reportPath?: string | null;
  ignoredCodePaths?: string[];
}

function reviewReadyVerifierWithoutEvidenceReason(job: Job): string | null {
  if (
    job.role === "verifier" &&
    job.created_from_transition === "review-ready" &&
    !job.gate_id &&
    (typeof job.review_evidence_digest !== "string" || job.review_evidence_digest.length === 0)
  ) {
    return MISSING_REVIEW_EVIDENCE_REASON;
  }
  return null;
}

export function invalidReasonForSnapshot(input: {
  job: Job;
  projectRoot: string;
  changeRoot: string;
  events: Event[];
  currentReviewEvidenceDigest: string;
}): string | null {
  if (input.job.role === "code-reviewer") {
    return codeReviewJobStaleReason(input.projectRoot, input.job, currentCodeReviewWorkingPaths(input.projectRoot, input.events), input.events);
  }
  const invalidReviewReadyVerifier = reviewReadyVerifierWithoutEvidenceReason(input.job);
  if (invalidReviewReadyVerifier) return invalidReviewReadyVerifier;
  return reviewVerifierStaleReason(input.job, input.changeRoot, input.currentReviewEvidenceDigest, input.projectRoot, input.events);
}

export function invalidReasonForSubmittedReport(
  job: Job,
  context: SubmittedReportValidityContext,
): string | null {
  if (job.role === "code-reviewer") {
    const currentPaths = currentCodeReviewWorkingPaths(context.projectRoot, context.events, [
      ...(context.ignoredCodePaths ?? []),
      ...(context.reportPath ? [context.reportPath] : []),
    ]);
    return codeReviewJobStaleReason(context.projectRoot, job, currentPaths, context.events, [
      ...(context.ignoredCodePaths ?? []),
      ...(context.reportPath ? [context.reportPath] : []),
    ]);
  }

  const invalidReviewReadyVerifier = reviewReadyVerifierWithoutEvidenceReason(job);
  if (invalidReviewReadyVerifier) return invalidReviewReadyVerifier;
  const ignored = new Set(context.ignoredCodePaths ?? []);
  if (context.reportPath) ignored.add(context.reportPath);
  return reviewVerifierStaleReason(job, context.changeRoot, reviewEvidenceDigest(context.events), context.projectRoot, context.events, [...ignored]);
}
