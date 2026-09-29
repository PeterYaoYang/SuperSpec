import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SUPERSPEC_VERSION } from "./version.ts";
import {
  DEFAULT_WORKFLOW_HOSTS,
  normalizeWorkflowHosts,
  persistWorkflowHosts,
  workflowClaudePermissionsForProject,
  workflowHostsDeclared,
  workflowHostsForProject,
  type WorkflowHost,
} from "./workflow_config.ts";

export const WORKFLOW_SKILLS = [
  "superspec-explore",
  "superspec-propose",
  "superspec-apply",
  "superspec-review",
] as const;

const DEPRECATED_WORKFLOW_SKILLS = ["superspec-archive"] as const;

export const WORKFLOW_ROLES = [
  "architect",
  "code-reviewer",
  "critic",
  "executor",
  "explore",
  "test-engineer",
  "test-runner",
  "verifier",
] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

/** 各宿主共用的长角色 prompt：Codex 原样安装到 .codex/prompts，Markdown 宿主拼进 agent 正文。 */
export const WORKFLOW_PROMPTS: string[] = WORKFLOW_ROLES.map(role => `${role}.md`);
/** Codex agent 文件名，由 roles/<role>.md 渲染。 */
export const WORKFLOW_AGENTS: string[] = WORKFLOW_ROLES.map(role => `${role}.toml`);
/** OMP 与 Claude Code 的 Markdown agent 文件名，由 roles/<role>.md 渲染。 */
export const WORKFLOW_MARKDOWN_AGENTS: string[] = WORKFLOW_ROLES.map(role => `${role}.md`);

export const INSTALL_MANIFEST_PATH = ".superspec/install-manifest.json";
const CODEX_SKILLS_DIR = ".codex/skills";
const CODEX_PROMPTS_DIR = ".codex/prompts";
const CODEX_AGENTS_DIR = ".codex/agents";
const CODEX_CONFIG_PATH = ".codex/config.toml";
const CLAUDE_SKILLS_DIR = ".claude/skills";
const CLAUDE_AGENTS_DIR = ".claude/agents";
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const CLAUDE_MD_PATH = "CLAUDE.md";
/** OMP 通过 Codex 兼容 provider 读取 .codex/skills，所以两者共用同一份。 */
const CODEX_SKILL_HOSTS: WorkflowHost[] = ["codex", "omp"];
const CLAUDE_SUPERSPEC_ALLOW = ["Bash(superspec *)"] as const;

export interface OmpInstallResult {
  dest: string | null;
  agents: string[];
  skipped: string | null;
}

export type ClaudeMdStatus = "created" | "appended" | "updated" | "unchanged" | "already_imported";
export type ClaudeSettingsStatus = "added" | "unchanged" | "skipped" | "disabled";

export interface ClaudeInstallResult {
  skills: string[];
  agents: string[];
  claude_md: { path: string; status: ClaudeMdStatus } | null;
  settings: { path: string; status: ClaudeSettingsStatus; reason: string | null } | null;
}

export interface InstallRemovalReport {
  removed: string[];
  kept_modified: string[];
  not_removed_external: string[];
  kept_shared_config: string[];
}

export interface InstallResult {
  ok: boolean;
  message: string;
  installed: {
    engine_dir: string;
    hosts: WorkflowHost[];
    /** 写入 .codex/skills 的 skill；Claude Code 的 skill 见 claude.skills。 */
    skills: string[];
    prompts: string[];
    agents: string[];
    omp: OmpInstallResult;
    claude: ClaudeInstallResult;
    config: string;
    workflow_config: string;
    agents_md: string;
    openspec_config: string;
    manifest: string;
    removal: InstallRemovalReport;
  };
}

export interface InstallOptions {
  templateRoot?: string;
  allowLegacyState?: boolean;
  hosts?: WorkflowHost[];
  ompHome?: string;
  /** 未传入时沿用项目配置中的选择，默认开启。 */
  claudePermissions?: boolean;
}

interface ManagedFile {
  path: string;
  sha256: string;
  hosts: WorkflowHost[];
}

interface ClaudeSettingsManifest {
  path: string;
  created_file: boolean;
  added_allow: string[];
}

interface InstallManifest {
  schema_version: 1;
  superspec_version: string;
  hosts: WorkflowHost[];
  project_files: ManagedFile[];
  external_files: ManagedFile[];
  claude_md: { path: string } | null;
  claude_settings: ClaudeSettingsManifest | null;
}

interface RoleTemplate {
  name: WorkflowRole;
  description: string;
  taskSource: string;
  writes: boolean;
  body: string;
  rolePrompt: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  for (const role of WORKFLOW_ROLES) {
    for (const file of [join(templateRoot, "prompts", `${role}.md`), join(templateRoot, "roles", `${role}.md`)]) {
      if (!existsSync(file)) missing.push(file);
    }
  }
  const agentsMdTemplate = join(templateRoot, "AGENTS.md");
  if (!existsSync(agentsMdTemplate)) missing.push(agentsMdTemplate);

  if (missing.length > 0) {
    throw new Error(`workflow templates missing: ${missing.join(", ")}`);
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeIfChanged(dest: string, next: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && readFileSync(dest, "utf8") === next) return;
  writeFileSync(dest, next);
}

function writeManaged(dest: string, content: string, path: string, hosts: WorkflowHost[]): ManagedFile {
  writeIfChanged(dest, content);
  return { path, sha256: sha256(content), hosts };
}

function writeProjectFile(projectRoot: string, path: string, content: string, hosts: WorkflowHost[]): ManagedFile {
  return writeManaged(join(projectRoot, path), content, path, hosts);
}

// ===== 角色模板 =====

const TASK_BINDING_PLACEHOLDER = "{{task_binding}}";
const ROLE_PROMPT_PLACEHOLDER = "{{role_prompt}}";

function splitFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { fields, body: content.slice(match[0].length) };
}

function readRoleTemplate(templateRoot: string, role: WorkflowRole): RoleTemplate {
  const file = join(templateRoot, "roles", `${role}.md`);
  const { fields, body } = splitFrontmatter(readFileSync(file, "utf8"));
  const field = (key: string): string => {
    const value = fields[key];
    if (!value) throw new Error(`workflow role template missing ${key}: ${file}`);
    return value;
  };
  if (field("name") !== role) throw new Error(`workflow role template name mismatch: ${file}`);
  const writes = field("writes");
  if (writes !== "true" && writes !== "false") throw new Error(`workflow role template writes must be true or false: ${file}`);
  if (!body.includes(TASK_BINDING_PLACEHOLDER)) throw new Error(`workflow role template missing ${TASK_BINDING_PLACEHOLDER}: ${file}`);
  const unknown = body.replaceAll(TASK_BINDING_PLACEHOLDER, "").replaceAll(ROLE_PROMPT_PLACEHOLDER, "").match(/\{\{[^}]*\}\}/);
  if (unknown) throw new Error(`workflow role template has unknown placeholder ${unknown[0]}: ${file}`);

  return {
    name: role,
    description: field("description"),
    taskSource: field("task_source"),
    writes: writes === "true",
    body: body.trim(),
    rolePrompt: splitFrontmatter(readFileSync(join(templateRoot, "prompts", `${role}.md`), "utf8")).body.trim(),
  };
}

/** 随当前版本发布的角色长 prompt 正文；外部审查 worker 没有安装角色时，由 jobs dispatch 拼进派发说明。 */
export function workflowRolePrompt(role: WorkflowRole, templateRoot = defaultTemplateRoot()): string {
  return splitFrontmatter(readFileSync(join(templateRoot, "prompts", `${role}.md`), "utf8")).body.trim();
}

/** Codex 的长 prompt 单独安装，需要显式加载；Markdown 宿主的长 prompt 已拼在同一正文里。 */
function renderRoleSummary(role: RoleTemplate, style: "codex" | "markdown"): string {
  const taskBinding = style === "codex"
    ? `load \`${CODEX_PROMPTS_DIR}/${role.name}.md\` first, then read the current SuperSpec ${role.taskSource}.`
    : `read the current SuperSpec ${role.taskSource} first.`;
  return role.body
    .replaceAll(TASK_BINDING_PLACEHOLDER, taskBinding)
    .replaceAll(ROLE_PROMPT_PLACEHOLDER, style === "codex" ? "static prompt memory" : "this prompt");
}

function tomlMultilineString(value: string): string {
  return `"""\n${value.replaceAll("\\", "\\\\").replaceAll('"""', '""\\"')}\n"""`;
}

/** 不写 model / model_reasoning_effort：角色继承宿主会话的模型配置，工作流不绑定具体模型。 */
function renderCodexAgent(role: RoleTemplate): string {
  return [
    `# SuperSpec Codex agent: ${role.name}`,
    `name = ${JSON.stringify(role.name)}`,
    `description = ${JSON.stringify(role.description)}`,
    `developer_instructions = ${tomlMultilineString(renderRoleSummary(role, "codex"))}`,
    "",
  ].join("\n");
}

const MARKDOWN_AGENT_TOOLS = {
  omp: { read: ["read", "grep", "glob", "bash"], write: ["edit", "write"] },
  claude: { read: ["Read", "Grep", "Glob", "Bash"], write: ["Edit", "Write"] },
} as const;

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][^:#"'\n]*$/.test(value) && value === value.trim() ? value : JSON.stringify(value);
}

function renderMarkdownAgent(role: RoleTemplate, host: keyof typeof MARKDOWN_AGENT_TOOLS): string {
  const tools = MARKDOWN_AGENT_TOOLS[host];
  const toolList = role.writes ? [...tools.read, ...tools.write] : [...tools.read];
  return [
    "---",
    `name: ${role.name}`,
    `description: ${yamlScalar(role.description)}`,
    `tools: ${toolList.join(", ")}`,
    "---",
    "",
    renderRoleSummary(role, "markdown"),
    "",
    role.rolePrompt,
    "",
  ].join("\n");
}

// ===== 项目文件 =====

function removeDeprecatedSkills(projectRoot: string): void {
  for (const skillsDir of [CODEX_SKILLS_DIR, CLAUDE_SKILLS_DIR]) {
    for (const skill of DEPRECATED_WORKFLOW_SKILLS) {
      rmSync(join(projectRoot, skillsDir, skill), { recursive: true, force: true });
    }
  }
}

function installSkills(templateRoot: string, projectRoot: string, skillsDir: string, hosts: WorkflowHost[]): ManagedFile[] {
  return WORKFLOW_SKILLS.map(skill => writeProjectFile(
    projectRoot,
    `${skillsDir}/${skill}/SKILL.md`,
    readFileSync(join(templateRoot, "skills", skill, "SKILL.md"), "utf8"),
    hosts,
  ));
}

function installCodexPrompts(templateRoot: string, projectRoot: string): ManagedFile[] {
  return WORKFLOW_PROMPTS.map(prompt => writeProjectFile(
    projectRoot,
    `${CODEX_PROMPTS_DIR}/${prompt}`,
    readFileSync(join(templateRoot, "prompts", prompt), "utf8"),
    ["codex"],
  ));
}

function installCodexAgents(roles: RoleTemplate[], projectRoot: string): ManagedFile[] {
  return roles.map(role => writeProjectFile(projectRoot, `${CODEX_AGENTS_DIR}/${role.name}.toml`, renderCodexAgent(role), ["codex"]));
}

function installClaudeAgents(roles: RoleTemplate[], projectRoot: string): ManagedFile[] {
  return roles.map(role => writeProjectFile(projectRoot, `${CLAUDE_AGENTS_DIR}/${role.name}.md`, renderMarkdownAgent(role, "claude"), ["claude"]));
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
  const configPath = join(projectRoot, CODEX_CONFIG_PATH);
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
  return CODEX_CONFIG_PATH;
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

// ===== OMP 用户目录 =====

function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveOmpAgentHome(explicitHome?: string): { dest: string | null; skipped: string | null } {
  if (explicitHome) {
    return existingDirectory(explicitHome)
      ? { dest: explicitHome, skipped: null }
      : { dest: null, skipped: `OMP 用户目录不存在：${explicitHome}` };
  }

  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? "").trim();
  const dest = profile && profile !== "default"
    ? join(homedir(), ".omp", "profiles", profile, "agent")
    : join(homedir(), ".omp", "agent");
  if (!existingDirectory(dest)) {
    return { dest: null, skipped: `OMP 用户目录不存在：${dest}。先启动一次 omp，或用 --omp-home 指定已有目录。` };
  }
  return { dest, skipped: null };
}

function installOmpAgents(roles: RoleTemplate[], ompHome?: string): { result: OmpInstallResult; files: ManagedFile[] } {
  const resolved = resolveOmpAgentHome(ompHome);
  if (!resolved.dest) return { result: { dest: null, agents: [], skipped: resolved.skipped }, files: [] };
  const agentsDir = join(resolved.dest, "agents");
  const files = roles.map(role => {
    const dest = join(agentsDir, `${role.name}.md`);
    return writeManaged(dest, renderMarkdownAgent(role, "omp"), dest, ["omp"]);
  });
  return { result: { dest: resolved.dest, agents: [...WORKFLOW_MARKDOWN_AGENTS], skipped: null }, files };
}

// ===== 受管 Markdown 区块 =====

const AGENTS_MD_PATH = "AGENTS.md";
const SUPERSPEC_AGENTS_START = "<!-- SUPERSPEC:AGENTS:START -->";
const SUPERSPEC_AGENTS_END = "<!-- SUPERSPEC:AGENTS:END -->";
const SUPERSPEC_CLAUDE_START = "<!-- SUPERSPEC:CLAUDE:START -->";
const SUPERSPEC_CLAUDE_END = "<!-- SUPERSPEC:CLAUDE:END -->";
const CLAUDE_AGENTS_IMPORT = "@AGENTS.md";
const CLAUDE_MD_BLOCK = [SUPERSPEC_CLAUDE_START, CLAUDE_AGENTS_IMPORT, SUPERSPEC_CLAUDE_END].join("\n");

function readAgentsMdTemplate(templateRoot: string): string {
  const template = readFileSync(join(templateRoot, AGENTS_MD_PATH), "utf8").trimEnd();
  if (!template.includes(SUPERSPEC_AGENTS_START) || !template.includes(SUPERSPEC_AGENTS_END)) {
    throw new Error(`workflow AGENTS.md template missing SuperSpec markers: ${join(templateRoot, AGENTS_MD_PATH)}`);
  }
  return template;
}

function markerBlockRange(content: string, startMarker: string, endMarker: string): { start: number; end: number } | null {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) return null;
  return { start, end: end + endMarker.length };
}

function replaceMarkerBlock(content: string, block: string, startMarker: string, endMarker: string): string | null {
  const range = markerBlockRange(content, startMarker, endMarker);
  if (!range) return null;
  return `${content.slice(0, range.start)}${block}${content.slice(range.end)}`;
}

function ensureAgentsMd(projectRoot: string, block: string): string {
  const agentsPath = join(projectRoot, AGENTS_MD_PATH);
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, `${block}\n`);
    return AGENTS_MD_PATH;
  }

  const current = readFileSync(agentsPath, "utf8");
  const replaced = replaceMarkerBlock(current, block, SUPERSPEC_AGENTS_START, SUPERSPEC_AGENTS_END);
  const next = replaced ?? `${current.trimEnd()}\n\n${block}\n`;
  if (next === current) return AGENTS_MD_PATH;

  writeFileSync(agentsPath, next);
  return AGENTS_MD_PATH;
}

function importsAgentsMdOutsideBlock(content: string): boolean {
  const range = markerBlockRange(content, SUPERSPEC_CLAUDE_START, SUPERSPEC_CLAUDE_END);
  const outside = range ? `${content.slice(0, range.start)}${content.slice(range.end)}` : content;
  return outside.split(/\r?\n/).some(line => line.trim() === CLAUDE_AGENTS_IMPORT);
}

/** Claude Code 旧版本不读 AGENTS.md，新版本在存在 CLAUDE.md 时也不读，所以需要显式 import。 */
function ensureClaudeMd(projectRoot: string): ClaudeMdStatus {
  const claudeMdPath = join(projectRoot, CLAUDE_MD_PATH);
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `${CLAUDE_MD_BLOCK}\n`);
    return "created";
  }

  const current = readFileSync(claudeMdPath, "utf8");
  const replaced = replaceMarkerBlock(current, CLAUDE_MD_BLOCK, SUPERSPEC_CLAUDE_START, SUPERSPEC_CLAUDE_END);
  if (replaced !== null) {
    if (replaced === current) return "unchanged";
    writeFileSync(claudeMdPath, replaced);
    return "updated";
  }
  if (importsAgentsMdOutsideBlock(current)) return "already_imported";

  const separator = current.length === 0 || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(claudeMdPath, `${current}${separator}${CLAUDE_MD_BLOCK}\n`);
  return "appended";
}

function removeClaudeMdBlock(projectRoot: string, removal: InstallRemovalReport): void {
  const claudeMdPath = join(projectRoot, CLAUDE_MD_PATH);
  if (!existsSync(claudeMdPath)) return;
  const current = readFileSync(claudeMdPath, "utf8");
  const range = markerBlockRange(current, SUPERSPEC_CLAUDE_START, SUPERSPEC_CLAUDE_END);
  if (!range) return;

  const before = current.slice(0, range.start);
  const after = current.slice(range.end).replace(/^\r?\n/, "");
  const next = after.length > 0 ? `${before}${after}` : before.replace(/(?:\r?\n)+$/, "\n");
  if (next.trim().length === 0) {
    rmSync(claudeMdPath);
    removal.removed.push(CLAUDE_MD_PATH);
    return;
  }
  writeFileSync(claudeMdPath, next);
  removal.removed.push(`${CLAUDE_MD_PATH}#SUPERSPEC:CLAUDE`);
}

// ===== Claude Code 权限 =====

type ClaudeSettingsRead =
  | { ok: true; exists: boolean; settings: JsonRecord; permissions: JsonRecord; allow: unknown[] }
  | { ok: false; reason: string };

function readClaudeSettings(projectRoot: string): ClaudeSettingsRead {
  const settingsPath = join(projectRoot, CLAUDE_SETTINGS_PATH);
  if (!existsSync(settingsPath)) return { ok: true, exists: false, settings: {}, permissions: {}, allow: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { ok: false, reason: `${CLAUDE_SETTINGS_PATH} 不是有效 JSON，未修改` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: `${CLAUDE_SETTINGS_PATH} 顶层不是 JSON object，未修改` };
  if (parsed.permissions !== undefined && !isRecord(parsed.permissions)) {
    return { ok: false, reason: `${CLAUDE_SETTINGS_PATH} 的 permissions 不是 object，未修改` };
  }
  const permissions: JsonRecord = isRecord(parsed.permissions) ? parsed.permissions : {};
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    return { ok: false, reason: `${CLAUDE_SETTINGS_PATH} 的 permissions.allow 不是数组，未修改` };
  }
  const allow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : [];
  return { ok: true, exists: true, settings: parsed, permissions, allow };
}

function writeClaudeSettings(projectRoot: string, settings: JsonRecord): void {
  const settingsPath = join(projectRoot, CLAUDE_SETTINGS_PATH);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function ensureClaudePermissions(
  projectRoot: string,
  previous: ClaudeSettingsManifest | null,
): { result: NonNullable<ClaudeInstallResult["settings"]>; manifest: ClaudeSettingsManifest | null } {
  const read = readClaudeSettings(projectRoot);
  if (!read.ok) {
    return { result: { path: CLAUDE_SETTINGS_PATH, status: "skipped", reason: read.reason }, manifest: previous };
  }

  const missing = CLAUDE_SUPERSPEC_ALLOW.filter(entry => !read.allow.includes(entry));
  const stillOwned = (previous?.added_allow ?? []).filter(entry => read.allow.includes(entry));
  const addedAllow = [...new Set([...stillOwned, ...missing])];
  const manifest = addedAllow.length > 0
    ? { path: CLAUDE_SETTINGS_PATH, created_file: !read.exists || (previous?.created_file ?? false), added_allow: addedAllow }
    : null;
  if (missing.length === 0) {
    return { result: { path: CLAUDE_SETTINGS_PATH, status: "unchanged", reason: null }, manifest };
  }

  writeClaudeSettings(projectRoot, {
    ...read.settings,
    permissions: { ...read.permissions, allow: [...read.allow, ...missing] },
  });
  return { result: { path: CLAUDE_SETTINGS_PATH, status: "added", reason: null }, manifest };
}

function removeClaudePermissions(projectRoot: string, previous: ClaudeSettingsManifest, removal: InstallRemovalReport): void {
  const read = readClaudeSettings(projectRoot);
  if (!read.ok) {
    removal.kept_modified.push(CLAUDE_SETTINGS_PATH);
    return;
  }
  if (!read.exists) return;

  const owned = read.allow.filter((entry): entry is string => typeof entry === "string" && previous.added_allow.includes(entry));
  if (owned.length === 0) return;

  const permissions: JsonRecord = { ...read.permissions, allow: read.allow.filter(entry => !owned.includes(entry as string)) };
  if ((permissions.allow as unknown[]).length === 0) delete permissions.allow;
  const settings: JsonRecord = { ...read.settings, permissions };
  if (Object.keys(permissions).length === 0) delete settings.permissions;

  if (previous.created_file && Object.keys(settings).length === 0) {
    const settingsPath = join(projectRoot, CLAUDE_SETTINGS_PATH);
    rmSync(settingsPath);
    removal.removed.push(CLAUDE_SETTINGS_PATH);
    removeEmptyParents(projectRoot, dirname(settingsPath));
    return;
  }
  writeClaudeSettings(projectRoot, settings);
  removal.removed.push(...owned.map(entry => `${CLAUDE_SETTINGS_PATH}#permissions.allow:${entry}`));
}

// ===== 安装清单与宿主移除 =====

function emptyRemovalReport(): InstallRemovalReport {
  return { removed: [], kept_modified: [], not_removed_external: [], kept_shared_config: [] };
}

/** 清单可能被手改；只接受 SuperSpec 自己写入的宿主目录内的相对路径。 */
function isManagedProjectPath(path: string): boolean {
  if (isAbsolute(path) || path.includes("\\")) return false;
  if (path === CODEX_CONFIG_PATH || path === CLAUDE_SETTINGS_PATH) return false;
  const segments = path.split("/");
  return segments.length > 1
    && (segments[0] === ".codex" || segments[0] === ".claude")
    && segments.every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function managedFileEntries(value: unknown): ManagedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") return [];
    const hosts = Array.isArray(entry.hosts)
      ? normalizeWorkflowHosts(entry.hosts.filter((host): host is string => typeof host === "string"))
      : [];
    return [{ path: entry.path, sha256: entry.sha256, hosts }];
  });
}

function claudeSettingsManifestFrom(value: unknown): ClaudeSettingsManifest | null {
  if (!isRecord(value) || value.path !== CLAUDE_SETTINGS_PATH || !Array.isArray(value.added_allow)) return null;
  const addedAllow = value.added_allow.filter((entry): entry is string =>
    typeof entry === "string" && (CLAUDE_SUPERSPEC_ALLOW as readonly string[]).includes(entry));
  if (addedAllow.length === 0) return null;
  return { path: CLAUDE_SETTINGS_PATH, created_file: value.created_file === true, added_allow: addedAllow };
}

function readInstallManifest(projectRoot: string): InstallManifest | null {
  const manifestPath = join(projectRoot, INSTALL_MANIFEST_PATH);
  if (!existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return {
    schema_version: 1,
    superspec_version: typeof parsed.superspec_version === "string" ? parsed.superspec_version : "",
    hosts: Array.isArray(parsed.hosts)
      ? normalizeWorkflowHosts(parsed.hosts.filter((host): host is string => typeof host === "string"))
      : [],
    project_files: managedFileEntries(parsed.project_files).filter(entry => isManagedProjectPath(entry.path)),
    external_files: managedFileEntries(parsed.external_files),
    claude_md: isRecord(parsed.claude_md) && parsed.claude_md.path === CLAUDE_MD_PATH ? { path: CLAUDE_MD_PATH } : null,
    claude_settings: claudeSettingsManifestFrom(parsed.claude_settings),
  };
}

function removeEmptyParents(projectRoot: string, dir: string): void {
  const root = resolve(projectRoot);
  let current = resolve(dir);
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function removeStaleProjectFiles(
  projectRoot: string,
  previous: ManagedFile[],
  current: ManagedFile[],
  removal: InstallRemovalReport,
): void {
  const currentPaths = new Set(current.map(file => file.path));
  for (const entry of previous) {
    if (currentPaths.has(entry.path)) continue;
    const filePath = join(projectRoot, entry.path);
    if (!existsSync(filePath)) continue;
    if (sha256(readFileSync(filePath)) !== entry.sha256) {
      removal.kept_modified.push(entry.path);
      continue;
    }
    rmSync(filePath);
    removal.removed.push(entry.path);
    removeEmptyParents(projectRoot, dirname(filePath));
  }
}

/** OMP 用户目录跨项目共享，其他项目可能仍在使用这些 agent，只报告不删除。 */
function reportStaleExternalFiles(previous: ManagedFile[], current: ManagedFile[], removal: InstallRemovalReport): void {
  const currentPaths = new Set(current.map(file => file.path));
  for (const entry of previous) {
    if (!currentPaths.has(entry.path) && existsSync(entry.path)) removal.not_removed_external.push(entry.path);
  }
}

const ENGINE_GITIGNORE_ENTRIES = ["changes/", "*.log", "*.tmp", "install-manifest.json"] as const;

/** 清单记录本机 OMP 用户目录等绝对路径，不应随项目提交。 */
function ensureEngineGitignore(engineDir: string): void {
  const gitignorePath = join(engineDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${ENGINE_GITIGNORE_ENTRIES.join("\n")}\n`);
    return;
  }
  const current = readFileSync(gitignorePath, "utf8");
  const lines = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = ENGINE_GITIGNORE_ENTRIES.filter(entry => !lines.has(entry));
  if (missing.length === 0) return;
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${current}${separator}${missing.join("\n")}\n`);
}

// ===== 安装入口 =====

function installClaude(
  templateRoot: string,
  projectRoot: string,
  roles: RoleTemplate[],
  previous: InstallManifest | null,
  claudePermissions: boolean,
  removal: InstallRemovalReport,
): { result: ClaudeInstallResult; files: ManagedFile[]; claudeMd: InstallManifest["claude_md"]; settings: ClaudeSettingsManifest | null } {
  const files = [
    ...installSkills(templateRoot, projectRoot, CLAUDE_SKILLS_DIR, ["claude"]),
    ...installClaudeAgents(roles, projectRoot),
  ];
  const claudeMdStatus = ensureClaudeMd(projectRoot);

  let settingsResult: NonNullable<ClaudeInstallResult["settings"]>;
  let settings: ClaudeSettingsManifest | null = null;
  if (claudePermissions) {
    const ensured = ensureClaudePermissions(projectRoot, previous?.claude_settings ?? null);
    settingsResult = ensured.result;
    settings = ensured.manifest;
  } else {
    if (previous?.claude_settings) removeClaudePermissions(projectRoot, previous.claude_settings, removal);
    settingsResult = { path: CLAUDE_SETTINGS_PATH, status: "disabled", reason: null };
  }

  return {
    result: {
      skills: [...WORKFLOW_SKILLS],
      agents: [...WORKFLOW_MARKDOWN_AGENTS],
      claude_md: { path: CLAUDE_MD_PATH, status: claudeMdStatus },
      settings: settingsResult,
    },
    files,
    claudeMd: claudeMdStatus === "already_imported" ? null : { path: CLAUDE_MD_PATH },
    settings,
  };
}

export function installProject(projectRoot: string, options: InstallOptions = {}): InstallResult {
  if (!options.allowLegacyState && legacyStateFound(projectRoot)) {
    throw new Error(
      "检测到老版 SuperSpec (0.x) 的状态文件。\n" +
      `SuperSpec ${SUPERSPEC_VERSION} 是全新引擎，不兼容 0.x 的状态格式。\n` +
      `请先用老版（0.1.x）完成现有 change，再安装 ${SUPERSPEC_VERSION}。\n` +
      "或在全新项目目录中安装。",
    );
  }

  const templateRoot = options.templateRoot ?? defaultTemplateRoot();
  assertWorkflowTemplates(templateRoot);
  const agentsMdTemplate = readAgentsMdTemplate(templateRoot);
  const roles = WORKFLOW_ROLES.map(role => readRoleTemplate(templateRoot, role));
  const hosts = options.hosts
    ?? (workflowHostsDeclared(projectRoot) ? workflowHostsForProject(projectRoot) : DEFAULT_WORKFLOW_HOSTS);
  const wantsCodex = hosts.includes("codex");
  const wantsOmp = hosts.includes("omp");
  const wantsClaude = hosts.includes("claude");
  const claudePermissions = options.claudePermissions ?? workflowClaudePermissionsForProject(projectRoot);

  const engineDir = join(projectRoot, ".superspec");
  mkdirSync(join(engineDir, "changes"), { recursive: true });
  ensureEngineGitignore(engineDir);
  migrateLegacyManagedHooks(projectRoot);
  const previous = readInstallManifest(projectRoot);
  const removal = emptyRemovalReport();

  removeDeprecatedSkills(projectRoot);
  const codexSkillFiles = wantsCodex || wantsOmp
    ? installSkills(templateRoot, projectRoot, CODEX_SKILLS_DIR, CODEX_SKILL_HOSTS)
    : [];
  const codexPromptFiles = wantsCodex ? installCodexPrompts(templateRoot, projectRoot) : [];
  const codexAgentFiles = wantsCodex ? installCodexAgents(roles, projectRoot) : [];
  const config = wantsCodex ? ensureCodexConfig(projectRoot) : "";
  const omp = wantsOmp
    ? installOmpAgents(roles, options.ompHome)
    : { result: { dest: null, agents: [], skipped: null }, files: [] };

  const claude = wantsClaude
    ? installClaude(templateRoot, projectRoot, roles, previous, claudePermissions, removal)
    : null;
  if (!wantsClaude && previous?.claude_md) removeClaudeMdBlock(projectRoot, removal);
  if (!wantsClaude && previous?.claude_settings) removeClaudePermissions(projectRoot, previous.claude_settings, removal);

  const projectFiles = [...codexSkillFiles, ...codexPromptFiles, ...codexAgentFiles, ...(claude?.files ?? [])];
  removeStaleProjectFiles(projectRoot, previous?.project_files ?? [], projectFiles, removal);
  reportStaleExternalFiles(previous?.external_files ?? [], omp.files, removal);
  if (previous?.hosts.includes("codex") && !wantsCodex && existsSync(join(projectRoot, CODEX_CONFIG_PATH))) {
    removal.kept_shared_config.push(CODEX_CONFIG_PATH);
  }

  const manifest: InstallManifest = {
    schema_version: 1,
    superspec_version: SUPERSPEC_VERSION,
    hosts,
    project_files: projectFiles,
    external_files: omp.files,
    claude_md: claude?.claudeMd ?? null,
    claude_settings: claude?.settings ?? null,
  };
  writeIfChanged(join(projectRoot, INSTALL_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    ok: true,
    message: `SuperSpec ${SUPERSPEC_VERSION} 已安装`,
    installed: {
      engine_dir: ".superspec/",
      hosts,
      skills: codexSkillFiles.length > 0 ? [...WORKFLOW_SKILLS] : [],
      prompts: wantsCodex ? [...WORKFLOW_PROMPTS] : [],
      agents: wantsCodex ? [...WORKFLOW_AGENTS] : [],
      omp: omp.result,
      claude: claude?.result ?? { skills: [], agents: [], claude_md: null, settings: null },
      config,
      workflow_config: persistWorkflowHosts(projectRoot, hosts, options.claudePermissions),
      agents_md: ensureAgentsMd(projectRoot, agentsMdTemplate),
      openspec_config: ensureOpenSpecChineseContext(projectRoot),
      manifest: INSTALL_MANIFEST_PATH,
      removal,
    },
  };
}
