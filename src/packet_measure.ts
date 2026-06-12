import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedArgs } from "./cli_args.ts";
import { dispatch_packet } from "./packet_render.ts";
import {
  GuardError,
  REQUIRED_SUPERSPEC_AGENT_ROLES,
  REQUIRED_SUPERSPEC_WORKFLOW_SKILLS,
  runtime,
  type JsonMap,
} from "./util.ts";
import { file_blob_sha } from "./git.ts";

export type MeasuredTextFile = {
  path: string;
  chars: number;
};

export type SurfaceMeasure = {
  total_chars: number;
  files: MeasuredTextFile[];
};

export type RepresentativeScenarioMeasure = {
  name: string;
  description: string;
  total_chars: number;
  files: MeasuredTextFile[];
};

export type MaterializedTextSample = {
  name: string;
  description: string;
  chars: number;
  matched_markers?: string[];
};

export type MaterializedTextMeasure = {
  total_chars: number;
  samples: MaterializedTextSample[];
};

export type PacketMeasureReport = {
  fixed_surface_chars_install_upper_bound: SurfaceMeasure;
  fixed_surface_chars_runtime_required_subset: SurfaceMeasure;
  materialized_workflow_packet_chars: MaterializedTextMeasure;
  materialized_review_packet_chars: MaterializedTextMeasure;
  materialized_review_prompt_chars: MaterializedTextMeasure;
  ledger_block_chars: MaterializedTextMeasure;
  representative_loaded_surface_chars: {
    scenarios: RepresentativeScenarioMeasure[];
  };
};

type ScenarioSpec = {
  name: string;
  description: string;
  files: string[];
};

const REPRESENTATIVE_SCENARIOS: readonly ScenarioSpec[] = [
  {
    name: "explore_complete",
    description: "Post-bridge runtime surface for discovery authoring plus proposal-entry critic review.",
    files: [
      ".codex/skills/superspec-explore/SKILL.md",
      ".codex/prompts/critic.md",
      ".codex/agents/critic.toml",
    ],
  },
  {
    name: "proposal_reviewed",
    description: "Post-bridge runtime surface for proposal authoring and proposal critic review.",
    files: [
      ".codex/skills/superspec-propose/SKILL.md",
      ".codex/prompts/critic.md",
      ".codex/agents/critic.toml",
    ],
  },
  {
    name: "design_complete",
    description: "Post-bridge runtime surface for design authoring and the architect/critic/test-engineer review bundle.",
    files: [
      ".codex/skills/superspec-propose/SKILL.md",
      ".codex/prompts/architect.md",
      ".codex/prompts/critic.md",
      ".codex/prompts/test-engineer.md",
      ".codex/agents/architect.toml",
      ".codex/agents/critic.toml",
      ".codex/agents/test-engineer.toml",
    ],
  },
  {
    name: "test_contract_drafted",
    description: "Post-bridge runtime surface for test-contract authoring and its review lanes.",
    files: [
      ".codex/skills/superspec-propose/SKILL.md",
      ".codex/prompts/critic.md",
      ".codex/prompts/test-engineer.md",
      ".codex/agents/critic.toml",
      ".codex/agents/test-engineer.toml",
    ],
  },
  {
    name: "apply_ready",
    description: "Post-bridge runtime surface for apply orchestration before task execution.",
    files: [
      ".codex/skills/superspec-apply/SKILL.md",
    ],
  },
  {
    name: "review_complete_allow",
    description: "Post-bridge runtime surface for merged review + final verification on the allow path.",
    files: [
      ".codex/skills/superspec-review/SKILL.md",
      ".codex/prompts/code-reviewer.md",
      ".codex/prompts/architect.md",
      ".codex/prompts/critic.md",
      ".codex/prompts/verifier.md",
      ".codex/agents/code-reviewer.toml",
      ".codex/agents/architect.toml",
      ".codex/agents/critic.toml",
      ".codex/agents/verifier.toml",
    ],
  },
  {
    name: "archive_ready",
    description: "Post-bridge runtime surface for archive handoff after review passes.",
    files: [
      ".codex/skills/superspec-archive/SKILL.md",
    ],
  },
  {
    name: "round2_reviewer_prompt",
    description: "Post-bridge runtime surface for a round>1 reviewer lane.",
    files: [
      ".codex/prompts/critic.md",
      ".codex/agents/critic.toml",
    ],
  },
  {
    name: "request_changes_reopen_tasks",
    description: "Post-bridge runtime surface for a review round that routes back to apply via reopen_tasks.",
    files: [
      ".codex/skills/superspec-review/SKILL.md",
      ".codex/prompts/code-reviewer.md",
      ".codex/prompts/architect.md",
      ".codex/prompts/critic.md",
      ".codex/agents/code-reviewer.toml",
      ".codex/agents/architect.toml",
      ".codex/agents/critic.toml",
    ],
  },
  {
    name: "task_reopen_to_resolved",
    description: "Post-bridge runtime surface for reopened apply work from revert through successor completion.",
    files: [
      ".codex/skills/superspec-apply/SKILL.md",
    ],
  },
  {
    name: "scope_expansion",
    description: "Post-bridge runtime surface for apply-side user confirmation when task scope expands.",
    files: [
      ".codex/skills/superspec-apply/SKILL.md",
    ],
  },
] as const;

type MaterializedSampleSpec = {
  name: string;
  description: string;
  args: ParsedArgs;
  requiredMarkers?: string[];
};

const MATERIALIZED_WORKFLOW_PACKET_SAMPLES: readonly MaterializedSampleSpec[] = [
  {
    name: "apply_ready_blocked",
    description: "workflow-packet agent output for apply_ready before all required evidence is present.",
    args: { command: "workflow-packet", change: "demo-change", gate: "apply_ready", packet_format: "agent" },
  },
  {
    name: "task_complete_blocked",
    description: "workflow-packet agent output for a task-scoped apply completion packet.",
    args: { command: "workflow-packet", change: "demo-change", gate: "task_complete", task_id: "TASK-001", packet_format: "agent" },
  },
] as const;

const MATERIALIZED_REVIEW_PACKET_SAMPLES: readonly MaterializedSampleSpec[] = [
  {
    name: "proposal_reviewed_critic",
    description: "review-packet agent output for a disclosure reviewer lane.",
    args: { command: "review-packet", change: "demo-change", gate: "proposal_reviewed", role: "critic", round: 1, packet_format: "agent" },
  },
  {
    name: "review_complete_verifier",
    description: "review-packet agent output for the final verification lane.",
    args: { command: "review-packet", change: "demo-change", gate: "review_complete", role: "verifier", round: 1, packet_format: "agent" },
  },
] as const;

const MATERIALIZED_REVIEW_PROMPT_SAMPLES: readonly MaterializedSampleSpec[] = [
  {
    name: "proposal_reviewed_round2_critic",
    description: "review-packet prompt output for a round>1 disclosure reviewer lane with ledger injection.",
    args: { command: "review-packet", change: "demo-change", gate: "proposal_reviewed", role: "critic", round: 2, packet_format: "prompt" },
    requiredMarkers: ["[SUPERSPEC-FINDING-LEDGER gate=proposal_reviewed findings=1]", "PROP-SCOPE-001", "proposal silently widens scope beyond discovery"],
  },
  {
    name: "review_complete_critic_verification",
    description: "review-packet prompt output for the critic verification_review lane.",
    args: { command: "review-packet", change: "demo-change", gate: "review_complete", role: "critic", round: 1, evidence_kind: "verification_review", packet_format: "prompt" },
  },
] as const;

const LEDGER_BLOCK_SAMPLES: readonly MaterializedSampleSpec[] = [
  {
    name: "proposal_reviewed_round2_ledger",
    description: "ledger-render output used by round>1 reviewer prompts.",
    args: { command: "ledger-render", change: "demo-change", gate: "proposal_reviewed", round: 2 },
    requiredMarkers: ["[SUPERSPEC-FINDING-LEDGER gate=proposal_reviewed findings=1]", "PROP-SCOPE-001", "proposal silently widens scope beyond discovery"],
  },
] as const;

function ensureReadableTextFile(repoRoot: string, relPath: string): string {
  const absPath = join(repoRoot, relPath);
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    throw new GuardError(`packet_measure_missing_file: ${relPath}`);
  }
  return readFileSync(absPath, "utf8");
}

function dedupePaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort();
}

function measuredFiles(repoRoot: string, relPaths: Iterable<string>): MeasuredTextFile[] {
  return dedupePaths(relPaths).map((relPath) => ({
    path: relPath,
    chars: ensureReadableTextFile(repoRoot, relPath).length,
  }));
}

function measureSurface(repoRoot: string, relPaths: Iterable<string>): SurfaceMeasure {
  const files = measuredFiles(repoRoot, relPaths);
  return {
    total_chars: files.reduce((sum, item) => sum + item.chars, 0),
    files,
  };
}

function writeSyntheticText(repoRoot: string, relPath: string, text: string): void {
  const absPath = join(repoRoot, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, text, "utf8");
}

function syntheticRef(root: string, relPath: string): JsonMap {
  return {
    path: relPath,
    blob_sha: file_blob_sha(join(root, relPath)),
  };
}

function syntheticStatus(repoRoot: string, changeRoot: string): JsonMap {
  return {
    changeRoot,
    planningHome: { root: repoRoot },
    schemaName: "spec-driven",
    applyRequires: ["tasks"],
    artifacts: ["proposal", "specs", "design", "tasks"].map((id) => ({ id, status: "done", missingDeps: [] })),
  };
}

function materializeSyntheticEvidence(changeRoot: string, relPath: string, evidence: JsonMap): JsonMap {
  const absPath = join(changeRoot, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { ...evidence, _path: relPath };
}

function syntheticDisclosureEvidences(changeRoot: string): JsonMap[] {
  const promptRef = ".superspec/reports/proposal-r1-critic-prompt.md";
  const outputRef = ".superspec/reports/proposal-r1-critic.md";
  mkdirSync(dirname(join(changeRoot, promptRef)), { recursive: true });
  writeFileSync(join(changeRoot, promptRef), "critic prompt for proposal round 1\n", "utf8");
  writeFileSync(join(changeRoot, outputRef), "critic found a scope issue\n", "utf8");
  const finding = {
    finding_id: "PROP-SCOPE-001",
    finding_uid: "proposal_reviewed:EV-proposal-r1-critic:PROP-SCOPE-001",
    finding_type: "blocker",
    category: "scope",
    material_categories: ["scope"],
    decision_scope_key: "demo-change:proposal:hidden-scope",
    summary: "proposal silently widens scope beyond discovery",
  };
  const targetRefs = [
    syntheticRef(changeRoot, "proposal.md"),
    syntheticRef(changeRoot, ".superspec/artifacts/discovery.md"),
  ];
  const review = materializeSyntheticEvidence(changeRoot, ".superspec/evidence/reviews/EV-proposal-r1-critic.json", {
    schema_version: 1,
    evidence_id: "EV-proposal-r1-critic",
    change_id: "demo-change",
    gate: "proposal_reviewed",
    kind: "review",
    created_at: "2026-06-08T00:00:00Z",
    created_by: "measure",
    status: "pass",
    agent_role: "critic",
    execution_mode: "native_subagent",
    agent_id: "agent-critic",
    prompt_ref: promptRef,
    output_ref: outputRef,
    source_anchors: [],
    target_refs: targetRefs,
    review_round_id: "proposal_reviewed-r1",
    findings: [finding],
  });
  const digest = materializeSyntheticEvidence(changeRoot, ".superspec/evidence/reviews/EV-proposal-r1-digest.json", {
    schema_version: 1,
    evidence_id: "EV-proposal-r1-digest",
    change_id: "demo-change",
    gate: "proposal_reviewed",
    kind: "main_review_digest",
    created_at: "2026-06-08T00:01:00Z",
    created_by: "main-thread",
    status: "blocked",
    review_round_id: "proposal_reviewed-r1",
    target_refs: targetRefs,
    source_review_evidence_refs: ["EV-proposal-r1-critic"],
    previous_digest_refs: [],
    finding_dispositions: [{
      ...finding,
      origin_review_evidence_id: "EV-proposal-r1-critic",
      disposition: "needs_user_decision",
      rationale: "material scope finding requires user confirmation",
      route: "stay_same_gate_user_decision",
      route_reason: "material scope finding requires user confirmation",
    }],
  });
  return [review, digest];
}

function createMaterializedMeasureContext(): { repoRoot: string; changeRoot: string; status: JsonMap; evidences: JsonMap[]; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "superspec-packet-measure-"));
  const changeRoot = join(repoRoot, "openspec", "changes", "demo-change");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/.superspec/artifacts/discovery.md", "discovery facts\n");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/.superspec/artifacts/business-invariants.md", "## Business Invariants\n\n| id | description |\n| --- | --- |\n| INV-001 | Preserve behavior |\n");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/.superspec/artifacts/test-contract.md", "## Test Contract\n\n| test_id | invariant_refs |\n| --- | --- |\n| TEST-001 | INV-001 |\n");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/proposal.md", "proposal\n");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/design.md", "design\n");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/specs/demo/spec.md", "#### Scenario: Demo\n");
  writeSyntheticText(repoRoot, "openspec/changes/demo-change/tasks.md", "- [ ] TASK-001 Implement\n  - invariant_refs: INV-001\n  - test_refs: TEST-001\n");
  const evidences = syntheticDisclosureEvidences(changeRoot);
  return {
    repoRoot,
    changeRoot,
    status: syntheticStatus(repoRoot, changeRoot),
    evidences,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

function withMaterializedMeasureRuntime<T>(ctx: { repoRoot: string; changeRoot: string; status: JsonMap; evidences: JsonMap[] }, fn: () => T): T {
  const overrides: JsonMap = {
    load_context: () => [ctx.status, ctx.repoRoot, ctx.changeRoot, ctx.evidences],
    dirty_worktree_paths: () => [],
    file_blob_sha,
  };
  const previous = new Map<string, { had: boolean; value: unknown }>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, { had: Object.prototype.hasOwnProperty.call(runtime, key), value: runtime[key] });
    runtime[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, item] of previous) {
      if (item.had) runtime[key] = item.value;
      else delete runtime[key];
    }
  }
}

function packetOutputText(args: ParsedArgs): string {
  const result = dispatch_packet(args);
  if (result.output_format === "prompt") {
    const text = String(result.payload);
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return `${JSON.stringify(result.payload, null, 2)}\n`;
}

function measureMaterializedSamples(specs: readonly MaterializedSampleSpec[]): MaterializedTextMeasure {
  const ctx = createMaterializedMeasureContext();
  try {
    const samples = withMaterializedMeasureRuntime(ctx, () =>
      specs.map((spec) => {
        const text = packetOutputText(spec.args);
        const missingMarkers = (spec.requiredMarkers ?? []).filter((marker) => !text.includes(marker));
        if (missingMarkers.length > 0) {
          throw new GuardError(`packet_measure_missing_marker: ${spec.name}: ${missingMarkers.join(", ")}`);
        }
        return {
          name: spec.name,
          description: spec.description,
          chars: text.length,
          ...(spec.requiredMarkers && spec.requiredMarkers.length > 0 ? { matched_markers: [...spec.requiredMarkers] } : {}),
        };
      }),
    );
    return {
      total_chars: samples.reduce((sum, item) => sum + item.chars, 0),
      samples,
    };
  } finally {
    ctx.cleanup();
  }
}

function templateWorkflowSkillPaths(): string[] {
  return REQUIRED_SUPERSPEC_WORKFLOW_SKILLS.map((name) => `templates/workflow/skills/${name}/SKILL.md`);
}

function templatePromptPaths(): string[] {
  return REQUIRED_SUPERSPEC_AGENT_ROLES.map((name) => `templates/workflow/prompts/${name}.md`);
}

function adapterAgentPaths(): string[] {
  return REQUIRED_SUPERSPEC_AGENT_ROLES.map((name) => `adapters/codex/agents/${name}.toml`);
}

function repoLocalSkillPaths(repoRoot: string): string[] {
  return REQUIRED_SUPERSPEC_WORKFLOW_SKILLS
    .map((name) => join(".codex", "skills", name, "SKILL.md"))
    .filter((relPath) => existsSync(join(repoRoot, relPath)));
}

function runtimeBridgeSkillPaths(): string[] {
  return [];
}

export function representative_scenarios(): readonly ScenarioSpec[] {
  return REPRESENTATIVE_SCENARIOS;
}

export function measure_packet_surface_report(repoRoot: string): PacketMeasureReport {
  const fixedSurfaceInstallUpperBound = measureSurface(repoRoot, [
    ...templateWorkflowSkillPaths(),
    ...templatePromptPaths(),
    ...adapterAgentPaths(),
    ...repoLocalSkillPaths(repoRoot),
  ]);
  const fixedSurfaceRuntimeRequiredSubset = measureSurface(repoRoot, [
    ...templateWorkflowSkillPaths(),
    ...templatePromptPaths(),
    ...adapterAgentPaths(),
    ...runtimeBridgeSkillPaths(),
  ]);
  const scenarios = REPRESENTATIVE_SCENARIOS.map((scenario) => ({
    name: scenario.name,
    description: scenario.description,
    ...measureSurface(repoRoot, scenario.files),
  }));
  return {
    fixed_surface_chars_install_upper_bound: fixedSurfaceInstallUpperBound,
    fixed_surface_chars_runtime_required_subset: fixedSurfaceRuntimeRequiredSubset,
    materialized_workflow_packet_chars: measureMaterializedSamples(MATERIALIZED_WORKFLOW_PACKET_SAMPLES),
    materialized_review_packet_chars: measureMaterializedSamples(MATERIALIZED_REVIEW_PACKET_SAMPLES),
    materialized_review_prompt_chars: measureMaterializedSamples(MATERIALIZED_REVIEW_PROMPT_SAMPLES),
    ledger_block_chars: measureMaterializedSamples(LEDGER_BLOCK_SAMPLES),
    representative_loaded_surface_chars: {
      scenarios,
    },
  };
}
