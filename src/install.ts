import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKFLOW_SKILLS = [
  "superspec-explore",
  "superspec-propose",
  "superspec-apply",
  "superspec-review",
  "superspec-archive",
] as const;

export const WORKFLOW_PROMPTS = [
  "architect.md",
  "code-reviewer.md",
  "critic.md",
  "executor.md",
  "explore.md",
  "test-engineer.md",
  "test-runner.md",
  "verifier.md",
] as const;

export const WORKFLOW_AGENTS = [
  "architect.toml",
  "code-reviewer.toml",
  "critic.toml",
  "executor.toml",
  "explore.toml",
  "test-engineer.toml",
  "test-runner.toml",
  "verifier.toml",
] as const;

export interface InstallResult {
  ok: boolean;
  message: string;
  installed: {
    engine_dir: string;
    skills: string[];
    prompts: string[];
    agents: string[];
    config: string;
    openspec_config: string;
  };
}

export interface InstallOptions {
  templateRoot?: string;
}

function defaultTemplateRoot(): string {
  return join(import.meta.dirname, "..", "templates", "workflow");
}

function legacyStateFound(projectRoot: string): boolean {
  const changesRoot = join(projectRoot, "openspec", "changes");
  if (!existsSync(changesRoot)) return false;

  const oldStateFiles = ["superspec-state.json", "superspec-state.lock", "ledger.jsonl"];
  return oldStateFiles.some(file =>
    readdirSync(changesRoot).some(change =>
      existsSync(join(changesRoot, change, ".superspec", file)),
    ),
  );
}

function assertWorkflowTemplates(templateRoot: string): void {
  const missing: string[] = [];
  for (const skill of WORKFLOW_SKILLS) {
    const file = join(templateRoot, "skills", skill, "SKILL.md");
    if (!existsSync(file)) missing.push(file);
  }
  for (const prompt of WORKFLOW_PROMPTS) {
    const file = join(templateRoot, "prompts", prompt);
    if (!existsSync(file)) missing.push(file);
  }
  for (const agent of WORKFLOW_AGENTS) {
    const file = join(templateRoot, "agents", agent);
    if (!existsSync(file)) missing.push(file);
  }

  if (missing.length > 0) {
    throw new Error(`workflow templates missing: ${missing.join(", ")}`);
  }
}

function copySkills(templateRoot: string, projectRoot: string): string[] {
  const skillsDest = join(projectRoot, ".codex", "skills");
  const installedSkills: string[] = [];
  for (const skill of WORKFLOW_SKILLS) {
    const src = join(templateRoot, "skills", skill, "SKILL.md");
    mkdirSync(join(skillsDest, skill), { recursive: true });
    copyFileSync(src, join(skillsDest, skill, "SKILL.md"));
    installedSkills.push(skill);
  }
  return installedSkills;
}

function copyPrompts(templateRoot: string, projectRoot: string): string[] {
  const promptsDest = join(projectRoot, ".codex", "prompts");
  const installedPrompts: string[] = [];
  for (const prompt of WORKFLOW_PROMPTS) {
    const src = join(templateRoot, "prompts", prompt);
    mkdirSync(promptsDest, { recursive: true });
    copyFileSync(src, join(promptsDest, prompt));
    installedPrompts.push(prompt);
  }
  return installedPrompts;
}

function copyAgents(templateRoot: string, projectRoot: string): string[] {
  const agentsDest = join(projectRoot, ".codex", "agents");
  const installedAgents: string[] = [];
  for (const agent of WORKFLOW_AGENTS) {
    const src = join(templateRoot, "agents", agent);
    mkdirSync(agentsDest, { recursive: true });
    copyFileSync(src, join(agentsDest, agent));
    installedAgents.push(agent);
  }
  return installedAgents;
}

function insertMissingTableEntries(content: string, table: string, entries: Record<string, string>): string {
  const tablePattern = new RegExp(`^\\[${table}\\]\\s*$`, "m");
  const tableMatch = tablePattern.exec(content);
  const lines = Object.entries(entries).map(([key, value]) => `${key} = ${value}`);

  if (!tableMatch) {
    const separator = content.trim().length === 0 ? "" : "\n\n";
    return `${content.trimEnd()}${separator}[${table}]\n${lines.join("\n")}\n`;
  }

  const tableStart = tableMatch.index;
  const headerEnd = tableStart + tableMatch[0].length;
  const nextTable = /^\[[^\]]+\]\s*$/m.exec(content.slice(headerEnd));
  const tableEnd = nextTable ? headerEnd + nextTable.index : content.length;
  const tableBody = content.slice(headerEnd, tableEnd);
  const missing = lines.filter(line => {
    const key = line.split(" = ", 1)[0];
    return !new RegExp(`^\\s*${key}\\s*=`, "m").test(tableBody);
  });

  if (missing.length === 0) return content;
  return `${content.slice(0, headerEnd)}\n${missing.join("\n")}${content.slice(headerEnd)}`;
}

function ensureCodexConfig(projectRoot: string): string {
  const codexDir = join(projectRoot, ".codex");
  const configPath = join(codexDir, "config.toml");
  mkdirSync(codexDir, { recursive: true });

  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  let next = insertMissingTableEntries(current, "features", {
    multi_agent: "true",
    child_agents_md: "true",
  });
  next = insertMissingTableEntries(next, "agents", {
    max_threads: "12",
    max_depth: "1",
  });
  if (next !== current) writeFileSync(configPath, next);
  return ".codex/config.toml";
}

const OPENSPEC_CONFIG_PATH = "openspec/config.yaml";
const OPENSPEC_CHINESE_CONTEXT_BLOCK =
  "context: |\n" +
  "  语言：中文（简体）\n" +
  "  所有产出物必须用简体中文撰写。\n";
const OPENSPEC_DEFAULT_CONFIG =
  "schema: spec-driven\n\n" +
  OPENSPEC_CHINESE_CONTEXT_BLOCK;

function hasTopLevelContext(content: string): boolean {
  return /^context\s*:/m.test(content);
}

function ensureOpenSpecChineseContext(projectRoot: string): string {
  const openspecDir = join(projectRoot, "openspec");
  const configPath = join(projectRoot, OPENSPEC_CONFIG_PATH);
  mkdirSync(openspecDir, { recursive: true });

  if (!existsSync(configPath)) {
    writeFileSync(configPath, OPENSPEC_DEFAULT_CONFIG);
    return OPENSPEC_CONFIG_PATH;
  }

  const current = readFileSync(configPath, "utf8");
  if (hasTopLevelContext(current)) return OPENSPEC_CONFIG_PATH;

  const trimmed = current.trimEnd();
  const next = trimmed.length > 0
    ? `${trimmed}\n\n${OPENSPEC_CHINESE_CONTEXT_BLOCK}`
    : OPENSPEC_DEFAULT_CONFIG;
  writeFileSync(configPath, next);
  return OPENSPEC_CONFIG_PATH;
}

export function installProject(projectRoot: string, options: InstallOptions = {}): InstallResult {
  if (legacyStateFound(projectRoot)) {
    throw new Error(
      "检测到老版 SuperSpec (0.x) 的状态文件。\n" +
      "SuperSpec 0.1.16-alpha 是全新引擎，不兼容 0.x 的状态格式。\n" +
      "请先用老版（0.1.x）完成或归档现有 change，再安装 0.1.16-alpha。\n" +
      "或在全新项目目录中安装。",
    );
  }

  const templateRoot = options.templateRoot ?? defaultTemplateRoot();
  assertWorkflowTemplates(templateRoot);

  const engineDir = join(projectRoot, ".superspec");
  mkdirSync(join(engineDir, "changes"), { recursive: true });
  const gitignorePath = join(engineDir, ".gitignore");
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "changes/\n*.log\n*.tmp\n");

  return {
    ok: true,
    message: "SuperSpec 0.1.16-alpha 已安装",
    installed: {
      engine_dir: ".superspec/",
      skills: copySkills(templateRoot, projectRoot),
      prompts: copyPrompts(templateRoot, projectRoot),
      agents: copyAgents(templateRoot, projectRoot),
      config: ensureCodexConfig(projectRoot),
      openspec_config: ensureOpenSpecChineseContext(projectRoot),
    },
  };
}
