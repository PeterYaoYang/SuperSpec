import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as guard from "../superspec_guard.ts";
import { main_init } from "../src/init_cli.ts";
import { reason_message_zh, translate_action_zh } from "../src/i18n.ts";
import { project_init } from "../src/project_init.ts";
import {
  findRepoRoot,
  GUARD_ROOT,
  REPO_ROOT,
  GUARD_TS,
  GUARD_TS_URL,
  INIT_TS,
  mkdirp,
  writeText,
  readJson,
  materializeEvidenceRecord,
  codes,
  captureStdoutJson,
  captureStdoutText,
  captureMain,
  captureMainJson,
  assertSafeOutputHasNoLeaks,
  assertNoForbiddenAgentKeys,
  walkFiles,
  installOpenspecSkills,
  installSuperSpecAgents,
  createFixture,
  activeFixture,
  withFixture,
  withRuntime,
  waitForChild,
  status,
  passEvidence,
  roleEvidence,
  reviewEvidence,
  reviewGuidanceEvidences,
  legacyCodeReviewWorkflowEvidence,
  mainAdjudication,
  verifyEvidence,
  DEFAULT_RUN_LOG,
  defaultRunLog,
  redEvidence,
  greenEvidence,
  taskReopenEvidence,
  taskReopenResolvedEvidence,
  supersededEvidence,
  alternativeVerificationEvidence,
  reopenBlockingFinding,
  finalTestEvidence,
  archiveReadyEvidences,
  reopenGuidanceEvidences,
  taskReopenReadyEvidences,
  businessInvariantsText,
  testContractText,
  testContractRowsText,
  invariantMatrixText,
  proposalReviewedEvidences,
  prepareProposeComplete,
  setTaskCheckbox,
  EXPLORE_ONLY_STATUS,
  DISCOVERY_REL,
  writeDiscovery,
  discoveryBlob,
  exploreCheck,
  exploreConfirmedEvidences,
  discSchemaCodes,
  exploreFinding,
  exploreRoundReview,
  exploreRoundPrompt,
  exploreDigest,
  dispositionOf,
  userDecision,
  standingAuth,
  supersedeMarker,
  PROPOSAL_REL,
  writeProposal,
  proposalTargets,
  proposalCheck,
  proposalFinding,
  proposalRoundReview,
  proposalRoundPrompt,
  proposalDigest,
  designTargetRefs,
  targetRefList,
  gateFinding,
  roundReviewWithTargets,
  roundDigestWithTargets,
  proposeChainThroughDesign,
} from "./helpers/superspec_guard_fixture.ts";
import type { JsonMap, Fixture } from "./helpers/superspec_guard_fixture.ts";

withFixture("DISC main_review_digest schema is fail-closed", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const good = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  assert.ok(!discSchemaCodes(fx, [good]).includes("review_digest_invalid"), JSON.stringify(discSchemaCodes(fx, [good])));
  const cases: JsonMap[] = [
    exploreDigest(fx, 1, [], { review_round_id: undefined }),
    exploreDigest(fx, 1, [], { review_round_id: "round-one" }),
    exploreDigest(fx, 1, [], { created_by: "test" }),
    exploreDigest(fx, 1, [], { target_refs: [] }),
    exploreDigest(fx, 1, [], { source_review_evidence_refs: [] }),
    exploreDigest(fx, 1, [], { finding_dispositions: "none" }),
    // review_complete must use main_adjudication as its disclosure carrier (design §8).
    exploreDigest(fx, 1, [], { gate: "review_complete" }),
    // disposition entry problems
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "ignored" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed", rationale: "" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed", route: undefined })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed", decision_scope_key: "" })]),
    // per-disposition proof shape
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "fixed" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "false_positive" })]),
    exploreDigest(fx, 1, [dispositionOf(finding, { disposition: "user_decided" })]),
    // needs_user_decision on a status:"pass" digest is a contradiction
    exploreDigest(fx, 1, [dispositionOf(finding)], { status: "pass" }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("review_digest_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC user_review_decision schema is fail-closed", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const good = userDecision(fx, finding);
  assert.ok(!discSchemaCodes(fx, [good]).includes("user_decision_invalid"), JSON.stringify(discSchemaCodes(fx, [good])));
  const goodD = userDecision(fx, finding, {
    decision: "option_d_custom",
    user_text: "只读 ScheduleActualServiceImpl 做行为锚点，不修改共享服务。",
    structured_decision: {
      scope: ["VacationController"],
      non_goals: ["shared service"],
      acceptance_impact: [],
      test_impact: [],
      requires_artifact_update: true,
      requires_rereview: true,
    },
  });
  assert.ok(!discSchemaCodes(fx, [goodD]).includes("user_decision_invalid"), JSON.stringify(discSchemaCodes(fx, [goodD])));
  const cases: JsonMap[] = [
    userDecision(fx, finding, { created_by: "main-thread" }),
    userDecision(fx, finding, { decision: "option_z" }),
    userDecision(fx, finding, { finding_uids: [] }),
    userDecision(fx, finding, { decision_scope_key: "" }),
    userDecision(fx, finding, { confirmed_refs: [] }),
    userDecision(fx, finding, { decision: "option_d_custom" }),
    userDecision(fx, finding, {
      decision: "option_d_custom",
      user_text: "ok",
      structured_decision: { scope: [], non_goals: [], acceptance_impact: [], test_impact: [], requires_artifact_update: "yes", requires_rereview: true },
    }),
    userDecision(fx, finding, {
      decision: "option_d_custom",
      user_text: "ok",
      structured_decision: { scope: [], requires_artifact_update: false, requires_rereview: false },
    }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("user_decision_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC review_standing_authorization schema is fail-closed", (fx) => {
  writeDiscovery(fx);
  assert.ok(!discSchemaCodes(fx, [standingAuth()]).includes("standing_authorization_invalid"));
  const cases: JsonMap[] = [
    standingAuth({ created_by: "main-thread" }),
    standingAuth({ confirmation_text: "" }),
    standingAuth({ valid_gates: [] }),
    standingAuth({ allowed_categories: ["scope"], excluded_categories: ["scope"] }),
    standingAuth({ allowed_categories: ["vibes"] }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("standing_authorization_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC findings on role review evidence are schema-checked", (fx) => {
  writeDiscovery(fx);
  const good = exploreRoundReview(fx, 1, [exploreFinding()]);
  assert.ok(!discSchemaCodes(fx, [good]).includes("review_finding_invalid"), JSON.stringify(discSchemaCodes(fx, [good])));
  const cases: JsonMap[] = [
    exploreRoundReview(fx, 1, [exploreFinding(1, { finding_type: "nitpick" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { category: "vibes" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { material_categories: ["scope"], decision_scope_key: "" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { finding_uid: "explore_complete:EV-other:EXP-SCOPE-001" })]),
    exploreRoundReview(fx, 1, [exploreFinding(1, { summary: "" })]),
    // findings without a parseable same-gate round id break the round chain
    exploreRoundReview(fx, 1, [exploreFinding()], { review_round_id: undefined }),
  ];
  for (const [idx, ev] of cases.entries()) {
    assert.ok(discSchemaCodes(fx, [ev]).includes("review_finding_invalid"), `case ${idx}: ${JSON.stringify(discSchemaCodes(fx, [ev]))}`);
  }
});

withFixture("DISC B6 legacy explore evidence without rounds stays grandfathered", (fx) => {
  writeDiscovery(fx);
  const decision = exploreCheck(fx, exploreConfirmedEvidences(fx));
  assert.equal(decision.allowed, true, JSON.stringify(decision));
});

withFixture("DISC material blocker without digest blocks explore", (fx) => {
  writeDiscovery(fx);
  const decision = exploreCheck(fx, [exploreRoundReview(fx, 1, [exploreFinding()])]);
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("missing_review_digest"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("finding_unresolved"), JSON.stringify(reasonCodes));
});

withFixture("DISC needs_user_decision keeps the gate blocked until the user decides", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const decision = exploreCheck(fx, [
    exploreRoundReview(fx, 1, [finding]),
    exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" }),
  ]);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("needs_user_decision_pending"), JSON.stringify(decision.block_reasons));
});

withFixture("DISC digest must cover every finding of its round", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const decision = exploreCheck(fx, [
    exploreRoundReview(fx, 1, [finding]),
    exploreDigest(fx, 1, []),
  ]);
  assert.equal(decision.allowed, false);
  assert.ok(codes(decision.block_reasons).includes("finding_undisclosed"), JSON.stringify(decision.block_reasons));
});

withFixture("DISC latest round and digest must pin the current target set", (fx) => {
  writeDiscovery(fx);
  const evidences = [
    exploreRoundReview(fx, 1, []),
    exploreDigest(fx, 1, []),
    passEvidence("explore_complete", "human_confirmation"),
  ];
  const before = exploreCheck(fx, evidences);
  assert.equal(before.allowed, true, JSON.stringify(before));
  writeDiscovery(fx, "discovery facts v2 edited after review\n");
  const after = exploreCheck(fx, evidences);
  assert.equal(after.allowed, false);
  const reasonCodes = codes(after.block_reasons);
  assert.ok(reasonCodes.includes("review_round_stale"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("review_digest_stale"), JSON.stringify(reasonCodes));
});

withFixture("DISC clean rerun cannot erase an old open blocker", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r2 = exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1]) });
  const decision = exploreCheck(fx, [
    r1,
    r2,
    exploreDigest(fx, 2, [], { previous_digest_refs: [] }),
  ]);
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("finding_unresolved"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("digest_chain_broken"), JSON.stringify(reasonCodes));
});

withFixture("DISC disposition identity must match the origin finding verbatim", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const decision = exploreCheck(fx, [
    exploreRoundReview(fx, 1, [finding]),
    exploreDigest(fx, 1, [dispositionOf(finding, {
      disposition: "fixed",
      category: "implementation",
      material_categories: [],
      summary: "minor wording nit (downgraded)",
      artifact_update_refs: [DISCOVERY_REL],
    })]),
  ]);
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("finding_identity_mismatch"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("finding_summary_not_verbatim"), JSON.stringify(reasonCodes));
});

withFixture("DISC material terminal dispositions require a binding user decision", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const review = exploreRoundReview(fx, 1, [finding]);
  const terminal = (overrides: JsonMap = {}) => exploreDigest(fx, 1, [dispositionOf(finding, {
    disposition: "user_decided",
    user_decision_refs: ["EV-user-decision-1"],
    ...overrides,
  })]);
  // material fixed without any user anchor (rule 8): source/artifact proof alone is not enough
  const noAnchor = exploreCheck(fx, [review, exploreDigest(fx, 1, [dispositionOf(finding, {
    disposition: "fixed",
    artifact_update_refs: [DISCOVERY_REL],
  })])]);
  assert.ok(codes(noAnchor.block_reasons).includes("user_decision_unbound"), JSON.stringify(noAnchor.block_reasons));
  const unboundCases: JsonMap[][] = [
    // decision exists but names a different finding_uid
    [review, terminal(), userDecision(fx, finding, { finding_uids: ["explore_complete:EV-explore-r1-critic:OTHER-001"] })],
    // decision_scope_key mismatch
    [review, terminal(), userDecision(fx, finding, { decision_scope_key: "demo-change:explore:another-issue" })],
    // material categories not covered
    [review, terminal(), userDecision(fx, finding, { material_categories: [] })],
    // confirmed blob does not match what the origin review pinned
    [review, terminal(), userDecision(fx, finding, { confirmed_refs: [{ path: DISCOVERY_REL, blob_sha: "0".repeat(40) }] })],
    // dangling ref: decision evidence does not exist at all
    [review, terminal()],
  ];
  for (const [idx, evidences] of unboundCases.entries()) {
    const decision = exploreCheck(fx, evidences);
    assert.equal(decision.allowed, false, `case ${idx}`);
    assert.ok(codes(decision.block_reasons).includes("user_decision_unbound"), `case ${idx}: ${JSON.stringify(decision.block_reasons)}`);
  }
});

withFixture("DISC option_d_custom drives artifact update, re-review, and the full loop", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const decisionEv = userDecision(fx, finding, {
    decision: "option_d_custom",
    user_text: "缩小到适配器层，共享服务只读。",
    structured_decision: {
      scope: ["VacationDurationGetAdapter"],
      non_goals: ["ScheduleActualServiceImpl"],
      acceptance_impact: ["adapter contract"],
      test_impact: ["characterization tests"],
      requires_artifact_update: true,
      requires_rereview: true,
    },
  });
  // requires_rereview: consuming pass digest in the same round is too early
  const sameRound = exploreCheck(fx, [r1, decisionEv, exploreDigest(fx, 1, [dispositionOf(finding, {
    disposition: "user_decided",
    user_decision_refs: ["EV-user-decision-1"],
    artifact_update_refs: [DISCOVERY_REL],
  })])]);
  assert.ok(codes(sameRound.block_reasons).includes("rereview_required"), JSON.stringify(sameRound.block_reasons));
  // now run the full loop: update discovery, supersede stale r1 review, rerun critic, digest round 2
  writeDiscovery(fx, "discovery facts v2 narrowed to adapter layer\n");
  const r2 = exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) });
  // requires_artifact_update: terminal disposition must cite the artifact update
  const noUpdateRef = exploreCheck(fx, [
    r1, r1Digest, decisionEv, supersedeMarker("EV-explore-r1-critic"), r2,
    exploreDigest(fx, 2, [dispositionOf(finding, {
      disposition: "user_decided",
      user_decision_refs: ["EV-user-decision-1"],
    })]),
  ]);
  assert.ok(codes(noUpdateRef.block_reasons).includes("artifact_update_required"), JSON.stringify(noUpdateRef.block_reasons));
  const full = exploreCheck(fx, [
    r1, r1Digest, decisionEv, supersedeMarker("EV-explore-r1-critic"), r2,
    exploreDigest(fx, 2, [dispositionOf(finding, {
      disposition: "user_decided",
      user_decision_refs: ["EV-user-decision-1"],
      artifact_update_refs: [DISCOVERY_REL],
    })]),
    passEvidence("explore_complete", "human_confirmation"),
  ]);
  assert.equal(full.allowed, true, JSON.stringify(full.block_reasons));
});

withFixture("DISC standing authorization coverage is category, gate, type, and expiry bound", (fx) => {
  writeDiscovery(fx);
  // allow path: non-material finding accepted through an explicit user standing authorization
  const minor = exploreFinding(1, {
    finding_id: "EXP-IMPL-001",
    finding_type: "non_blocking_finding",
    category: "implementation",
    material_categories: [],
    decision_scope_key: "",
    requires_user_decision: false,
    summary: "implementation note: adapter naming could be tighter",
  });
  const review = exploreRoundReview(fx, 1, [minor]);
  const accepted = (authOverrides: JsonMap = {}, findingOverride: JsonMap = minor) => [
    exploreRoundReview(fx, 1, [findingOverride]),
    standingAuth(authOverrides),
    exploreDigest(fx, 1, [dispositionOf(findingOverride, {
      disposition: "accepted_deviation",
      standing_authorization_refs: ["EV-standing-auth-1"],
    })]),
    passEvidence("explore_complete", "human_confirmation"),
  ];
  const ok = exploreCheck(fx, accepted());
  assert.equal(ok.allowed, true, JSON.stringify(ok.block_reasons));
  const material = exploreFinding(1, { finding_type: "scope_risk" });
  const unboundCases: JsonMap[][] = [
    // material category not in allowed_categories
    accepted({}, material),
    // blockers can never ride a standing authorization
    accepted({ allowed_categories: ["scope", "implementation", "test_gap"] }, exploreFinding()),
    // gate mismatch
    accepted({ valid_gates: ["design_complete"] }),
    // expired
    accepted({ expires_at: "2020-01-01T00:00:00Z" }),
    // excluded wins over allowed even if listed
    accepted({ excluded_categories: ["implementation"] }),
  ];
  for (const [idx, evidences] of unboundCases.entries()) {
    const decision = exploreCheck(fx, evidences);
    assert.equal(decision.allowed, false, `case ${idx}`);
    assert.ok(codes(decision.block_reasons).includes("standing_authorization_unbound"), `case ${idx}: ${JSON.stringify(decision.block_reasons)}`);
  }
  assert.ok(review);
});

withFixture("DISC accepted material deviation must be acknowledged by the clean round", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const decisionEv = userDecision(fx, finding);
  const r2Digest = exploreDigest(fx, 2, [dispositionOf(finding, {
    disposition: "accepted_deviation",
    user_decision_refs: ["EV-user-decision-1"],
  })]);
  const withoutAck = exploreCheck(fx, [
    r1, r1Digest, decisionEv,
    exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) }),
    r2Digest,
  ]);
  assert.equal(withoutAck.allowed, false);
  assert.ok(codes(withoutAck.block_reasons).includes("accepted_deviation_unacknowledged"), JSON.stringify(withoutAck.block_reasons));
  const withAck = exploreCheck(fx, [
    r1, r1Digest, decisionEv,
    exploreRoundReview(fx, 2, [], {
      prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]),
      acknowledged_accepted_deviation_uids: [finding.finding_uid],
    }),
    r2Digest,
    passEvidence("explore_complete", "human_confirmation"),
  ]);
  assert.equal(withAck.allowed, true, JSON.stringify(withAck.block_reasons));
});

withFixture("DISC round numbering must be continuous and digest chain unbroken", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const gap = exploreCheck(fx, [
    r1,
    exploreRoundReview(fx, 3, [], { prompt_ref: exploreRoundPrompt(fx, 3, [r1]) }),
  ]);
  assert.ok(codes(gap.block_reasons).includes("review_round_discontinuous"), JSON.stringify(gap.block_reasons));
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const broken = exploreCheck(fx, [
    r1, r1Digest, userDecision(fx, finding),
    exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) }),
    exploreDigest(fx, 2, [dispositionOf(finding, {
      disposition: "user_decided",
      user_decision_refs: ["EV-user-decision-1"],
    })], { previous_digest_refs: [] }),
  ]);
  assert.ok(codes(broken.block_reasons).includes("digest_chain_broken"), JSON.stringify(broken.block_reasons));
});

withFixture("DISC round k>1 prompt must embed the tool-rendered finding ledger", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding(1, { finding_type: "scope_risk" });
  const r1 = exploreRoundReview(fx, 1, [finding]);
  const r1Digest = exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  const decisionEv = userDecision(fx, finding);
  const r2Digest = exploreDigest(fx, 2, [dispositionOf(finding, {
    disposition: "user_decided",
    user_decision_refs: ["EV-user-decision-1"],
  })]);
  const bare = exploreCheck(fx, [r1, r1Digest, decisionEv, exploreRoundReview(fx, 2, []), r2Digest]);
  assert.equal(bare.allowed, false);
  assert.ok(codes(bare.block_reasons).includes("ledger_injection_missing"), JSON.stringify(bare.block_reasons));
  const injected = exploreCheck(fx, [
    r1, r1Digest, decisionEv,
    exploreRoundReview(fx, 2, [], { prompt_ref: exploreRoundPrompt(fx, 2, [r1, r1Digest]) }),
    r2Digest,
  ]);
  assert.ok(!codes(injected.block_reasons).includes("ledger_injection_missing"), JSON.stringify(injected.block_reasons));
});

withFixture("DISC exceeding the round budget escalates to the user", (fx) => {
  writeDiscovery(fx);
  const finding = exploreFinding();
  const evidences: JsonMap[] = [exploreRoundReview(fx, 1, [finding]), exploreDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" })];
  for (let round = 2; round <= 4; round++) {
    evidences.push(exploreRoundReview(fx, round, [], { prompt_ref: exploreRoundPrompt(fx, round, evidences.slice()) }));
    evidences.push(exploreDigest(fx, round, [dispositionOf(finding)], { status: "blocked" }));
  }
  const decision = exploreCheck(fx, evidences);
  assert.equal(decision.allowed, false);
  const budget = decision.block_reasons.find((item: JsonMap) => item.code === "round_budget_exhausted");
  assert.ok(budget, JSON.stringify(codes(decision.block_reasons)));
  assert.ok(String(budget.message).includes("escalate_round_budget"), JSON.stringify(budget));
});


withFixture("DISC2 proposal_reviewed is a hard gate with a mandatory disclosure loop", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const explore = exploreConfirmedEvidences(fx);
  // No proposal review at all: both the role check and the born-disclosure check block.
  const empty = proposalCheck(fx, [...explore]);
  assert.equal(empty.allowed, false);
  assert.ok(codes(empty.block_reasons).includes("missing_proposal_review"), JSON.stringify(empty.block_reasons));
  assert.ok(codes(empty.block_reasons).includes("missing_review_digest"), JSON.stringify(empty.block_reasons));
  // Old-style (round-less, findings-less) critic evidence cannot dodge the disclosure loop:
  // proposal_reviewed has no legacy population, so there is no grandfather path.
  const oldStyle = proposalCheck(fx, [...explore, roleEvidence(fx, "proposal_reviewed", "critic")]);
  assert.equal(oldStyle.allowed, false);
  assert.ok(codes(oldStyle.block_reasons).includes("missing_review_digest"), JSON.stringify(oldStyle.block_reasons));
  // Round-tagged clean review + digest is the only allow path.
  const full = proposalCheck(fx, [...explore, proposalRoundReview(fx, 1, []), proposalDigest(fx, 1, [])]);
  assert.equal(full.allowed, true, JSON.stringify(full.block_reasons));
});

withFixture("DISC2 proposal blocker cannot be silently fixed by the main thread", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const explore = exploreConfirmedEvidences(fx);
  const finding = proposalFinding();
  const r1 = proposalRoundReview(fx, 1, [finding]);
  const r1Digest = proposalDigest(fx, 1, [dispositionOf(finding)], { status: "blocked" });
  // Disclosed but waiting for the user: hard stop.
  const pending = proposalCheck(fx, [...explore, r1, r1Digest]);
  assert.equal(pending.allowed, false);
  assert.ok(codes(pending.block_reasons).includes("needs_user_decision_pending"), JSON.stringify(pending.block_reasons));
  // "Silent fix" without any disclosure: rerun the critic straight to a clean round and never
  // give the r1 blocker a disposition — the ledger keeps the history alive.
  const silent = proposalCheck(fx, [
    ...explore, r1,
    proposalRoundReview(fx, 2, [], { prompt_ref: proposalRoundPrompt(fx, 2, [r1]) }),
    proposalDigest(fx, 2, [], { previous_digest_refs: [] }),
  ]);
  assert.equal(silent.allowed, false);
  assert.ok(codes(silent.block_reasons).includes("finding_unresolved"), JSON.stringify(silent.block_reasons));
  // Dropping the disclosed finding from the next digest is just as blocked: the pending
  // user decision survives in the ledger.
  const dropped = proposalCheck(fx, [
    ...explore, r1, r1Digest,
    proposalRoundReview(fx, 2, [], { prompt_ref: proposalRoundPrompt(fx, 2, [r1, r1Digest]) }),
    proposalDigest(fx, 2, []),
  ]);
  assert.equal(dropped.allowed, false);
  assert.ok(codes(dropped.block_reasons).includes("needs_user_decision_pending"), JSON.stringify(dropped.block_reasons));
  // Legal path: user decision + user_decided disposition in the round 2 digest.
  const decisionEv = userDecision(fx, finding, {
    gate: "proposal_reviewed",
    review_round_id: "proposal_reviewed-r1",
    confirmed_refs: proposalTargets(fx),
  });
  const legal = proposalCheck(fx, [
    ...explore, r1, r1Digest, decisionEv,
    proposalRoundReview(fx, 2, [], { prompt_ref: proposalRoundPrompt(fx, 2, [r1, r1Digest]) }),
    proposalDigest(fx, 2, [dispositionOf(finding, { disposition: "user_decided", user_decision_refs: ["EV-user-decision-1"] })]),
  ]);
  assert.equal(legal.allowed, true, JSON.stringify(legal.block_reasons));
});

withFixture("DISC2 disposition routes are bounded globally and per gate", (fx) => {
  writeDiscovery(fx);
  writeProposal(fx);
  const explore = exploreConfirmedEvidences(fx);
  const finding = proposalFinding();
  // Unknown route fails the digest schema outright.
  const schemaCodes = discSchemaCodes(fx, [proposalDigest(fx, 1, [dispositionOf(finding, { route: "just-fix-it" })], { status: "blocked" })]);
  assert.ok(schemaCodes.includes("review_digest_invalid"), JSON.stringify(schemaCodes));
  // A known route that is illegal on this gate blocks: reopen_tasks belongs to review_complete.
  const r1 = proposalRoundReview(fx, 1, [finding]);
  const illegal = proposalCheck(fx, [
    ...explore, r1,
    proposalDigest(fx, 1, [dispositionOf(finding, { route: "reopen_tasks" })], { status: "blocked" }),
  ]);
  assert.ok(codes(illegal.block_reasons).includes("finding_route_invalid"), JSON.stringify(illegal.block_reasons));
  // return_explore is the legal escape hatch for discovery-incomplete proposal findings.
  const legalRoute = proposalCheck(fx, [
    ...explore, r1,
    proposalDigest(fx, 1, [dispositionOf(finding, { route: "return_explore" })], { status: "blocked" }),
  ]);
  assert.ok(!codes(legalRoute.block_reasons).includes("finding_route_invalid"), JSON.stringify(legalRoute.block_reasons));
});

withFixture("DISC2 design/specs/propose paths all require proposal_reviewed", (fx) => {
  // Canonical state surfaces (design Phase 2): entry gates, alias, route phase.
  assert.equal(guard.ARTIFACT_ENTER_GATE.specs, "proposal_reviewed");
  assert.equal(guard.ARTIFACT_ENTER_GATE.design, "proposal_reviewed");
  assert.equal(guard.GATE_ALIASES["propose.proposal_reviewed"], "proposal_reviewed");
  assert.equal(guard.GATE_ROUTE.proposal_reviewed, "propose");
  const evidences = prepareProposeComplete(fx, { checked: true }).filter((ev) => ev.gate !== "proposal_reviewed");
  // Direct design gate and its alias.
  for (const gateName of ["design_complete", "propose.design_reviewed"]) {
    const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, gateName);
    assert.equal(decision.allowed, false, gateName);
    assert.ok(codes(decision.block_reasons).includes("proposal_reviewed_failed"), `${gateName}: ${JSON.stringify(codes(decision.block_reasons))}`);
  }
  // propose_complete subgate list.
  const propose = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "propose_complete");
  assert.equal(propose.allowed, false);
  assert.ok(codes(propose.block_reasons).includes("proposal_reviewed_failed"), JSON.stringify(codes(propose.block_reasons)));
  // Artifact entry paths for specs/design.
  for (const artifact of ["specs", "design"]) {
    const entry = guard.check_artifact("demo-change", status(fx), fx.change, evidences, artifact);
    assert.equal(entry.allowed, false, artifact);
    assert.ok(codes(entry.block_reasons).includes("proposal_reviewed_failed"), `${artifact}: ${JSON.stringify(codes(entry.block_reasons))}`);
  }
  // Direct tasks-side entries block while a predecessor disclosure gate is missing.
  for (const gateName of ["propose.tasks_mapped", "tasks_complete"]) {
    const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, gateName);
    assert.equal(decision.allowed, false, gateName);
    assert.ok(codes(decision.block_reasons).includes("test_contract_not_honored"), `${gateName}: ${JSON.stringify(codes(decision.block_reasons))}`);
  }
  // Restoring the proposal evidence restores the whole chain.
  const restored = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx, { checked: true }), "propose_complete");
  assert.equal(restored.allowed, true, JSON.stringify(restored.block_reasons));
});

withFixture("DISC2 design disclosure pins the full glob target set (set equality)", (fx) => {
  const evidences = prepareProposeComplete(fx);
  const designTargets = designTargetRefs(fx);
  assert.ok(designTargets.some((ref) => ref.path === "specs/attendance/spec.md"), JSON.stringify(designTargets));
  const roundEvidences = [
    ...evidences,
    roleEvidence(fx, "design_complete", "critic", {
      evidence_id: "EV-design-r1-critic",
      review_round_id: "design_complete-r1",
      output_ref: ".superspec/reports/design-r1-critic.md",
      findings: [],
      target_refs: designTargets,
    }),
    passEvidence("design_complete", "main_review_digest", {
      evidence_id: "EV-design-r1-digest",
      created_by: "main-thread",
      review_round_id: "design_complete-r1",
      target_refs: designTargets,
      source_review_evidence_refs: ["EV-design-r1-critic"],
      previous_digest_refs: [],
      finding_dispositions: [],
    }),
  ];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, roundEvidences, "design_complete");
  assert.equal(before.allowed, true, JSON.stringify(before.block_reasons));
  // A spec file added after the digest changes the enumerated set: every pinned blob still
  // matches, but set equality (P1-6) makes both the round and the digest stale.
  writeText(join(fx.change, "specs", "attendance", "extra.md"), "#### Scenario: Scenario B\n");
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, roundEvidences, "design_complete");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("review_round_stale"), JSON.stringify(codes(after.block_reasons)));
  assert.ok(codes(after.block_reasons).includes("review_digest_stale"), JSON.stringify(codes(after.block_reasons)));
});

withFixture("DISC2 legacy design evidence stays grandfathered until round-tagged evidence appears", (fx) => {
  // prepareProposeComplete uses legacy (round-less) design reviews; the disclosure loop must
  // stay inactive for them (P2-3) so in-flight changes are not retroactively blocked.
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "design_complete");
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
});


withFixture("DISC3 invariants material blocker requires disclosure when round-tagged", (fx) => {
  const base = proposeChainThroughDesign(fx);
  const targets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const finding = gateFinding("invariants_reviewed", 1, "EV-invariants-r1-critic", "INV-TRUTH-001");
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...base,
    roundReviewWithTargets(fx, "invariants_reviewed", "critic", 1, targets, [finding]),
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("missing_review_digest"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("finding_unresolved"), JSON.stringify(reasonCodes));
});

withFixture("DISC3 upstream business-invariants edit stale after digest", (fx) => {
  const base = proposeChainThroughDesign(fx);
  const targets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const finding = gateFinding("invariants_reviewed", 1, "EV-invariants-r1-critic", "INV-TRUTH-001");
  const review = roundReviewWithTargets(fx, "invariants_reviewed", "critic", 1, targets, [finding]);
  const digest = roundDigestWithTargets(fx, "invariants_reviewed", 1, targets, [dispositionOf(finding, {
    disposition: "needs_user_decision",
    route: "stay_same_gate_user_decision",
    route_reason: "business semantics need user confirmation",
  })], { status: "blocked" });
  const evidences = [...base, review, roleEvidence(fx, "invariants_reviewed", "test-engineer"), digest];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "invariants_reviewed");
  assert.equal(before.allowed, false);
  assert.ok(codes(before.block_reasons).includes("needs_user_decision_pending"));
  writeText(join(fx.change, ".superspec", "artifacts", "business-invariants.md"), businessInvariantsText("INV-002"));
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "invariants_reviewed");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("review_digest_stale"), JSON.stringify(codes(after.block_reasons)));
});

withFixture("DISC3 illegal disposition routes block per gate matrix", (fx) => {
  const base = proposeChainThroughDesign(fx);
  const invTargets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const invFinding = gateFinding("invariants_reviewed", 1, "EV-invariants-r1-critic", "INV-TRUTH-001");
  const invReview = roundReviewWithTargets(fx, "invariants_reviewed", "critic", 1, invTargets, [invFinding]);
  const invIllegal = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...base,
    invReview,
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    roundDigestWithTargets(fx, "invariants_reviewed", 1, invTargets, [dispositionOf(invFinding, {
      disposition: "needs_user_decision",
      route: "reopen_tasks",
      route_reason: "illegal on invariants gate",
    })], { status: "blocked" }),
  ], "invariants_reviewed");
  assert.ok(codes(invIllegal.block_reasons).includes("finding_route_invalid"), JSON.stringify(invIllegal.block_reasons));

  const tcTargets = guard.enumerate_review_targets("test_contract_drafted", fx.change)!;
  const tcFinding = gateFinding("test_contract_drafted", 1, "EV-test-contract-r1-critic", "TC-ACCEPT-001", {
    category: "acceptance",
    material_categories: ["acceptance"],
    decision_scope_key: "demo-change:test-contract:acceptance",
    summary: "acceptance criteria conflict with spec scenario",
  });
  const tcReview = roundReviewWithTargets(fx, "test_contract_drafted", "critic", 1, tcTargets, [tcFinding]);
  const tcIllegal = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...prepareProposeComplete(fx).filter((ev) => ev.gate !== "test_contract_drafted"),
    tcReview,
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roundDigestWithTargets(fx, "test_contract_drafted", 1, tcTargets, [dispositionOf(tcFinding, {
      disposition: "needs_user_decision",
      route: "return_test_contract_drafted",
      route_reason: "wrong route on test_contract gate",
    })], { status: "blocked" }),
  ], "test_contract_drafted");
  assert.ok(codes(tcIllegal.block_reasons).includes("finding_route_invalid"), JSON.stringify(tcIllegal.block_reasons));
});

withFixture("DISC3 test_contract glob set equality stale when spec file added", (fx) => {
  const base = prepareProposeComplete(fx);
  const targets = guard.enumerate_review_targets("test_contract_drafted", fx.change)!;
  const evidences = [
    ...base.filter((ev) => ev.gate !== "test_contract_drafted"),
    roundReviewWithTargets(fx, "test_contract_drafted", "critic", 1, targets, []),
    roleEvidence(fx, "test_contract_drafted", "test-engineer"),
    roundDigestWithTargets(fx, "test_contract_drafted", 1, targets, []),
  ];
  const before = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(before.allowed, true, JSON.stringify(before.block_reasons));
  writeText(join(fx.change, "specs", "attendance", "extra.md"), "#### Scenario: Scenario B\n");
  const after = guard.check_superspec_gate("demo-change", status(fx), fx.change, evidences, "test_contract_drafted");
  assert.equal(after.allowed, false);
  assert.ok(codes(after.block_reasons).includes("review_digest_stale"), JSON.stringify(codes(after.block_reasons)));
});

withFixture("DISC3 legacy invariants and test_contract evidence stay grandfathered", (fx) => {
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "invariants_reviewed");
  assert.equal(decision.allowed, true, JSON.stringify(decision.block_reasons));
  const drafted = guard.check_superspec_gate("demo-change", status(fx), fx.change, prepareProposeComplete(fx), "test_contract_drafted");
  assert.equal(drafted.allowed, true, JSON.stringify(drafted.block_reasons));
});

withFixture("DISC3 tasks_complete disclosure activates only with round-tagged review", (fx) => {
  const base = prepareProposeComplete(fx, { checked: true });
  const legacy = guard.check_superspec_gate("demo-change", status(fx), fx.change, base, "tasks_complete");
  assert.equal(legacy.allowed, true, JSON.stringify(legacy.block_reasons));
  const targets = guard.enumerate_review_targets("tasks_complete", fx.change)!;
  const finding = gateFinding("tasks_complete", 1, "EV-tasks-r1-critic", "TASK-MAP-001", {
    category: "acceptance",
    material_categories: ["acceptance"],
    decision_scope_key: "demo-change:tasks:mapping",
    summary: "task test_refs do not cover the agreed acceptance boundary",
  });
  const review = roundReviewWithTargets(fx, "tasks_complete", "critic", 1, targets, [finding]);
  const blocked = guard.check_superspec_gate("demo-change", status(fx), fx.change, [...base, review], "tasks_complete");
  assert.equal(blocked.allowed, false);
  assert.ok(codes(blocked.block_reasons).includes("missing_review_digest"), JSON.stringify(blocked.block_reasons));
  const legalRoute = roundDigestWithTargets(fx, "tasks_complete", 1, targets, [dispositionOf(finding, {
    disposition: "needs_user_decision",
    route: "return_test_contract_drafted",
    route_reason: "acceptance mapping wrong; return to test contract gate",
  })], { status: "blocked" });
  const withRoute = guard.check_superspec_gate("demo-change", status(fx), fx.change, [...base, review, legalRoute], "tasks_complete");
  assert.ok(!codes(withRoute.block_reasons).includes("finding_route_invalid"), JSON.stringify(withRoute.block_reasons));
});

withFixture("DISC3 root-mismatched or escaping pinned target paths fail closed as stale", (fx) => {
  // Design §7: every propose-period gate pins change-root relative paths. Repo-root prefixes or
  // "../" traversal never equal the enumerated canonical set, so set equality (P1-6) must block.
  const base = proposeChainThroughDesign(fx);
  const targets = guard.enumerate_review_targets("invariants_reviewed", fx.change)!;
  const badTargets = [...targets.entries()].map(([path, blob_sha], idx) => ({
    path: idx === 0 ? `openspec/changes/demo-change/${path}` : `../demo-change/${path}`,
    blob_sha,
  }));
  const review = roleEvidence(fx, "invariants_reviewed", "critic", {
    evidence_id: "EV-invariants_reviewed-r1-critic",
    review_round_id: "invariants_reviewed-r1",
    output_ref: ".superspec/reports/invariants_reviewed-r1-critic.md",
    findings: [],
    target_refs: badTargets,
  });
  const digest = passEvidence("invariants_reviewed", "main_review_digest", {
    evidence_id: "EV-invariants_reviewed-r1-digest",
    created_by: "main-thread",
    review_round_id: "invariants_reviewed-r1",
    target_refs: badTargets,
    source_review_evidence_refs: ["EV-invariants_reviewed-r1-critic"],
    previous_digest_refs: [],
    finding_dispositions: [],
  });
  const decision = guard.check_superspec_gate("demo-change", status(fx), fx.change, [
    ...base,
    review,
    roleEvidence(fx, "invariants_reviewed", "test-engineer"),
    digest,
  ], "invariants_reviewed");
  assert.equal(decision.allowed, false);
  const reasonCodes = codes(decision.block_reasons);
  assert.ok(reasonCodes.includes("review_round_stale"), JSON.stringify(reasonCodes));
  assert.ok(reasonCodes.includes("review_digest_stale"), JSON.stringify(reasonCodes));
});
