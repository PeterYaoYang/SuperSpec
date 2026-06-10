import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Decision, JsonMap, Reason } from "./util.ts";
import {
  STATE_LOCK_FILENAME,
  allow,
  block,
  now,
  reason,
  renderList,
  repr,
  runtime,
  safe_within,
  sha256_file,
  sha256_text,
  toPosix,
  walkFiles,
} from "./util.ts";
import { ensure_state_layout, sidecar_artifacts_dir, superspec_dir } from "./paths.ts";

export function archive_manifest_path(changeRoot: string): string {
  return join(sidecar_artifacts_dir(changeRoot), "archive-preservation.json");
}
export function archive_preservation_dir(changeRoot: string): string {
  return join(changeRoot, "superspec-preservation");
}
export function archive_preservation_manifest_path(changeRoot: string): string {
  return join(archive_preservation_dir(changeRoot), "manifest.json");
}
function archive_staging_root(changeRoot: string, runId: string): string {
  return join(changeRoot, ".superspec-staging", runId);
}

function fsync_dir_best_effort(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort across platforms.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function write_text(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function excluded_manifest_entry(relPath: string): boolean {
  if (relPath.endsWith(STATE_LOCK_FILENAME) || relPath.endsWith("superspec-state.tmp")) return true;
  if (relPath === ".superspec/artifacts/archive-preservation.json") return true;
  return false;
}

function manifest_entries(changeRoot: string, fileOverrides: Record<string, string> = {}): JsonMap[] {
  const base = superspec_dir(changeRoot);
  const entries: JsonMap[] = [];
  const pendingOverrides = new Set(Object.keys(fileOverrides));
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const filePath of walkFiles(base).sort()) {
      const relPath = toPosix(relative(changeRoot, filePath));
      if (excluded_manifest_entry(relPath)) continue;
      if (pendingOverrides.has(relPath)) {
        entries.push({ path: relPath, sha256: sha256_text(fileOverrides[relPath]) });
        pendingOverrides.delete(relPath);
      } else {
        entries.push({ path: relPath, sha256: sha256_file(filePath) });
      }
    }
  }
  for (const relPath of [...pendingOverrides].sort()) {
    if (excluded_manifest_entry(relPath)) continue;
    entries.push({ path: relPath, sha256: sha256_text(fileOverrides[relPath]) });
  }
  return entries.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

export function sidecar_manifest_entries(changeRoot: string): JsonMap[] {
  return manifest_entries(changeRoot);
}

function archive_manifest_data(change: string, changeRoot: string, fileOverrides: Record<string, string> = {}): JsonMap {
  ensure_state_layout(changeRoot);
  return {
    schema_version: 1,
    change_id: change,
    created_at: now(),
    kind: "superspec_archive_preservation",
    entries: manifest_entries(changeRoot, fileOverrides),
  };
}

function write_manifest_file(filePath: string, manifest: JsonMap): string {
  write_text(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}

export function write_archive_manifest(change: string, changeRoot: string): string {
  return write_manifest_file(archive_manifest_path(changeRoot), archive_manifest_data(change, changeRoot));
}

function stage_archive_bundle(
  change: string,
  changeRoot: string,
  runId: string,
  fileOverrides: Record<string, string>,
): { staged_manifest_path: string; staged_bundle_dir: string } {
  const stagingRoot = archive_staging_root(changeRoot, runId);
  const stagedManifestPath = join(stagingRoot, "next", "archive-preservation.json");
  const stagedBundleDir = join(stagingRoot, "next", "superspec-preservation");
  const stagedFilesRoot = join(stagedBundleDir, "files");
  const manifest = archive_manifest_data(change, changeRoot, fileOverrides);
  write_manifest_file(stagedManifestPath, manifest);
  for (const entry of manifest.entries ?? []) {
    const relPath = entry.path;
    if (typeof relPath !== "string") continue;
    const dst = join(stagedFilesRoot, relPath);
    if (relPath in fileOverrides) {
      write_text(dst, fileOverrides[relPath]);
      continue;
    }
    const src = join(changeRoot, relPath);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  const bundleManifest = {
    ...manifest,
    kind: "superspec_archive_preservation_bundle",
    source_manifest: ".superspec/artifacts/archive-preservation.json",
    files_root: "files",
  };
  const stagedBundleManifestPath = join(stagedBundleDir, "manifest.json");
  write_text(stagedBundleManifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`);
  return { staged_manifest_path: stagedManifestPath, staged_bundle_dir: stagedBundleDir };
}

function restore_file_from_backup(finalPath: string, backupPath: string, hadFinal: boolean): void {
  if (existsSync(backupPath)) {
    if (existsSync(finalPath)) rmSync(finalPath, { force: true });
    mkdirSync(dirname(finalPath), { recursive: true });
    renameSync(backupPath, finalPath);
  } else if (!hadFinal) {
    if (existsSync(finalPath)) rmSync(finalPath, { force: true });
  } else {
    throw new Error(`backup missing for ${finalPath}`);
  }
}

function restore_dir_from_backup(finalPath: string, backupPath: string, hadFinal: boolean): void {
  if (existsSync(backupPath)) {
    if (existsSync(finalPath)) rmSync(finalPath, { recursive: true, force: true });
    renameSync(backupPath, finalPath);
  } else if (!hadFinal) {
    if (existsSync(finalPath)) rmSync(finalPath, { recursive: true, force: true });
  } else {
    throw new Error(`backup missing for ${finalPath}`);
  }
}

function restore_promoted_bundle(state: {
  final_manifest: string;
  final_bundle_dir: string;
  backup_manifest: string;
  backup_bundle_dir: string;
  had_final_manifest: boolean;
  had_final_bundle: boolean;
}): void {
  restore_file_from_backup(state.final_manifest, state.backup_manifest, state.had_final_manifest);
  restore_dir_from_backup(state.final_bundle_dir, state.backup_bundle_dir, state.had_final_bundle);
}

function promote_archive_bundle(
  changeRoot: string,
  runId: string,
  stagedManifestPath: string,
  stagedBundleDir: string,
): {
  staging_root: string;
  final_manifest: string;
  final_bundle_dir: string;
  backup_manifest: string;
  backup_bundle_dir: string;
  had_final_manifest: boolean;
  had_final_bundle: boolean;
} {
  const finalManifest = archive_manifest_path(changeRoot);
  const finalBundleDir = archive_preservation_dir(changeRoot);
  const stagingRoot = archive_staging_root(changeRoot, runId);
  const backupRoot = join(stagingRoot, "backup");
  const backupManifest = join(backupRoot, "archive-preservation.json");
  const backupBundleDir = join(backupRoot, "superspec-preservation");
  const hadFinalManifest = existsSync(finalManifest);
  const hadFinalBundle = existsSync(finalBundleDir);
  const state = {
    staging_root: stagingRoot,
    final_manifest: finalManifest,
    final_bundle_dir: finalBundleDir,
    backup_manifest: backupManifest,
    backup_bundle_dir: backupBundleDir,
    had_final_manifest: hadFinalManifest,
    had_final_bundle: hadFinalBundle,
  };
  mkdirSync(backupRoot, { recursive: true });
  try {
    if (hadFinalBundle) {
      renameSync(finalBundleDir, backupBundleDir);
      fsync_dir_best_effort(changeRoot);
    }
    if (hadFinalManifest) {
      mkdirSync(dirname(backupManifest), { recursive: true });
      renameSync(finalManifest, backupManifest);
      fsync_dir_best_effort(dirname(finalManifest));
    }
    renameSync(stagedBundleDir, finalBundleDir);
    fsync_dir_best_effort(changeRoot);
    if (typeof runtime.after_archive_bundle_promote === "function") {
      runtime.after_archive_bundle_promote({
        change_root: changeRoot,
        final_bundle_dir: finalBundleDir,
        final_manifest: finalManifest,
      });
    }
    mkdirSync(dirname(finalManifest), { recursive: true });
    renameSync(stagedManifestPath, finalManifest);
    fsync_dir_best_effort(dirname(finalManifest));
    return state;
  } catch (err) {
    try {
      restore_promoted_bundle(state);
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch (restoreErr) {
      throw new Error(
        `archive preservation promote failed: ${(err as Error).message}; rollback failed: ${(restoreErr as Error).message}`,
      );
    }
    throw err;
  }
}

export function begin_archive_preservation_bundle(
  change: string,
  changeRoot: string,
  opts: { file_overrides?: Record<string, string> } = {},
): { manifest_path: string; bundle_manifest_path: string; commit: () => void; rollback: () => void } {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const staged = stage_archive_bundle(change, changeRoot, runId, opts.file_overrides ?? {});
  const promotion = promote_archive_bundle(changeRoot, runId, staged.staged_manifest_path, staged.staged_bundle_dir);
  let settled = false;
  return {
    manifest_path: archive_manifest_path(changeRoot),
    bundle_manifest_path: archive_preservation_manifest_path(changeRoot),
    commit: (): void => {
      if (settled) return;
      settled = true;
      try {
        rmSync(promotion.staging_root, { recursive: true, force: true });
      } catch {
        // Commit is already durable; staging cleanup is best-effort.
      }
    },
    rollback: (): void => {
      if (settled) return;
      restore_promoted_bundle(promotion);
      rmSync(promotion.staging_root, { recursive: true, force: true });
      settled = true;
    },
  };
}

export function write_archive_preservation_bundle(
  change: string,
  changeRoot: string,
  opts: { file_overrides?: Record<string, string> } = {},
): string {
  const txn = begin_archive_preservation_bundle(change, changeRoot, opts);
  txn.commit();
  return txn.bundle_manifest_path;
}

export function find_archived_change(repoRoot: string, change: string): string | null {
  const archiveRoot = join(repoRoot, "openspec", "changes", "archive");
  if (!existsSync(archiveRoot) || !lstatSync(archiveRoot).isDirectory()) return null;
  const candidates = readdirSync(archiveRoot)
    .filter((name) => name === change || (/^\d{4}-\d{2}-\d{2}-.+/.test(name) && name.slice(11) === change))
    .map((name) => join(archiveRoot, name))
    .filter((item) => {
      const stat = lstatSync(item);
      return !stat.isSymbolicLink() && stat.isDirectory();
    })
    .sort();
  return candidates.at(-1) ?? null;
}

function manifest_change_id_reasons(change: string, manifest: JsonMap, label: string): Reason[] {
  if (manifest.change_id !== change) {
    return [reason("archive_manifest_mismatch", `${label} manifest change_id=${repr(manifest.change_id)} does not match ${repr(change)}`)];
  }
  return [];
}

const PRIMARY_ARCHIVE_MANIFEST_KIND = "superspec_archive_preservation";
const FALLBACK_ARCHIVE_MANIFEST_KIND = "superspec_archive_preservation_bundle";
const REQUIRED_ARCHIVE_ENTRIES = [".superspec/ledger.jsonl", ".superspec/superspec-state.json"] as const;

function manifest_shape_reasons(change: string, manifest: JsonMap, label: string, expectedKind: string): Reason[] {
  const reasons = manifest_change_id_reasons(change, manifest, label);
  if (manifest.kind !== expectedKind) {
    reasons.push(reason("archive_manifest_mismatch", `${label} manifest kind=${repr(manifest.kind)} does not match ${repr(expectedKind)}`));
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    reasons.push(reason("archive_manifest_mismatch", `${label} manifest entries must be a non-empty list`));
    return reasons;
  }
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      reasons.push(reason("archive_manifest_mismatch", `${label} manifest entries must be objects`));
      continue;
    }
    if (typeof entry.path === "string") paths.add(entry.path);
  }
  const missingRequired = REQUIRED_ARCHIVE_ENTRIES.filter((entry) => !paths.has(entry));
  if (missingRequired.length > 0) {
    reasons.push(reason("archive_manifest_mismatch", `${label} manifest missing required entries: ${renderList([...missingRequired])}`, [...missingRequired]));
  }
  return reasons;
}

function manifest_entry_target(baseRoot: string, relPath: string): string | null {
  if (!relPath.startsWith(".superspec/")) return null;
  return safe_within(baseRoot, relPath);
}

function preserved_file_sha(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return null;
  return sha256_file(filePath);
}

export function check_archived(change: string, repoRoot: string): Decision {
  const archived = find_archived_change(repoRoot, change);
  if (archived === null) return block(change, "archived", [reason("archive_not_found", `archived change not found for ${change}`)]);
  const manifestPath = archive_manifest_path(archived);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    const fallbackManifest = archive_preservation_manifest_path(archived);
    if (!existsSync(fallbackManifest) || !statSync(fallbackManifest).isFile()) {
      return block(change, "archived", [reason("superspec_not_preserved", "archive preservation manifest missing")]);
    }
    return check_archived_preservation_bundle(change, archived, fallbackManifest);
  }
  let manifest: JsonMap;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return block(change, "archived", [reason("superspec_not_preserved", "archive preservation manifest is invalid JSON")]);
  }
  const shapeReasons = manifest_shape_reasons(change, manifest, "archive preservation", PRIMARY_ARCHIVE_MANIFEST_KIND);
  if (shapeReasons.length > 0) return block(change, "archived", shapeReasons);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const invalid: string[] = [];
  for (const entry of manifest.entries) {
    const relPath = entry.path;
    const expected = entry.sha256;
    if (typeof relPath !== "string" || typeof expected !== "string") {
      mismatched.push(String(relPath));
      continue;
    }
    const filePath = manifest_entry_target(archived, relPath);
    if (filePath === null) {
      invalid.push(relPath);
      continue;
    }
    const actual = preserved_file_sha(filePath);
    if (actual === null) missing.push(relPath);
    else if (actual !== expected) mismatched.push(relPath);
  }
  const reasons: Reason[] = [];
  if (invalid.length > 0) reasons.push(reason("archive_manifest_mismatch", `archived .superspec manifest paths are invalid: ${renderList(invalid.slice(0, 20))}`, invalid.slice(0, 20)));
  if (missing.length > 0) reasons.push(reason("superspec_not_preserved", `archived .superspec files missing: ${renderList(missing.slice(0, 20))}`));
  if (mismatched.length > 0) reasons.push(reason("archive_manifest_mismatch", `archived .superspec files changed: ${renderList(mismatched.slice(0, 20))}`));
  if (reasons.length > 0) return block(change, "archived", reasons);
  return allow(change, "archived", { gate_summary: { archive_root: archived, manifest_entries: (manifest.entries ?? []).length } });
}

export function check_archived_preservation_bundle(change: string, archived: string, manifestPath: string): Decision {
  let manifest: JsonMap;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return block(change, "archived", [reason("superspec_not_preserved", "fallback preservation manifest is invalid JSON")]);
  }
  const shapeReasons = manifest_shape_reasons(change, manifest, "fallback preservation", FALLBACK_ARCHIVE_MANIFEST_KIND);
  if (shapeReasons.length > 0) return block(change, "archived", shapeReasons);
  if (typeof manifest.files_root !== "string" || !manifest.files_root) {
    return block(change, "archived", [reason("archive_manifest_mismatch", "fallback preservation manifest requires files_root")]);
  }
  const filesRoot = safe_within(dirname(manifestPath), manifest.files_root);
  if (filesRoot === null || !existsSync(filesRoot) || !lstatSync(filesRoot).isDirectory()) {
    return block(change, "archived", [reason("archive_manifest_mismatch", `fallback preservation files_root is invalid: ${repr(manifest.files_root)}`)]);
  }
  const missing: string[] = [];
  const mismatched: string[] = [];
  const invalid: string[] = [];
  for (const entry of manifest.entries) {
    const relPath = entry.path;
    const expected = entry.sha256;
    if (typeof relPath !== "string" || typeof expected !== "string") {
      mismatched.push(String(relPath));
      continue;
    }
    const filePath = manifest_entry_target(filesRoot, relPath);
    if (filePath === null) {
      invalid.push(relPath);
      continue;
    }
    const actual = preserved_file_sha(filePath);
    if (actual === null) missing.push(relPath);
    else if (actual !== expected) mismatched.push(relPath);
  }
  const reasons: Reason[] = [];
  if (invalid.length > 0) reasons.push(reason("archive_manifest_mismatch", `fallback .superspec manifest paths are invalid: ${renderList(invalid.slice(0, 20))}`, invalid.slice(0, 20)));
  if (missing.length > 0) reasons.push(reason("superspec_not_preserved", `fallback .superspec files missing: ${renderList(missing.slice(0, 20))}`));
  if (mismatched.length > 0) reasons.push(reason("archive_manifest_mismatch", `fallback .superspec files changed: ${renderList(mismatched.slice(0, 20))}`));
  if (reasons.length > 0) return block(change, "archived", reasons);
  return allow(change, "archived", {
    gate_summary: {
      archive_root: archived,
      fallback_manifest: toPosix(relative(archived, manifestPath)),
      manifest_entries: (manifest.entries ?? []).length,
    },
  });
}

export function preset_upgrade_required(preset: string, changedPaths: string[], flags: JsonMap = {}): boolean {
  if (preset === "full") return false;
  if (preset === "hotfix") return changedPaths.length >= 3 || Boolean(flags.architecture) || Boolean(flags.schema) || Boolean(flags.public_api) || Boolean(flags.cross_module);
  if (preset === "tweak") return changedPaths.length >= 5 || Boolean(flags.cross_module) || Number(flags.new_tests ?? 0) >= 5 || Boolean(flags.config_key_add_remove);
  return true;
}

export function preset_upgrade_reasons(config: JsonMap, changedPaths: string[], humanConfirmed = false, flags: JsonMap = {}): Reason[] {
  const preset = String(config.preset ?? "full");
  if (!preset_upgrade_required(preset, changedPaths, flags)) return [];
  if (humanConfirmed) return [];
  return [reason("preset_upgrade_requires_human_confirmation", `preset ${repr(preset)} must upgrade to full before proceeding`)];
}

export function preset_upgrade_required_from_context(config: JsonMap, changedPaths: string[]): boolean {
  return preset_upgrade_required(String(config.preset ?? "full"), changedPaths);
}
