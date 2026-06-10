// Manifest-driven install/update/uninstall engine (audit G-1, Phase 5 decision D4, 2026-06-10).
// Single engine behind `superspec_init` / `--update` / `--uninstall`, per DISTRIBUTION.md §5-§6:
// - install-map (adapters/codex/install-map.json) is the only source of what gets installed;
// - install-manifest (.codex/superspec/install-manifest.json) is the only basis for update/uninstall;
// - manifest sha256 is the managed BASELINE: mismatch means the user edited the file, which the
//   engine must never overwrite or delete (dpkg-style *.new / skip + warn).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, type JsonMap, isObject, sha256_file } from "./util.ts";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INSTALL_MAP_REL = join("adapters", "codex", "install-map.json");
export const INSTALL_MANIFEST_REL = join(".codex", "superspec", "install-manifest.json");

export type InstallMapping = { kind: string; source: string; target: string };
export type ManifestFileEntry = { path: string; sha256: string; managed: boolean; preexisting: boolean };
export type EngineAction = {
  action: string;
  status: "ok" | "created" | "updated" | "skipped" | "removed" | "would_remove" | "failed";
  refs?: string[];
  detail?: string;
};
export type EngineResult = {
  actions: EngineAction[];
  problems: string[];
  manifest: JsonMap | null;
};

function package_version(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function load_install_map(packageRoot: string = PACKAGE_ROOT): { mappings: InstallMapping[]; problems: string[] } {
  const mapPath = join(packageRoot, INSTALL_MAP_REL);
  if (!existsSync(mapPath)) return { mappings: [], problems: [`install map missing: ${mapPath}`] };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch (err) {
    return { mappings: [], problems: [`install map unparsable: ${(err as Error).message}`] };
  }
  if (!isObject(raw) || !Array.isArray(raw.mappings)) return { mappings: [], problems: ["install map must contain a mappings list"] };
  const mappings: InstallMapping[] = [];
  const problems: string[] = [];
  raw.mappings.forEach((item: any, idx: number) => {
    if (!isObject(item) || typeof item.kind !== "string" || typeof item.source !== "string" || !item.source
      || typeof item.target !== "string" || !item.target) {
      problems.push(`install map mappings[${idx}] is malformed`);
      return;
    }
    if (!existsSync(join(packageRoot, item.source))) {
      problems.push(`install map source missing: ${item.source}`);
      return;
    }
    mappings.push({ kind: item.kind, source: item.source, target: item.target });
  });
  return { mappings, problems };
}

export function manifest_shape_problems(manifest: any): string[] {
  // Lightweight mirror of schemas/install-manifest.schema.json (no runtime deps allowed).
  const problems: string[] = [];
  if (!isObject(manifest)) return ["manifest is not an object"];
  if (typeof manifest.superspecVersion !== "string" || !manifest.superspecVersion) problems.push("superspecVersion missing");
  if (typeof manifest.installedAt !== "string" || Number.isNaN(Date.parse(manifest.installedAt))) problems.push("installedAt missing or not a date-time");
  if (!Number.isInteger(manifest.guardSchemaVersion) || manifest.guardSchemaVersion < 1) problems.push("guardSchemaVersion missing");
  if (!["npm-bin", "repo-wrapper"].includes(manifest.guardWiring)) problems.push("guardWiring must be npm-bin or repo-wrapper");
  if (!Array.isArray(manifest.createdDirs) || manifest.createdDirs.some((item: any) => typeof item !== "string" || !item)) problems.push("createdDirs malformed");
  if (!Array.isArray(manifest.dataGlobs) || manifest.dataGlobs.some((item: any) => typeof item !== "string" || !item)) problems.push("dataGlobs malformed");
  if (!Array.isArray(manifest.files)) {
    problems.push("files missing");
  } else {
    manifest.files.forEach((entry: any, idx: number) => {
      if (!isObject(entry) || typeof entry.path !== "string" || !entry.path
        || typeof entry.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.sha256)
        || typeof entry.managed !== "boolean" || typeof entry.preexisting !== "boolean") {
        problems.push(`files[${idx}] malformed`);
      }
    });
  }
  return problems;
}

export function read_install_manifest(repoRoot: string): { manifest: JsonMap | null; problems: string[] } {
  const manifestPath = join(repoRoot, INSTALL_MANIFEST_REL);
  if (!existsSync(manifestPath)) return { manifest: null, problems: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { manifest: null, problems: [`install manifest unparsable: ${(err as Error).message}`] };
  }
  const shapeProblems = manifest_shape_problems(parsed);
  if (shapeProblems.length > 0) return { manifest: null, problems: shapeProblems.map((item) => `install manifest invalid: ${item}`) };
  return { manifest: parsed, problems: [] };
}

function write_install_manifest(repoRoot: string, packageRoot: string, files: ManifestFileEntry[], createdDirs: string[]): JsonMap {
  const manifest: JsonMap = {
    superspecVersion: package_version(packageRoot),
    installedAt: new Date().toISOString(),
    guardSchemaVersion: SCHEMA_VERSION,
    guardWiring: "repo-wrapper",
    files,
    createdDirs: [...new Set(createdDirs)].sort(),
    dataGlobs: ["**/.superspec"],
  };
  const manifestPath = join(repoRoot, INSTALL_MANIFEST_REL);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function ensure_parent_dirs(repoRoot: string, targetAbs: string, createdDirs: string[]): void {
  const parent = dirname(targetAbs);
  if (existsSync(parent)) return;
  // Record every directory level this install creates so uninstall can remove exactly those.
  let probe = parent;
  const missing: string[] = [];
  while (!existsSync(probe) && probe.startsWith(repoRoot) && probe !== repoRoot) {
    missing.push(probe);
    probe = dirname(probe);
  }
  mkdirSync(parent, { recursive: true });
  for (const dir of missing) createdDirs.push(dir.slice(repoRoot.length + 1));
}

function install_one(repoRoot: string, packageRoot: string, mapping: InstallMapping, createdDirs: string[]): { entry: ManifestFileEntry; action: EngineAction } {
  const sourceAbs = join(packageRoot, mapping.source);
  const targetAbs = join(repoRoot, mapping.target);
  const sourceSha = sha256_file(sourceAbs)!;
  ensure_parent_dirs(repoRoot, targetAbs, createdDirs);
  copyFileSync(sourceAbs, targetAbs);
  if (mapping.kind === "wrapper") chmodSync(targetAbs, 0o755);
  return {
    entry: { path: mapping.target, sha256: sourceSha, managed: true, preexisting: false },
    action: { action: `install ${mapping.target}`, status: "created" },
  };
}

export function install_workflow(repoRoot: string, opts: { force?: boolean; packageRoot?: string } = {}): EngineResult {
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  const { mappings, problems } = load_install_map(packageRoot);
  const actions: EngineAction[] = [];
  if (problems.length > 0) return { actions, problems, manifest: null };

  const files: ManifestFileEntry[] = [];
  const createdDirs: string[] = [];
  for (const mapping of mappings) {
    const sourceAbs = join(packageRoot, mapping.source);
    const targetAbs = join(repoRoot, mapping.target);
    const sourceSha = sha256_file(sourceAbs)!;
    const targetSha = sha256_file(targetAbs);
    if (targetSha === null) {
      const result = install_one(repoRoot, packageRoot, mapping, createdDirs);
      files.push(result.entry);
      actions.push(result.action);
    } else if (targetSha === sourceSha) {
      // Identical content: adopt as managed (idempotent re-init).
      files.push({ path: mapping.target, sha256: sourceSha, managed: true, preexisting: false });
      actions.push({ action: `install ${mapping.target}`, status: "ok" });
    } else if (opts.force) {
      copyFileSync(targetAbs, `${targetAbs}.bak`);
      copyFileSync(sourceAbs, targetAbs);
      if (mapping.kind === "wrapper") chmodSync(targetAbs, 0o755);
      files.push({ path: mapping.target, sha256: sourceSha, managed: true, preexisting: false });
      actions.push({ action: `install ${mapping.target}`, status: "updated", detail: `existing file backed up to ${mapping.target}.bak` });
    } else {
      // Pre-existing different file: never overwrite, never delete (DISTRIBUTION §5 red line).
      files.push({ path: mapping.target, sha256: targetSha, managed: false, preexisting: true });
      actions.push({ action: `install ${mapping.target}`, status: "skipped", detail: "pre-existing file with different content kept; rerun with --force to overwrite (backs up *.bak)" });
    }
  }
  const manifest = write_install_manifest(repoRoot, packageRoot, files, createdDirs);
  return { actions, problems: [], manifest };
}

export function update_workflow(repoRoot: string, opts: { packageRoot?: string } = {}): EngineResult {
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  const actions: EngineAction[] = [];
  const { manifest: previous, problems: manifestProblems } = read_install_manifest(repoRoot);
  if (manifestProblems.length > 0) return { actions, problems: manifestProblems, manifest: null };
  if (previous === null) return { actions, problems: ["install manifest missing; run superspec_init (install) before --update"], manifest: null };
  const { mappings, problems } = load_install_map(packageRoot);
  if (problems.length > 0) return { actions, problems, manifest: null };

  const prevByPath = new Map<string, ManifestFileEntry>(
    (previous.files as ManifestFileEntry[]).map((entry) => [entry.path, entry]),
  );
  const files: ManifestFileEntry[] = [];
  const createdDirs: string[] = [...(previous.createdDirs as string[])];
  const mappedTargets = new Set<string>();

  for (const mapping of mappings) {
    mappedTargets.add(mapping.target);
    const sourceAbs = join(packageRoot, mapping.source);
    const targetAbs = join(repoRoot, mapping.target);
    const sourceSha = sha256_file(sourceAbs)!;
    const targetSha = sha256_file(targetAbs);
    const prev = prevByPath.get(mapping.target);

    if (prev?.preexisting) {
      // Was the user's file before we arrived: keep hands off forever.
      files.push({ ...prev, sha256: targetSha ?? prev.sha256 });
      actions.push({ action: `update ${mapping.target}`, status: "skipped", detail: "preexisting file is never touched" });
    } else if (targetSha === null) {
      const result = install_one(repoRoot, packageRoot, mapping, createdDirs);
      files.push(result.entry);
      actions.push({ ...result.action, action: `update ${mapping.target}` });
    } else if (targetSha === sourceSha) {
      files.push({ path: mapping.target, sha256: sourceSha, managed: true, preexisting: false });
      actions.push({ action: `update ${mapping.target}`, status: "ok" });
    } else if (prev && targetSha === prev.sha256) {
      // Managed and unmodified since install: safe to roll forward.
      copyFileSync(sourceAbs, targetAbs);
      if (mapping.kind === "wrapper") chmodSync(targetAbs, 0o755);
      files.push({ path: mapping.target, sha256: sourceSha, managed: true, preexisting: false });
      actions.push({ action: `update ${mapping.target}`, status: "updated" });
    } else {
      // User-modified managed file: keep the user's version, ship ours as *.new (dpkg style).
      // Manifest keeps the OLD baseline sha so uninstall still detects the modification.
      copyFileSync(sourceAbs, `${targetAbs}.new`);
      files.push(prev ?? { path: mapping.target, sha256: targetSha, managed: false, preexisting: true });
      actions.push({ action: `update ${mapping.target}`, status: "skipped", detail: `user-modified file kept; new version written to ${mapping.target}.new` });
    }
  }

  // Mappings removed from the new install map: delete the old managed file only when unmodified.
  for (const prev of prevByPath.values()) {
    if (mappedTargets.has(prev.path) || !prev.managed || prev.preexisting) continue;
    const targetAbs = join(repoRoot, prev.path);
    const targetSha = sha256_file(targetAbs);
    if (targetSha === null) continue;
    if (targetSha === prev.sha256) {
      unlinkSync(targetAbs);
      actions.push({ action: `update ${prev.path}`, status: "removed", detail: "managed file no longer shipped" });
    } else {
      files.push(prev);
      actions.push({ action: `update ${prev.path}`, status: "skipped", detail: "no longer shipped but user-modified; kept" });
    }
  }

  const manifest = write_install_manifest(repoRoot, packageRoot, files, createdDirs);
  return { actions, problems: [], manifest };
}

function remove_empty_created_dirs(repoRoot: string, createdDirs: string[], actions: EngineAction[]): void {
  const byDepth = [...new Set(createdDirs)].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const rel of byDepth) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    if (readdirSync(abs).length > 0) continue;
    rmdirSync(abs);
    actions.push({ action: `uninstall rmdir ${rel}`, status: "removed" });
  }
}

export function uninstall_workflow(repoRoot: string, opts: { dryRun?: boolean } = {}): EngineResult {
  const actions: EngineAction[] = [];
  const { manifest, problems: manifestProblems } = read_install_manifest(repoRoot);
  if (manifestProblems.length > 0) return { actions, problems: manifestProblems, manifest: null };
  if (manifest === null) return { actions, problems: ["install manifest missing; nothing to uninstall (manifest is the only removal authority)"], manifest: null };

  for (const entry of manifest.files as ManifestFileEntry[]) {
    const targetAbs = join(repoRoot, entry.path);
    if (!entry.managed || entry.preexisting) {
      actions.push({ action: `uninstall ${entry.path}`, status: "skipped", detail: "preexisting/unmanaged file is never touched" });
      continue;
    }
    const targetSha = sha256_file(targetAbs);
    if (targetSha === null) {
      actions.push({ action: `uninstall ${entry.path}`, status: "ok", detail: "already absent" });
      continue;
    }
    if (targetSha !== entry.sha256) {
      actions.push({ action: `uninstall ${entry.path}`, status: "skipped", detail: "user-modified since install; kept" });
      continue;
    }
    if (opts.dryRun) {
      actions.push({ action: `uninstall ${entry.path}`, status: "would_remove" });
    } else {
      unlinkSync(targetAbs);
      actions.push({ action: `uninstall ${entry.path}`, status: "removed" });
    }
  }

  if (!opts.dryRun) {
    remove_empty_created_dirs(repoRoot, manifest.createdDirs as string[], actions);
    const manifestPath = join(repoRoot, INSTALL_MANIFEST_REL);
    if (existsSync(manifestPath)) {
      unlinkSync(manifestPath);
      actions.push({ action: `uninstall ${INSTALL_MANIFEST_REL}`, status: "removed" });
    }
    const manifestDir = dirname(manifestPath);
    if (existsSync(manifestDir) && readdirSync(manifestDir).length === 0) rmdirSync(manifestDir);
  }
  // .superspec runtime data (dataGlobs) is intentionally untouched: default uninstall keeps all
  // evidence/state; a --purge with preservation bundle is future work (DISTRIBUTION §6.4).
  return { actions, problems: [], manifest };
}
