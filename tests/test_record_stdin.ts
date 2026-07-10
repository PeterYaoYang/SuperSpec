import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendEvent, ensureChangeLayout, makeEvent, rawFile, readEvents } from "../src/store.ts";
import { tasksStructureDigestOf } from "../src/task.ts";

function cliPath(): string {
  return new URL("../src/cli.ts", import.meta.url).pathname;
}

function setupProject(prefix = "superspec-stdin-"): { projectRoot: string; change: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  const change = "test-change";
  ensureChangeLayout(projectRoot, change);
  return {
    projectRoot,
    change,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function runCli(projectRoot: string, args: string[], input: string) {
  return spawnSync(process.execPath, [cliPath(), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    input,
  });
}

function stagingFiles(projectRoot: string, change: string): string[] {
  return readdirSync(join(projectRoot, ".superspec", "changes", change, "staging"));
}

test("CLI help documents stdin record input marker", () => {
  const fx = setupProject();
  try {
    const run = runCli(fx.projectRoot, ["--help"], "");
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /job-submit --job <J> --report <F\|->/);
    assert.match(run.stdout, /user-decision --input <F\|->/);
    assert.match(run.stdout, /test-run --input <F\|->/);
    assert.match(run.stdout, /reopen --to propose --reason <TEXT> \[--review-finding <JOB#FINDING>\]/);
    assert.doesNotMatch(run.stdout, /review-ready \/ accept \/ archive/);
  } finally {
    fx.cleanup();
  }
});

test("CLI record user-decision reads JSON from stdin", () => {
  const fx = setupProject();
  try {
    const input = JSON.stringify({
      scope: "propose_open_questions",
      question: "是否继续？",
      answer: "yes",
    });
    const run = runCli(fx.projectRoot, ["record", "user-decision", "--change", fx.change, "--input", "-"], input);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const result = JSON.parse(run.stdout);
    assert.equal(result.accepted, true);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);

    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "user-decisions"), "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    assert.deepEqual(JSON.parse(rawLines[0]), {
      scope: "propose_open_questions",
      question: "是否继续？",
      answer: "yes",
    });
    assert.equal(readEvents(fx.projectRoot, fx.change).some(ev => ev.event_type === "user_decision_recorded"), true);
  } finally {
    fx.cleanup();
  }
});

test("CLI record stdin cleans staging after rejected JSON", () => {
  const fx = setupProject();
  try {
    const run = runCli(fx.projectRoot, ["record", "user-decision", "--change", fx.change, "--input", "-"], "{ not json\n");
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.accepted, false);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("CLI record job-submit reads report JSON from stdin", () => {
  const fx = setupProject();
  try {
    const job = {
      job_id: "JOB-stdin-critic",
      role: "critic",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:packet",
      created_from_transition: "explore",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "explore",
      from_state: "explore",
      to_state: "explore",
      outcome: "job_created",
      created_job_ids: [job.job_id],
      new_jobs: [job],
      reason: "stdin test",
    }, { transitionId: "T-stdin-job", idempotencyKey: "stdin-job-key" }));

    const input = JSON.stringify({
      role: "critic",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "critic-stdin-test" },
    });
    const run = runCli(fx.projectRoot, ["record", "job-submit", "--change", fx.change, "--job", job.job_id, "--report", "-"], input);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const result = JSON.parse(run.stdout);
    assert.equal(result.accepted, true);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);

    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "review-reports"), "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    assert.equal(JSON.parse(rawLines[0]).role, "critic");
    assert.equal(readEvents(fx.projectRoot, fx.change).some(ev => ev.event_type === "job_accepted"), true);
  } finally {
    fx.cleanup();
  }
});

test("CLI record stdin keeps user and job idempotency", () => {
  const fx = setupProject();
  try {
    const job = {
      job_id: "JOB-stdin-idempotent",
      role: "critic",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:packet",
      created_from_transition: "explore",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "explore",
      from_state: "explore",
      to_state: "explore",
      outcome: "job_created",
      created_job_ids: [job.job_id],
      new_jobs: [job],
      reason: "stdin idempotency test",
    }, { transitionId: "T-stdin-idem", idempotencyKey: "stdin-idem-key" }));

    const decisionInput = JSON.stringify({
      scope: "propose_open_questions",
      question: "是否继续？",
      answer: "yes",
    });
    const reportInput = JSON.stringify({
      role: "critic",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "critic-stdin-idem-test" },
    });

    assert.equal(runCli(fx.projectRoot, ["record", "user-decision", "--change", fx.change, "--input", "-"], decisionInput).status, 0);
    const decisionAgain = runCli(fx.projectRoot, ["record", "user-decision", "--change", fx.change, "--input", "-"], decisionInput);
    assert.equal(decisionAgain.status, 0, decisionAgain.stderr || decisionAgain.stdout);
    assert.match(JSON.parse(decisionAgain.stdout).message, /幂等/);
    assert.equal(readFileSync(rawFile(fx.projectRoot, fx.change, "user-decisions"), "utf8").trim().split("\n").length, 1);

    assert.equal(runCli(fx.projectRoot, ["record", "job-submit", "--change", fx.change, "--job", job.job_id, "--report", "-"], reportInput).status, 0);
    const reportAgain = runCli(fx.projectRoot, ["record", "job-submit", "--change", fx.change, "--job", job.job_id, "--report", "-"], reportInput);
    assert.equal(reportAgain.status, 0, reportAgain.stderr || reportAgain.stdout);
    assert.match(JSON.parse(reportAgain.stdout).message, /幂等/);
    assert.equal(readFileSync(rawFile(fx.projectRoot, fx.change, "review-reports"), "utf8").trim().split("\n").length, 1);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("CLI record test-run reads JSON from stdin", () => {
  const fx = setupProject();
  try {
    const changeRoot = join(fx.projectRoot, "openspec", "changes", fx.change);
    mkdirSync(changeRoot, { recursive: true });
    writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do it\n");
    const digest = tasksStructureDigestOf(changeRoot);

    const input = JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: digest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    });
    const run = runCli(fx.projectRoot, ["record", "test-run", "--change", fx.change, "--input", "-"], input);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const result = JSON.parse(run.stdout);
    assert.equal(result.accepted, true);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);

    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "test-runs"), "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    const raw = JSON.parse(rawLines[0]);
    assert.equal(raw.semantic_status, "expected_success");
    assert.equal("covers_task_ids" in raw, false);
    assert.equal(readEvents(fx.projectRoot, fx.change).some(ev => ev.event_type === "test_run_recorded"), true);
  } finally {
    fx.cleanup();
  }
});

test("CLI record test-run reads covers_task_ids from stdin", () => {
  const fx = setupProject();
  try {
    const changeRoot = join(fx.projectRoot, "openspec", "changes", fx.change);
    mkdirSync(changeRoot, { recursive: true });
    writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do it\n- [ ] TASK-002 Do more\n");
    const digest = tasksStructureDigestOf(changeRoot);

    const input = JSON.stringify({
      test_id: "REGRESSION-001",
      task_structure_digest: digest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
      covers_task_ids: ["TASK-002", " TASK-001 ", "TASK-002"],
    });
    const run = runCli(fx.projectRoot, ["record", "test-run", "--change", fx.change, "--input", "-"], input);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const rawLines = readFileSync(rawFile(fx.projectRoot, fx.change, "test-runs"), "utf8").trim().split("\n");
    assert.equal(rawLines.length, 1);
    assert.deepEqual(JSON.parse(rawLines[0]).covers_task_ids, ["TASK-001", "TASK-002"]);
  } finally {
    fx.cleanup();
  }
});

test("CLI record test-run stdin keeps repeated evidence entries", () => {
  const fx = setupProject();
  try {
    const changeRoot = join(fx.projectRoot, "openspec", "changes", fx.change);
    mkdirSync(changeRoot, { recursive: true });
    writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do it\n");
    const digest = tasksStructureDigestOf(changeRoot);

    const input = JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: digest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    });

    assert.equal(runCli(fx.projectRoot, ["record", "test-run", "--change", fx.change, "--input", "-"], input).status, 0);
    assert.equal(runCli(fx.projectRoot, ["record", "test-run", "--change", fx.change, "--input", "-"], input).status, 0);
    assert.equal(readFileSync(rawFile(fx.projectRoot, fx.change, "test-runs"), "utf8").trim().split("\n").length, 2);
    assert.equal(readEvents(fx.projectRoot, fx.change).filter(ev => ev.event_type === "test_run_recorded").length, 2);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("CLI record keeps file path fallback for all stdin-enabled records", () => {
  const fx = setupProject();
  try {
    const changeRoot = join(fx.projectRoot, "openspec", "changes", fx.change);
    mkdirSync(changeRoot, { recursive: true });
    writeFileSync(join(changeRoot, "tasks.md"), "# Tasks\n\n- [ ] TASK-001 Do it\n");
    const digest = tasksStructureDigestOf(changeRoot);

    const job = {
      job_id: "JOB-file-critic",
      role: "critic",
      state: "requested",
      boundFiles: [],
      packet_digest: "sha256:packet",
      created_from_transition: "explore",
      created_at: new Date().toISOString(),
    };
    appendEvent(fx.projectRoot, fx.change, makeEvent(fx.change, "transition_commit", {
      transition: "explore",
      from_state: "explore",
      to_state: "explore",
      outcome: "job_created",
      created_job_ids: [job.job_id],
      new_jobs: [job],
      reason: "file fallback test",
    }, { transitionId: "T-file-job", idempotencyKey: "file-job-key" }));

    const decisionFile = join(fx.projectRoot, "decision.json");
    const reportFile = join(fx.projectRoot, "report.json");
    const testRunFile = join(fx.projectRoot, "test-run.json");
    writeFileSync(decisionFile, JSON.stringify({
      scope: "propose_open_questions",
      question: "是否继续？",
      answer: "yes",
    }), "utf8");
    writeFileSync(reportFile, JSON.stringify({
      role: "critic",
      verdict: "pass",
      findings: [],
      reviewer: { kind: "codex-subagent", id: "critic-file-test" },
    }), "utf8");
    writeFileSync(testRunFile, JSON.stringify({
      test_id: "TEST-001",
      task_structure_digest: digest,
      command: "npm test",
      cwd: fx.projectRoot,
      exit_code: 0,
      semantic_status: "expected_success",
    }), "utf8");

    const decision = runCli(fx.projectRoot, ["record", "user-decision", "--change", fx.change, "--input", decisionFile], "");
    const report = runCli(fx.projectRoot, ["record", "job-submit", "--change", fx.change, "--job", job.job_id, "--report", reportFile], "");
    const testRun = runCli(fx.projectRoot, ["record", "test-run", "--change", fx.change, "--input", testRunFile], "");

    assert.equal(decision.status, 0, decision.stderr || decision.stdout);
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.equal(testRun.status, 0, testRun.stderr || testRun.stdout);
    assert.equal(stagingFiles(fx.projectRoot, fx.change).length, 0);
  } finally {
    fx.cleanup();
  }
});
