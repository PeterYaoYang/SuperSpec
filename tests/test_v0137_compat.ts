// SuperSpec v0.1.37 compatibility tests

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, digestOf, eventsFile, readEvents } from "../src/store.ts";
import { rebuildSnapshot } from "../src/sync.ts";
import { next } from "../src/next.ts";
import { reviewReady } from "../src/transition.ts";
import { jobsPacket, recordJobSubmit } from "../src/record.ts";
import { reviewEvidenceDigest } from "../src/review.ts";
import type { Event, EventType, Job, State } from "../src/types.ts";

type CompatState = "explore" | "propose" | "propose_ready" | "apply" | "apply_done" | "review" | "accepted";

interface Fixture {
  projectRoot: string;
  change: string;
  changeRoot: string;
  cleanup: () => void;
}

let v0137EventSeq = 0;

/*
 * Mirrors v0.1.37 src/store.ts makeEvent output.
 * Keep this inlined instead of calling current makeEvent so compatibility tests
 * represent the old event shape even if current event helpers later grow fields.
 */
function v0137Event(
  change: string,
  eventType: EventType,
  payload: Record<string, unknown>,
  opts: {
    transitionId?: string | null;
    idempotencyKey?: string | null;
    prevSnapshotDigest?: string | null;
  } = {},
): Event {
  const seq = ++v0137EventSeq;
  const base = {
    change_id: change,
    event_type: eventType,
    transition_id: opts.transitionId ?? null,
    idempotency_key: opts.idempotencyKey ?? null,
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    actor: "cli",
    prev_snapshot_digest: opts.prevSnapshotDigest ?? null,
    input_refs: [],
    output_refs: [],
    payload,
  };
  return {
    event_id: `EVT-v0.1.37-${seq}`,
    ...base,
    event_digest: digestOf(base),
  };
}

function setupV0137Fixture(state: CompatState): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-v0137-"));
  const change = "compat-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });

  const pendingTasks = state === "apply";
  writeFileSync(join(changeRoot, "proposal.md"), "# Proposal\n\nv0.1.37 fixture.\n");
  writeFileSync(join(changeRoot, "design.md"), "# Design\n");
  writeFileSync(join(changeRoot, "tasks.md"), pendingTasks
    ? "# Tasks\n\n- [ ] TASK-001 Continue implementation\n"
    : "# Tasks\n\n- [x] TASK-001 Completed\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "discovery.md"), "# Discovery\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "business-invariants.md"), "# Business Invariants\n");
  writeFileSync(join(changeRoot, ".superspec", "artifacts", "test-contract.md"), "# Test Contract\n");

  ensureChangeLayout(projectRoot, change);

  const transitions: { transition: string; from: State; to: State; payload?: Record<string, unknown> }[] = [
    { transition: "init", from: "init", to: "init" },
    { transition: "explore", from: "init", to: "explore" },
  ];
  if (["propose", "propose_ready", "apply", "apply_done", "review", "accepted"].includes(state)) {
    transitions.push({ transition: "explore", from: "explore", to: "propose" });
  }
  if (["propose_ready", "apply", "apply_done", "review", "accepted"].includes(state)) {
    transitions.push({ transition: "propose-ready", from: "propose", to: "propose_ready" });
  }
  if (["apply", "apply_done", "review", "accepted"].includes(state)) {
    transitions.push({ transition: "start-apply", from: "propose_ready", to: "apply" });
  }
  if (["apply_done", "review", "accepted"].includes(state)) {
    transitions.push({
      transition: "review-ready",
      from: "apply",
      to: "apply_done",
      payload: { review_policy: { review_risk: "minimal", requires_verifier: false } },
    });
  }
  if (["review", "accepted"].includes(state)) {
    transitions.push({
      transition: "review-ready",
      from: "apply_done",
      to: "review",
      payload: { code_review_gate: { decision: "skipped", reason: "no_code_changes" } },
    });
  }
  if (state === "accepted") {
    transitions.push({ transition: "accept", from: "review", to: "accepted" });
  }

  for (const item of transitions) {
    appendEvent(projectRoot, change, v0137Event(change, "transition_commit", {
      transition: item.transition,
      from_state: item.from,
      to_state: item.to,
      outcome: "advanced",
      created_job_ids: [],
      reason: `v0.1.37 ${item.transition}`,
      ...(item.payload ?? {}),
    }, { transitionId: `T-${item.transition}-${item.to}`, idempotencyKey: `v0137-${item.transition}-${item.to}` }));
  }

  return {
    projectRoot,
    change,
    changeRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function setupV0137StaticEventsFixture(eventsFixture: string): Fixture {
  const fx = setupV0137Fixture("explore");
  writeFileSync(join(fx.changeRoot, "tasks.md"), "# Tasks\n\n- [x] TASK-001 Completed\n");
  writeFileSync(eventsFile(fx.projectRoot, fx.change), readFileSync(eventsFixture, "utf8"));
  return fx;
}

function appendV0137Job(projectRoot: string, change: string, state: State, job: Job): void {
  appendEvent(projectRoot, change, v0137Event(change, "transition_commit", {
    transition: job.created_from_transition,
    from_state: state,
    to_state: state,
    outcome: "job_created",
    created_job_ids: [job.job_id],
    new_jobs: [job],
    reason: "v0.1.37 legacy job",
  }, { transitionId: `T-${job.job_id}`, idempotencyKey: `v0137-${job.job_id}` }));
}

test("v0.1.37 half-finished changes replay and next remains executable", () => {
  const cases: { state: CompatState; expectedPath: string; commandPattern?: RegExp; askScope?: string }[] = [
    { state: "explore", expectedPath: "next_command", commandPattern: /transition explore --change "compat-change"$/ },
    { state: "propose", expectedPath: "next_command", commandPattern: /transition propose-ready --change "compat-change"$/ },
    { state: "propose_ready", expectedPath: "next_command", commandPattern: /transition start-apply --change "compat-change"$/ },
    { state: "apply", expectedPath: "next_command", commandPattern: /transition task-start --change "compat-change" --task TASK-001$/ },
    { state: "apply_done", expectedPath: "next_command", commandPattern: /transition review-ready --change "compat-change"$/ },
    { state: "review", expectedPath: "next_command", commandPattern: /transition review-ready --change "compat-change"$/ },
    { state: "accepted", expectedPath: "ask_user", askScope: "archive_confirmation" },
  ];

  for (const item of cases) {
    const fx = setupV0137Fixture(item.state);
    try {
      const snapshot = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
      assert.equal(snapshot.state, item.state);

      const result = next(fx.projectRoot, fx.change, fx.changeRoot);
      assert.equal(result.path, item.expectedPath, item.state);
      if (result.path === "next_command") {
        assert.match(result.next_command, item.commandPattern ?? /./);
        assert.doesNotMatch(result.next_command, /--risk strict/);
      } else if (result.path === "ask_user") {
        assert.equal(result.ask_user.scope, item.askScope);
        assert.match(result.ask_user.question, /superspec transition archive --change "compat-change"/);
      }
    } finally {
      fx.cleanup();
    }
  }
});

test("v0.1.37 code-reviewer job without packet_context cannot satisfy new passed gate", () => {
  const fixturePath = new URL("./fixtures/v0.1.37/apply_done-code-reviewer.events.jsonl", import.meta.url).pathname;
  const fx = setupV0137StaticEventsFixture(fixturePath);
  try {
    const jobId = "JOB-v0137-code-reviewer";
    const snapWithJob = rebuildSnapshot(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(snapWithJob.state, "apply_done");
    const replayedJob = snapWithJob.open_jobs.find(item => item.job_id === jobId);
    assert.ok(replayedJob);
    assert.equal(replayedJob.gate_id, undefined);

    const nextBeforeSubmit = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(nextBeforeSubmit.path, "required_job");
    assert.equal(nextBeforeSubmit.required_jobs[0].job_id, jobId);

    const packet = jobsPacket(fx.projectRoot, fx.change, jobId);
    assert.equal(packet.found, true);
    assert.equal(packet.packet?.gate_id, undefined);
    const reportPath = join(fx.projectRoot, "v0137-code-reviewer-pass.json");
    writeFileSync(reportPath, JSON.stringify({
      role: "code-reviewer",
      verdict: "pass",
      review_scope: {
        job_id: jobId,
        packet_digest: "sha256:v0137-code-reviewer",
        checked_paths: [],
        checked_docs: ["proposal.md", "design.md", "tasks.md", ".superspec/artifacts/test-contract.md"],
        unchecked: [],
      },
      findings: [],
      reviewer: { kind: "codex-subagent", id: "v0137-compat-reviewer" },
    }));
    const submitted = recordJobSubmit(fx.projectRoot, fx.change, fx.changeRoot, jobId, reportPath);
    assert.equal(submitted.accepted, true);

    const result = reviewReady(fx.projectRoot, fx.change, fx.changeRoot, "minimal");
    assert.equal(result.outcome, "job_created");
    assert.equal(result.from_state, "apply_done");
    assert.equal(result.to_state, "apply_done");
    assert.equal(result.created_jobs.length, 1);
    assert.notEqual(result.created_jobs[0], jobId);

    const commit = readEvents(fx.projectRoot, fx.change).findLast(event =>
      event.event_type === "transition_commit" &&
      (event.payload as { outcome?: unknown; created_job_ids?: unknown }).outcome === "job_created"
    );
    const newJobs = (commit?.payload as { new_jobs?: Job[] }).new_jobs ?? [];
    assert.equal(newJobs[0]?.role, "code-reviewer");
    assert.ok(newJobs[0]?.packet_context?.code_review_scope);
  } finally {
    fx.cleanup();
  }
});

test("v0.1.37 final verifier with evidence can satisfy accept, without evidence is rejected", () => {
  const withoutEvidence = setupV0137Fixture("review");
  try {
    const legacyWithoutEvidence: Job = {
      job_id: "JOB-v0137-verifier-no-evidence",
      role: "verifier",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:v0137-verifier-no-evidence",
      created_from_transition: "review-ready",
      created_at: "2026-01-01T00:10:00.000Z",
    };
    appendV0137Job(withoutEvidence.projectRoot, withoutEvidence.change, "review", legacyWithoutEvidence);

    const reportPath = join(withoutEvidence.projectRoot, "v0137-verifier-no-evidence.json");
    writeFileSync(reportPath, JSON.stringify({ role: "verifier", findings: [], verdict: "pass" }));
    const submitted = recordJobSubmit(
      withoutEvidence.projectRoot,
      withoutEvidence.change,
      withoutEvidence.changeRoot,
      legacyWithoutEvidence.job_id,
      reportPath,
    );
    assert.equal(submitted.accepted, false);
    assert.match(submitted.message, /缺少执行证据版本/);

    const created = reviewReady(withoutEvidence.projectRoot, withoutEvidence.change, withoutEvidence.changeRoot, "minimal");
    assert.equal(created.outcome, "job_created");
    assert.notEqual(created.created_jobs[0], legacyWithoutEvidence.job_id);
  } finally {
    withoutEvidence.cleanup();
  }

  const withEvidence = setupV0137Fixture("review");
  try {
    const events = readEvents(withEvidence.projectRoot, withEvidence.change);
    const legacyWithEvidence: Job = {
      job_id: "JOB-v0137-verifier-with-evidence",
      role: "verifier",
      state: "requested",
      boundFiles: [],
      review_evidence_digest: reviewEvidenceDigest(events),
      packet_digest: "sha256:v0137-verifier-with-evidence",
      created_from_transition: "review-ready",
      created_at: "2026-01-01T00:20:00.000Z",
    };
    appendV0137Job(withEvidence.projectRoot, withEvidence.change, "review", legacyWithEvidence);
    appendEvent(withEvidence.projectRoot, withEvidence.change, v0137Event(withEvidence.change, "job_accepted", {
      job_id: legacyWithEvidence.job_id,
      role: legacyWithEvidence.role,
      report_digest: "sha256:v0137-verifier-report",
      accepted_at: "2026-01-01T00:21:00.000Z",
    }));

    const result = next(withEvidence.projectRoot, withEvidence.change, withEvidence.changeRoot, "minimal");
    assert.equal(result.path, "next_command");
    assert.equal(result.next_command, 'superspec transition accept --change "compat-change"');
  } finally {
    withEvidence.cleanup();
  }
});
