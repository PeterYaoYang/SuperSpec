import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  REQUIRED_SUPERSPEC_AGENT_ROLES,
  REQUIRED_OPENSPEC_CODEX_SKILLS,
  type JsonMap,
  block,
  reason,
  read_agent_toml_name,
  read_skill_frontmatter_name,
  commandExists,
  runCommand,
} from "./core.ts";
import { install_workflow } from "./install_engine.ts";

type Action = {
  action: string;
  status: "ok" | "created" | "updated" | "skipped" | "failed";
  refs?: string[];
  detail?: string;
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  architect: "System design, boundaries, interfaces, and long-horizon tradeoffs",
  critic: "Critical review of plans, evidence, assumptions, and scope drift",
  "test-engineer": "Test strategy, coverage, and RED/GREEN evidence review",
  "code-reviewer": "Code/spec/security review lane for the code-review workflow",
  verifier: "Final completion evidence and verification review",
};

function commandFailure(proc: { stdout: string; stderr: string; error?: Error }): string {
  return (proc.error?.message ?? (proc.stderr || proc.stdout)).trim();
}

function openspecSkillProblems(repoRoot: string): string[] {
  const skillsRoot = join(repoRoot, ".codex", "skills");
  const problems: string[] = [];
  for (const name of REQUIRED_OPENSPEC_CODEX_SKILLS) {
    const skillPath = join(skillsRoot, name, "SKILL.md");
    if (!existsSync(skillPath) || !statSync(skillPath).isFile()) {
      problems.push(name);
      continue;
    }
    if (read_skill_frontmatter_name(skillPath) !== name) problems.push(name);
  }
  return problems.sort();
}

function writeSuperSpecAgent(repoRoot: string, name: string): string {
  const filePath = join(repoRoot, ".codex", "agents", `${name}.toml`);
  mkdirSync(join(repoRoot, ".codex", "agents"), { recursive: true });
  writeFileSync(
    filePath,
    [
      `name = "${name}"`,
      `description = "${ROLE_DESCRIPTIONS[name] ?? `superspec ${name} role`}"`,
      'model_reasoning_effort = "high"',
      'developer_instructions = """',
      `You are the repo-local superspec ${name} native subagent.`,
      "Follow the assigned superspec gate evidence task, cite concrete files, and report blockers upward.",
      "Do not substitute main-thread self-review for required role evidence.",
      '"""',
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function writeSuperSpecPrompt(repoRoot: string, name: string): string {
  const filePath = join(repoRoot, ".codex", "prompts", `${name}.md`);
  mkdirSync(join(repoRoot, ".codex", "prompts"), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `description: "${ROLE_DESCRIPTIONS[name] ?? `superspec ${name} role`}"`,
      'argument-hint: "superspec gate evidence task"',
      "---",
      "",
      `You are the repo-local superspec ${name} role.`,
      "",
      "Review the provided superspec gate context with concrete file-backed evidence. Produce a concise pass/block report, cite source anchors and target refs, and do not replace required native-subagent evidence with main-thread self-review.",
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function ensureOpenSpecCodex(repoRoot: string, actions: Action[]): string[] {
  if (!commandExists("openspec", { cwd: repoRoot })) return ["openspec CLI is not available in PATH"];

  let problems = openspecSkillProblems(repoRoot);
  if (problems.length === 0) {
    actions.push({ action: "openspec_codex_skills", status: "ok" });
    return [];
  }

  const init = runCommand("openspec", ["init", "--tools", "codex", "."], { cwd: repoRoot, timeout: 60_000 });
  actions.push({
    action: "openspec init --tools codex .",
    status: init.status === 0 ? "updated" : "failed",
    refs: problems,
    detail: init.status === 0 ? undefined : (init.stderr || init.stdout).trim(),
  });
  if (init.error || init.status !== 0) return [`openspec init failed: ${commandFailure(init)}`];

  problems = openspecSkillProblems(repoRoot);
  if (problems.length === 0) return [];

  const update = runCommand("openspec", ["update", "--force", "."], { cwd: repoRoot, timeout: 60_000 });
  actions.push({
    action: "openspec update --force .",
    status: update.status === 0 ? "updated" : "failed",
    refs: problems,
    detail: update.status === 0 ? undefined : (update.stderr || update.stdout).trim(),
  });
  if (update.error || update.status !== 0) return [`openspec update failed: ${commandFailure(update)}`];

  problems = openspecSkillProblems(repoRoot);
  return problems.length === 0 ? [] : [`OpenSpec Codex skills remain missing/invalid: ${problems.join(", ")}`];
}

function ensureSuperSpecRoles(repoRoot: string, actions: Action[]): string[] {
  const problems: string[] = [];
  const created: string[] = [];
  for (const name of REQUIRED_SUPERSPEC_AGENT_ROLES) {
    const agentPath = join(repoRoot, ".codex", "agents", `${name}.toml`);
    if (!existsSync(agentPath) || !statSync(agentPath).isFile()) {
      created.push(writeSuperSpecAgent(repoRoot, name));
    } else if (read_agent_toml_name(agentPath) !== name) {
      problems.push(`invalid agent ${agentPath}`);
    }

    const promptPath = join(repoRoot, ".codex", "prompts", `${name}.md`);
    if (!existsSync(promptPath) || !statSync(promptPath).isFile()) {
      created.push(writeSuperSpecPrompt(repoRoot, name));
    } else if (!readFileSync(promptPath, "utf8").trim()) {
      problems.push(`empty prompt ${promptPath}`);
    }
  }
  actions.push({
    action: "superspec_repo_local_roles",
    status: problems.length > 0 ? "failed" : created.length > 0 ? "created" : "ok",
    refs: created.length > 0 ? created : undefined,
  });
  return problems;
}

// D4 (audit G-1): SuperSpec's own surfaces are installed manifest-driven from the install map;
// it runs before the role fallback generator so canonical templates win on fresh installs.
function ensureSuperSpecWorkflow(repoRoot: string, actions: Action[], force: boolean): string[] {
  const result = install_workflow(repoRoot, { force, scope: "project" });
  for (const item of result.actions) {
    actions.push({
      action: item.action,
      status: item.status === "removed" || item.status === "would_remove" ? "updated" : item.status,
      refs: item.refs,
      detail: item.detail,
    });
  }
  return result.problems;
}

export function project_init(repoRootRaw = process.cwd(), opts: { force?: boolean } = {}): JsonMap {
  const repoRoot = resolve(repoRootRaw);
  const actions: Action[] = [];
  const problems = [
    ...ensureOpenSpecCodex(repoRoot, actions),
    ...ensureSuperSpecWorkflow(repoRoot, actions, opts.force === true),
    ...ensureSuperSpecRoles(repoRoot, actions),
  ];

  if (problems.length > 0) {
    const decision = block("project", "project_init", problems.map((item) => reason("project_init_failed", item)));
    return {
      ...decision,
      project_root: repoRoot,
      actions,
      next_allowed_actions: ["fix project_init_failed reasons, then rerun superspec init --scope project"],
    };
  }

  return {
    allowed: true,
    decision: "allow",
    change_id: null,
    gate: "project_init",
    project_root: repoRoot,
    actions,
    block_reasons: [],
    next_allowed_actions: ["create/select a change during superspec-explore, then run change-scoped guard checks"],
    trust_warnings: ["project init installs project surfaces only; change sidecars are created lazily by later superspec phases"],
  };
}
