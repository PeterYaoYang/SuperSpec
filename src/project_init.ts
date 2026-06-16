import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  REQUIRED_SUPERSPEC_AGENT_ROLES,
  type JsonMap,
  type OpenspecCliProbe,
  REQUIRED_OPENSPEC_MIN_VERSION,
  block,
  commandExists,
  openspec_cli_probe,
  reason,
  read_agent_toml_name,
} from "./core.ts";
import { install_workflow, type EngineAction } from "./install_engine.ts";

export const OPENSPEC_NPM_PACKAGE = "@fission-ai/openspec";
export const OPENSPEC_INSTALL_DOC_URL = "https://github.com/Fission-AI/OpenSpec#readme";

export type OpenspecInstallPlan = {
  manager: "npm" | "pnpm" | "yarn" | "bun";
  cmd: string;
  args: string[];
  rendered: string;
};

type Action = {
  action: string;
  status: "ok" | "created" | "updated" | "skipped" | "failed";
  refs?: string[];
  detail?: string;
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  architect: "系统设计、边界、接口与长期取舍",
  critic: "严格审查计划、证据、假设与范围漂移",
  "test-engineer": "测试策略、覆盖率与 RED/GREEN 证据审查",
  "code-reviewer": "代码 / 规格 / 安全审查",
  verifier: "最终完成证据与验证审查",
};

function renderCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

export function recommended_openspec_install_plan(
  opts: {
    cwd?: string;
    commandExistsFn?: (cmd: string, meta?: { cwd?: string }) => boolean;
  } = {},
): OpenspecInstallPlan | null {
  const commandExistsFn = opts.commandExistsFn ?? ((cmd: string, meta?: { cwd?: string }) => commandExists(cmd, { cwd: meta?.cwd }));
  const versionedPackage = `${OPENSPEC_NPM_PACKAGE}@latest`;
  const candidates: Array<Omit<OpenspecInstallPlan, "rendered">> = [
    { manager: "npm", cmd: "npm", args: ["install", "-g", versionedPackage] },
    { manager: "pnpm", cmd: "pnpm", args: ["add", "-g", versionedPackage] },
    { manager: "yarn", cmd: "yarn", args: ["global", "add", versionedPackage] },
    { manager: "bun", cmd: "bun", args: ["add", "-g", versionedPackage] },
  ];
  for (const candidate of candidates) {
    if (!commandExistsFn(candidate.cmd, { cwd: opts.cwd })) continue;
    return { ...candidate, rendered: renderCommand(candidate.cmd, candidate.args) };
  }
  return null;
}

export function forced_openspec_install_plan(plan: OpenspecInstallPlan): OpenspecInstallPlan {
  const versionedPackage = `${OPENSPEC_NPM_PACKAGE}@latest`;
  const forced: Record<OpenspecInstallPlan["manager"], string[]> = {
    npm: ["install", "-g", "--force", versionedPackage],
    pnpm: ["add", "-g", "--force", versionedPackage],
    yarn: ["global", "add", versionedPackage, "--force"],
    bun: ["add", "-g", "--force", versionedPackage],
  };
  return { ...plan, args: forced[plan.manager], rendered: renderCommand(plan.cmd, forced[plan.manager]) };
}

export function missing_openspec_cli_message(
  opts: {
    cwd?: string;
    commandExistsFn?: (cmd: string, meta?: { cwd?: string }) => boolean;
  } = {},
): string {
  return openspec_cli_requirement_message({
    ok: false,
    state: "missing",
    version: null,
    message: "PATH 中缺少 OpenSpec CLI（openspec）",
  }, opts);
}

export function openspec_cli_requirement_message(
  probe: OpenspecCliProbe,
  opts: {
    cwd?: string;
    commandExistsFn?: (cmd: string, meta?: { cwd?: string }) => boolean;
  } = {},
): string {
  const plan = recommended_openspec_install_plan(opts);
  if (plan) {
    return `${probe.message}。需要 @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION}。可先运行 \`${plan.rendered}\` 安装或升级，然后重新运行 \`superspec init --scope project\`。`;
  }
  return `${probe.message}。请先安装或升级 @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION}（${OPENSPEC_INSTALL_DOC_URL}），然后重新运行 \`superspec init --scope project\`。`;
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
      `你是仓库本地的 superspec ${name} native subagent。`,
      "遵循分配给你的 superspec gate 证据任务，引用具体文件，并把未通过的问题上报主流程。",
      "不要用主流程自审替代必须的角色证据。",
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
      `你是仓库本地的 superspec ${name} 角色。`,
      "",
      "请基于具体文件证据审查提供的 superspec gate 上下文，输出简洁的通过 / 未通过报告，引用 source anchors 与 target refs，并且不要用主流程自审替代必须的 native-subagent 证据。",
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function ensureOpenSpecCliSurface(repoRoot: string, actions: Action[]): string[] {
  const probe = openspec_cli_probe({ cwd: repoRoot });
  actions.push({
    action: "openspec_cli_surface",
    status: probe.ok ? "ok" : "failed",
    detail: probe.message,
  });
  return probe.ok ? [] : [openspec_cli_requirement_message(probe, { cwd: repoRoot })];
}

function ensureSuperSpecRoles(repoRoot: string, actions: Action[]): string[] {
  const problems: string[] = [];
  const created: string[] = [];
  for (const name of REQUIRED_SUPERSPEC_AGENT_ROLES) {
    const agentPath = join(repoRoot, ".codex", "agents", `${name}.toml`);
    if (!existsSync(agentPath) || !statSync(agentPath).isFile()) {
      created.push(writeSuperSpecAgent(repoRoot, name));
    } else if (read_agent_toml_name(agentPath) !== name) {
      problems.push(`agent 文件无效：${agentPath}`);
    }

    const promptPath = join(repoRoot, ".codex", "prompts", `${name}.md`);
    if (!existsSync(promptPath) || !statSync(promptPath).isFile()) {
      created.push(writeSuperSpecPrompt(repoRoot, name));
    } else if (!readFileSync(promptPath, "utf8").trim()) {
      problems.push(`prompt 文件为空：${promptPath}`);
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

const OPENSPEC_CONFIG_REL = "openspec/config.yaml";
const ZH_CTX = '所有文档必须使用中文编写。需求描述应使用"应当"或"必须"等词汇。';
export function ensure_openspec_chinese_context(repoRoot: string): EngineAction {
  const p = join(repoRoot, OPENSPEC_CONFIG_REL);
  if (existsSync(p) && statSync(p).isFile()) {
    const t = readFileSync(p, "utf8");
    if (/context:[\s\S]*?所有文档必须使用中文/u.test(t)) return { action: `configure ${OPENSPEC_CONFIG_REL}`, status: "ok", detail: "OpenSpec 中文语境已存在" };
    if (/^context:/mu.test(t)) {
      const u = t.replace(/^context:\s*[|>]?\s*\n(?:[ \t].*\n)*/mu, `context: |\n  ${ZH_CTX}\n`);
      mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, u, "utf8");
      return { action: `configure ${OPENSPEC_CONFIG_REL}`, status: "updated", detail: "OpenSpec context 已替换为简体中文语境" };
    }
    const s = t.endsWith("\n") ? "\ncontext: |\n" : "\n\ncontext: |\n";
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${t}${s}  ${ZH_CTX}\n`, "utf8");
    return { action: `configure ${OPENSPEC_CONFIG_REL}`, status: "updated", detail: "OpenSpec context 已追加简体中文语境" };
  }
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `context: |\n  ${ZH_CTX}\n`, "utf8");
  return { action: `configure ${OPENSPEC_CONFIG_REL}`, status: "created", detail: "OpenSpec 输出语言已设为简体中文" };
}

export function project_init(repoRootRaw = process.cwd(), opts: { force?: boolean } = {}): JsonMap {
  const repoRoot = resolve(repoRootRaw);
  const actions: Action[] = [];
  actions.push(ensure_openspec_chinese_context(repoRoot) as Action);
  const problems = [
    ...ensureOpenSpecCliSurface(repoRoot, actions),
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
