import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SUPERSPEC_VERSION } from "./version.ts";

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
    agents_md: string;
    openspec_config: string;
  };
}

export interface InstallOptions {
  templateRoot?: string;
  allowLegacyState?: boolean;
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
  const agentsMdTemplate = join(templateRoot, "AGENTS.md");
  if (!existsSync(agentsMdTemplate)) missing.push(agentsMdTemplate);

  if (missing.length > 0) {
    throw new Error(`workflow templates missing: ${missing.join(", ")}`);
  }
}

function writeBundledFile(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const next = readFileSync(src, "utf8");
  if (existsSync(dest)) {
    const current = readFileSync(dest, "utf8");
    if (current === next) return;
  }
  writeFileSync(dest, next);
}

function copySkills(templateRoot: string, projectRoot: string): string[] {
  const skillsDest = join(projectRoot, ".codex", "skills");
  const installedSkills: string[] = [];
  for (const skill of WORKFLOW_SKILLS) {
    const src = join(templateRoot, "skills", skill, "SKILL.md");
    writeBundledFile(src, join(skillsDest, skill, "SKILL.md"));
    installedSkills.push(skill);
  }
  return installedSkills;
}

function copyPrompts(templateRoot: string, projectRoot: string): string[] {
  const promptsDest = join(projectRoot, ".codex", "prompts");
  const installedPrompts: string[] = [];
  for (const prompt of WORKFLOW_PROMPTS) {
    const src = join(templateRoot, "prompts", prompt);
    writeBundledFile(src, join(promptsDest, prompt));
    installedPrompts.push(prompt);
  }
  return installedPrompts;
}

function copyAgents(templateRoot: string, projectRoot: string): string[] {
  const agentsDest = join(projectRoot, ".codex", "agents");
  const installedAgents: string[] = [];
  for (const agent of WORKFLOW_AGENTS) {
    const src = join(templateRoot, "agents", agent);
    writeBundledFile(src, join(agentsDest, agent));
    installedAgents.push(agent);
  }
  return installedAgents;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacySuperspecHook(value: unknown): boolean {
  return isRecord(value)
    && typeof value.command === "string"
    && /\bsuperspec-hook\b/.test(value.command);
}

function removeLegacySuperspecHookCommands(hooks: unknown): { hooks: unknown; removed: number } {
  if (!isRecord(hooks)) return { hooks, removed: 0 };

  let removed = 0;
  const nextHooks: JsonRecord = { ...hooks };
  for (const [eventName, eventValue] of Object.entries(hooks)) {
    if (!Array.isArray(eventValue)) continue;

    const nextEvent: unknown[] = [];
    for (const entry of eventValue) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        nextEvent.push(entry);
        continue;
      }

      const keptCommands = entry.hooks.filter(command => {
        if (!isLegacySuperspecHook(command)) return true;
        removed += 1;
        return false;
      });
      if (keptCommands.length > 0) {
        nextEvent.push({ ...entry, hooks: keptCommands });
      }
    }

    if (nextEvent.length > 0) nextHooks[eventName] = nextEvent;
    else delete nextHooks[eventName];
  }

  return { hooks: nextHooks, removed };
}

function hasUserHookContent(config: JsonRecord): boolean {
  return Object.entries(config).some(([key, value]) => {
    if (key === "superspec") return false;
    if (key === "hooks" && isRecord(value) && Object.keys(value).length === 0) return false;
    return true;
  });
}

function migrateLegacyManagedHooks(projectRoot: string): void {
  const hooksPath = join(projectRoot, ".codex", "hooks.json");
  if (!existsSync(hooksPath)) return;

  const current = readFileSync(hooksPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.superspec) || parsed.superspec.managed !== true) return;

  const migrated = removeLegacySuperspecHookCommands(parsed.hooks);
  if (migrated.removed === 0) return;

  writeFileSync(`${hooksPath}.bak`, current);
  const nextConfig: JsonRecord = { ...parsed, hooks: migrated.hooks };
  delete nextConfig.superspec;
  if (isRecord(nextConfig.hooks) && Object.keys(nextConfig.hooks).length === 0) {
    delete nextConfig.hooks;
  }

  if (!hasUserHookContent(nextConfig)) {
    rmSync(hooksPath);
    return;
  }

  writeFileSync(hooksPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
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

const AGENTS_MD_PATH = "AGENTS.md";
const SUPERSPEC_AGENTS_START = "<!-- SUPERSPEC:AGENTS:START -->";
const SUPERSPEC_AGENTS_END = "<!-- SUPERSPEC:AGENTS:END -->";

function readAgentsMdTemplate(templateRoot: string): string {
  const template = readFileSync(join(templateRoot, AGENTS_MD_PATH), "utf8").trimEnd();
  if (!template.includes(SUPERSPEC_AGENTS_START) || !template.includes(SUPERSPEC_AGENTS_END)) {
    throw new Error(`workflow AGENTS.md template missing SuperSpec markers: ${join(templateRoot, AGENTS_MD_PATH)}`);
  }
  return template;
}

function replaceMarkerBlock(content: string, block: string): string | null {
  const start = content.indexOf(SUPERSPEC_AGENTS_START);
  const end = content.indexOf(SUPERSPEC_AGENTS_END);
  if (start < 0 || end < 0 || end < start) return null;
  const afterEnd = end + SUPERSPEC_AGENTS_END.length;
  return `${content.slice(0, start)}${block}${content.slice(afterEnd)}`;
}

function ensureAgentsMd(projectRoot: string, block: string): string {
  const agentsPath = join(projectRoot, AGENTS_MD_PATH);
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, `${block}\n`);
    return AGENTS_MD_PATH;
  }

  const current = readFileSync(agentsPath, "utf8");
  const replaced = replaceMarkerBlock(current, block);
  const next = replaced ?? `${current.trimEnd()}\n\n${block}\n`;
  if (next === current) return AGENTS_MD_PATH;

  writeFileSync(agentsPath, next);
  return AGENTS_MD_PATH;
}

export function installProject(projectRoot: string, options: InstallOptions = {}): InstallResult {
  if (!options.allowLegacyState && legacyStateFound(projectRoot)) {
    throw new Error(
      "检测到老版 SuperSpec (0.x) 的状态文件。\n" +
      `SuperSpec ${SUPERSPEC_VERSION} 是全新引擎，不兼容 0.x 的状态格式。\n` +
      `请先用老版（0.1.x）完成或归档现有 change，再安装 ${SUPERSPEC_VERSION}。\n` +
      "或在全新项目目录中安装。",
    );
  }

  const templateRoot = options.templateRoot ?? defaultTemplateRoot();
  assertWorkflowTemplates(templateRoot);
  const agentsMdTemplate = readAgentsMdTemplate(templateRoot);

  const engineDir = join(projectRoot, ".superspec");
  mkdirSync(join(engineDir, "changes"), { recursive: true });
  const gitignorePath = join(engineDir, ".gitignore");
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "changes/\n*.log\n*.tmp\n");
  migrateLegacyManagedHooks(projectRoot);

  return {
    ok: true,
    message: `SuperSpec ${SUPERSPEC_VERSION} 已安装`,
    installed: {
      engine_dir: ".superspec/",
      skills: copySkills(templateRoot, projectRoot),
      prompts: copyPrompts(templateRoot, projectRoot),
      agents: copyAgents(templateRoot, projectRoot),
      config: ensureCodexConfig(projectRoot),
      agents_md: ensureAgentsMd(projectRoot, agentsMdTemplate),
      openspec_config: ensureOpenSpecChineseContext(projectRoot),
    },
  };
}
