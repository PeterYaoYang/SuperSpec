import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  measure_packet_surface_report,
} from "../src/packet_measure.ts";

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "templates")) && existsSync(join(dir, ".codex"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

const REPO = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_INSTALL_UPPER_BOUND_TOTAL = 30009;
const EXPECTED_RUNTIME_REQUIRED_SUBSET_TOTAL = 30009;
const EXPECTED_INSTALL_UPPER_BOUND_PATHS = [
  "adapters/codex/agents/architect.toml",
  "adapters/codex/agents/code-reviewer.toml",
  "adapters/codex/agents/critic.toml",
  "adapters/codex/agents/executor.toml",
  "adapters/codex/agents/test-engineer.toml",
  "adapters/codex/agents/test-runner.toml",
  "adapters/codex/agents/verifier.toml",
  "templates/workflow/prompts/architect.md",
  "templates/workflow/prompts/code-reviewer.md",
  "templates/workflow/prompts/critic.md",
  "templates/workflow/prompts/executor.md",
  "templates/workflow/prompts/test-engineer.md",
  "templates/workflow/prompts/test-runner.md",
  "templates/workflow/prompts/verifier.md",
  "templates/workflow/skills/superspec-apply/SKILL.md",
  "templates/workflow/skills/superspec-archive/SKILL.md",
  "templates/workflow/skills/superspec-explore/SKILL.md",
  "templates/workflow/skills/superspec-propose/SKILL.md",
  "templates/workflow/skills/superspec-review/SKILL.md",
];
const EXPECTED_RUNTIME_REQUIRED_SUBSET_PATHS = [
  "adapters/codex/agents/architect.toml",
  "adapters/codex/agents/code-reviewer.toml",
  "adapters/codex/agents/critic.toml",
  "adapters/codex/agents/executor.toml",
  "adapters/codex/agents/test-engineer.toml",
  "adapters/codex/agents/test-runner.toml",
  "adapters/codex/agents/verifier.toml",
  "templates/workflow/prompts/architect.md",
  "templates/workflow/prompts/code-reviewer.md",
  "templates/workflow/prompts/critic.md",
  "templates/workflow/prompts/executor.md",
  "templates/workflow/prompts/test-engineer.md",
  "templates/workflow/prompts/test-runner.md",
  "templates/workflow/prompts/verifier.md",
  "templates/workflow/skills/superspec-apply/SKILL.md",
  "templates/workflow/skills/superspec-archive/SKILL.md",
  "templates/workflow/skills/superspec-explore/SKILL.md",
  "templates/workflow/skills/superspec-propose/SKILL.md",
  "templates/workflow/skills/superspec-review/SKILL.md",
];
const EXPECTED_SCENARIO_PATHS: Record<string, string[]> = {
  explore_complete: [
    ".codex/agents/critic.toml",
    ".codex/prompts/critic.md",
    ".codex/skills/superspec-explore/SKILL.md",
  ],
  proposal_reviewed: [
    ".codex/agents/critic.toml",
    ".codex/prompts/critic.md",
    ".codex/skills/superspec-propose/SKILL.md",
  ],
  design_complete: [
    ".codex/agents/architect.toml",
    ".codex/agents/critic.toml",
    ".codex/agents/test-engineer.toml",
    ".codex/prompts/architect.md",
    ".codex/prompts/critic.md",
    ".codex/prompts/test-engineer.md",
    ".codex/skills/superspec-propose/SKILL.md",
  ],
  test_contract_drafted: [
    ".codex/agents/critic.toml",
    ".codex/agents/test-engineer.toml",
    ".codex/prompts/critic.md",
    ".codex/prompts/test-engineer.md",
    ".codex/skills/superspec-propose/SKILL.md",
  ],
  apply_ready: [
    ".codex/agents/executor.toml",
    ".codex/prompts/executor.md",
    ".codex/skills/superspec-apply/SKILL.md",
  ],
  review_complete_allow: [
    ".codex/agents/architect.toml",
    ".codex/agents/code-reviewer.toml",
    ".codex/agents/critic.toml",
    ".codex/agents/verifier.toml",
    ".codex/prompts/architect.md",
    ".codex/prompts/code-reviewer.md",
    ".codex/prompts/critic.md",
    ".codex/prompts/verifier.md",
    ".codex/skills/superspec-review/SKILL.md",
  ],
  archive_ready: [
    ".codex/skills/superspec-archive/SKILL.md",
  ],
  round2_reviewer_prompt: [
    ".codex/agents/critic.toml",
    ".codex/prompts/critic.md",
  ],
  request_changes_reopen_tasks: [
    ".codex/agents/architect.toml",
    ".codex/agents/code-reviewer.toml",
    ".codex/agents/critic.toml",
    ".codex/prompts/architect.md",
    ".codex/prompts/code-reviewer.md",
    ".codex/prompts/critic.md",
    ".codex/skills/superspec-review/SKILL.md",
  ],
  task_reopen_to_resolved: [
    ".codex/agents/executor.toml",
    ".codex/prompts/executor.md",
    ".codex/skills/superspec-apply/SKILL.md",
  ],
  scope_expansion: [
    ".codex/skills/superspec-apply/SKILL.md",
  ],
};
const EXPECTED_SCENARIO_TOTALS: Record<string, number> = {
  explore_complete: 3961,
  proposal_reviewed: 4589,
  design_complete: 7746,
  test_contract_drafted: 6235,
  apply_ready: 6821,
  review_complete_allow: 11520,
  archive_ready: 1753,
  round2_reviewer_prompt: 1641,
  request_changes_reopen_tasks: 8998,
  task_reopen_to_resolved: 6821,
  scope_expansion: 4376,
};
const EXPECTED_MATERIALIZED_WORKFLOW_PACKET_TOTALS: Record<string, number> = {
  apply_ready_blocked: 1259,
  task_complete_blocked: 1350,
};
const EXPECTED_MATERIALIZED_REVIEW_PACKET_TOTALS: Record<string, number> = {
  proposal_reviewed_critic: 1977,
  review_complete_verifier: 1935,
};
const EXPECTED_MATERIALIZED_REVIEW_PROMPT_TOTALS: Record<string, number> = {
  proposal_reviewed_round2_critic: 1305,
  review_complete_critic_verification: 1285,
};
const EXPECTED_LEDGER_BLOCK_TOTALS: Record<string, number> = {
  proposal_reviewed_round2_ledger: 281,
};
const EXPECTED_MATERIALIZED_MARKERS: Record<string, string[]> = {
  proposal_reviewed_round2_critic: [
    "[SUPERSPEC-FINDING-LEDGER gate=proposal_reviewed findings=1]",
    "PROP-SCOPE-001",
    "proposal silently widens scope beyond discovery",
  ],
  proposal_reviewed_round2_ledger: [
    "[SUPERSPEC-FINDING-LEDGER gate=proposal_reviewed findings=1]",
    "PROP-SCOPE-001",
    "proposal silently widens scope beyond discovery",
  ],
};

function chars(path: string): number {
  const absPath = join(REPO, path);
  if (existsSync(absPath)) return readFileSync(absPath, "utf8").length;
  const skillMatch = /^\.codex\/skills\/([^/]+)\/SKILL\.md$/u.exec(path);
  if (skillMatch) return readFileSync(join(REPO, "templates", "workflow", "skills", skillMatch[1], "SKILL.md"), "utf8").length;
  const promptMatch = /^\.codex\/prompts\/([^/]+)\.md$/u.exec(path);
  if (promptMatch) return readFileSync(join(REPO, "templates", "workflow", "prompts", `${promptMatch[1]}.md`), "utf8").length;
  const agentMatch = /^\.codex\/agents\/([^/]+)\.toml$/u.exec(path);
  if (agentMatch) return readFileSync(join(REPO, "adapters", "codex", "agents", `${agentMatch[1]}.toml`), "utf8").length;
  return readFileSync(absPath, "utf8").length;
}

function assertMaterializedMeasure(
  label: string,
  actual: { total_chars: number; samples: Array<{ name: string; description: string; chars: number; matched_markers?: string[] }> },
  expected: Record<string, number>,
): void {
  const names = actual.samples.map((item) => item.name);
  assert.deepEqual(Object.keys(expected).sort(), [...names].sort(), label);
  assert.equal(actual.total_chars, Object.values(expected).reduce((sum, value) => sum + value, 0), label);
  for (const sample of actual.samples) {
    assert.ok(sample.description.length > 0, `${label}:${sample.name}`);
    assert.equal(sample.chars, expected[sample.name], `${label}:${sample.name}`);
    assert.deepEqual(sample.matched_markers ?? [], EXPECTED_MATERIALIZED_MARKERS[sample.name] ?? [], `${label}:${sample.name}:markers`);
  }
}

test("packet surface report measures fixed static upper bounds and runtime subset", () => {
  const report = measure_packet_surface_report(REPO);
  const installPaths = report.fixed_surface_chars_install_upper_bound.files.map((item) => item.path);
  const runtimePaths = report.fixed_surface_chars_runtime_required_subset.files.map((item) => item.path);
  assert.deepEqual(installPaths, EXPECTED_INSTALL_UPPER_BOUND_PATHS);
  assert.deepEqual(runtimePaths, EXPECTED_RUNTIME_REQUIRED_SUBSET_PATHS);
  assert.equal(report.fixed_surface_chars_install_upper_bound.total_chars, EXPECTED_INSTALL_UPPER_BOUND_TOTAL);
  assert.equal(report.fixed_surface_chars_runtime_required_subset.total_chars, EXPECTED_RUNTIME_REQUIRED_SUBSET_TOTAL);
  assert.ok(report.fixed_surface_chars_install_upper_bound.total_chars >= report.fixed_surface_chars_runtime_required_subset.total_chars);

  const installSum = report.fixed_surface_chars_install_upper_bound.files.reduce((sum, item) => sum + chars(item.path), 0);
  const runtimeSum = report.fixed_surface_chars_runtime_required_subset.files.reduce((sum, item) => sum + chars(item.path), 0);
  assert.equal(report.fixed_surface_chars_install_upper_bound.total_chars, installSum);
  assert.equal(report.fixed_surface_chars_runtime_required_subset.total_chars, runtimeSum);
});

test("packet surface report includes all representative workflow scenarios from the design baseline", () => {
  const report = measure_packet_surface_report(REPO);
  const scenarios = report.representative_loaded_surface_chars.scenarios;
  const names = scenarios.map((item) => item.name);
  assert.deepEqual(Object.keys(EXPECTED_SCENARIO_PATHS).sort(), [...names].sort());
  assert.deepEqual(Object.keys(EXPECTED_SCENARIO_TOTALS).sort(), [...names].sort());

  for (const scenario of scenarios) {
    assert.ok(scenario.description.length > 0, scenario.name);
    assert.ok(scenario.files.length > 0, scenario.name);
    assert.deepEqual(
      scenario.files.map((item) => item.path),
      EXPECTED_SCENARIO_PATHS[scenario.name],
      scenario.name,
    );
    assert.equal(scenario.total_chars, EXPECTED_SCENARIO_TOTALS[scenario.name], scenario.name);
    const measured = scenario.files.reduce((sum, item) => sum + chars(item.path), 0);
    assert.equal(scenario.total_chars, measured, scenario.name);
  }
});

test("packet surface report locks materialized packet, prompt, and ledger budgets", () => {
  const report = measure_packet_surface_report(REPO);
  assertMaterializedMeasure("workflow packets", report.materialized_workflow_packet_chars, EXPECTED_MATERIALIZED_WORKFLOW_PACKET_TOTALS);
  assertMaterializedMeasure("review packets", report.materialized_review_packet_chars, EXPECTED_MATERIALIZED_REVIEW_PACKET_TOTALS);
  assertMaterializedMeasure("review prompts", report.materialized_review_prompt_chars, EXPECTED_MATERIALIZED_REVIEW_PROMPT_TOTALS);
  assertMaterializedMeasure("ledger blocks", report.ledger_block_chars, EXPECTED_LEDGER_BLOCK_TOTALS);
  assert.ok(report.materialized_review_prompt_chars.total_chars > report.ledger_block_chars.total_chars);
  assert.ok(report.ledger_block_chars.total_chars > 0);
});
