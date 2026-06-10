import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonMap, Reason } from "./util.ts";
import {
  ALLOWED_CONFIG_KEYS,
  BUILTIN_CONFIG,
  CHANGE_CONFIG_ALIASES,
  CONFIG_FILENAME,
  GuardError,
  PROJECT_CONFIG_ALIASES,
  REQUIRED_SIDECAR_DIRS,
  STATE_ALIASES,
  isObject,
  reason,
  repr,
  safe_within,
} from "./util.ts";

export function superspec_dir(changeRoot: string): string {
  return join(changeRoot, ".superspec");
}
export function project_superspec_dir(repoRoot: string): string {
  return join(repoRoot, ".superspec");
}
export function sidecar_artifacts_dir(changeRoot: string): string {
  return join(superspec_dir(changeRoot), "artifacts");
}
export function sidecar_test_contract_path(changeRoot: string): string {
  return join(sidecar_artifacts_dir(changeRoot), "test-contract.md");
}
export function sidecar_business_invariants_path(changeRoot: string): string {
  return join(sidecar_artifacts_dir(changeRoot), "business-invariants.md");
}
export function sidecar_discovery_path(changeRoot: string): string {
  return join(sidecar_artifacts_dir(changeRoot), "discovery.md");
}
export function sidecar_output_path(changeRoot: string, relPath: string): string {
  const target = safe_within(superspec_dir(changeRoot), relPath);
  if (target === null) throw new GuardError(`sidecar_path_invalid: ${relPath}`);
  return target;
}
export function write_sidecar_text(changeRoot: string, relPath: string, text: string): string {
  const filePath = sidecar_output_path(changeRoot, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
  return filePath;
}
export function write_sidecar_json(changeRoot: string, relPath: string, data: JsonMap): string {
  return write_sidecar_text(changeRoot, relPath, `${JSON.stringify(data, null, 2)}\n`);
}
export function config_file(changeRoot: string): string {
  return join(superspec_dir(changeRoot), CONFIG_FILENAME);
}
export function project_config_file(repoRoot: string): string {
  return join(project_superspec_dir(repoRoot), CONFIG_FILENAME);
}
export function required_sidecar_paths(changeRoot: string): string[] {
  return REQUIRED_SIDECAR_DIRS.map((relPath) => join(superspec_dir(changeRoot), relPath));
}

export function ensure_sidecar_layout(changeRoot: string): void {
  ensure_state_layout(changeRoot);
  for (const dirPath of required_sidecar_paths(changeRoot)) mkdirSync(dirPath, { recursive: true });
}

export function ensure_state_layout(changeRoot: string): void {
  const base = superspec_dir(changeRoot);
  mkdirSync(base, { recursive: true });
  const ledger = join(base, "ledger.jsonl");
  if (!existsSync(ledger)) writeFileSync(ledger, "");
}

export function find_forbidden_aliases(repoRoot: string, changeRoot: string): string[] {
  const aliases: string[] = [];
  for (const relPath of PROJECT_CONFIG_ALIASES) {
    const candidate = join(repoRoot, relPath);
    if (existsSync(candidate)) aliases.push(candidate);
  }
  for (const relPath of CHANGE_CONFIG_ALIASES) {
    const candidate = join(changeRoot, relPath);
    if (existsSync(candidate)) aliases.push(candidate);
  }
  for (const relPath of STATE_ALIASES) {
    const candidate = join(changeRoot, relPath);
    if (existsSync(candidate)) aliases.push(candidate);
  }
  return aliases;
}

export function read_skill_frontmatter_name(skillPath: string): string | null {
  let lines: string[];
  try {
    lines = readFileSync(skillPath, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (const raw of lines.slice(1)) {
    const stripped = raw.trim();
    if (stripped === "---") return null;
    if (stripped.startsWith("name:")) return stripped.split(":", 2)[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

export function read_agent_toml_name(agentPath: string): string | null {
  let lines: string[];
  try {
    lines = readFileSync(agentPath, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  for (const raw of lines) {
    const match = raw.match(/^\s*name\s*=\s*["']([^"']+)["']\s*$/);
    if (match) return match[1];
  }
  return null;
}

function parseScalar(raw: string): any {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "None") return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

export function parse_simple_yaml(filePath: string): JsonMap {
  const data: JsonMap = {};
  let currentKey: string | null = null;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) return;
    const indent = raw.length - raw.trimStart().length;
    if (!stripped.includes(":")) throw new GuardError(`config_parse_error: ${filePath}:${idx + 1}: expected key: value`);
    const [keyRaw, ...rest] = stripped.split(":");
    const key = keyRaw.trim();
    const value = rest.join(":");
    if (!key) throw new GuardError(`config_parse_error: ${filePath}:${idx + 1}: empty key`);
    if (indent === 0) {
      if (value.trim()) {
        data[key] = parseScalar(value);
        currentKey = null;
      } else {
        data[key] = {};
        currentKey = key;
      }
    } else if (indent === 2 && currentKey) {
      const parent = data[currentKey];
      if (!isObject(parent)) throw new GuardError(`config_parse_error: ${filePath}:${idx + 1}: parent is not mapping`);
      parent[key] = parseScalar(value);
    } else {
      throw new GuardError(`config_parse_error: ${filePath}:${idx + 1}: unsupported indentation`);
    }
  });
  return data;
}

export function merge_config(base: JsonMap, override: JsonMap): JsonMap {
  const merged = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(merged[key])) merged[key] = { ...merged[key], ...value };
    else merged[key] = value;
  }
  return merged;
}

export function validate_config_keys(config: JsonMap, source: string): Reason[] {
  const problems: Reason[] = [];
  for (const key of Object.keys(config)) {
    if (ALLOWED_CONFIG_KEYS.has(key) || key.startsWith("x-")) continue;
    problems.push(reason("unknown_config_key", `${source}: unknown config key ${repr(key)}`));
  }
  return problems;
}

export function load_config(repoRoot: string, changeRoot: string): [JsonMap, Reason[]] {
  const problems: Reason[] = [];
  for (const aliasPath of find_forbidden_aliases(repoRoot, changeRoot)) {
    problems.push(reason("forbidden_alias_path", `forbidden superspec alias exists: ${aliasPath}`));
  }
  let config = JSON.parse(JSON.stringify(BUILTIN_CONFIG));
  const projectCfg = project_config_file(repoRoot);
  if (existsSync(projectCfg) && statSync(projectCfg).isFile()) {
    const parsed = parse_simple_yaml(projectCfg);
    problems.push(...validate_config_keys(parsed, projectCfg));
    config = merge_config(config, parsed);
  }
  const changeCfg = config_file(changeRoot);
  if (existsSync(changeCfg) && statSync(changeCfg).isFile()) {
    const parsed = parse_simple_yaml(changeCfg);
    problems.push(...validate_config_keys(parsed, changeCfg));
    config = merge_config(config, parsed);
  }
  return [config, problems];
}
