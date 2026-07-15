import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { sha256File, sha256Text } from "./store.ts";
import type { BoundarySnapshot, DirtyFileFingerprint } from "./types.ts";

const PROCESS_DOC_RE = /^(?:openspec\/changes\/[^/]+\/)?(?:proposal|design|tasks)\.md$/;
const PROCESS_ARTIFACT_RE = /^(?:openspec\/changes\/[^/]+\/)?\.superspec\/artifacts\/(?:discovery|test-contract)\.md$/;
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".json", ".kt", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql",
  ".swift", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);
const CODE_BASENAMES = new Set([
  "Dockerfile", "Makefile", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "tsconfig.json", "tsconfig.build.json", "eslint.config.js", "vite.config.ts", "webpack.config.js",
]);
const WALK_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".superspec", ".omx"]);

export interface GitHeadResult {
  head: string | null;
  reason: string;
}

export interface JavaAutoStageResult {
  status: "staged" | "skipped" | "failed";
  files: string[];
  reason?: string;
}

export function currentGitHead(projectRoot: string): GitHeadResult {
  try {
    const head = execFileSync("git", ["-C", projectRoot, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { head: head || null, reason: head ? "ok" : "empty_head" };
  } catch (err) {
    return {
      head: null,
      reason: err instanceof Error ? err.message : "git rev-parse failed",
    };
  }
}

export function normalizeGitPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/\\"/g, '"')
    : trimmed;
  const renamed = unquoted.includes(" -> ") ? unquoted.split(" -> ").pop() ?? unquoted : unquoted;
  return renamed.replace(/\\/g, "/");
}

export function gitLines(projectRoot: string, args: string[]): { ok: true; lines: string[] } | { ok: false; reason: string } {
  try {
    const output = execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      ok: true,
      lines: output.split("\n").map(line => normalizeGitPath(line)).filter(Boolean),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "git command failed" };
  }
}

function isProcessOrOrdinaryDoc(path: string): boolean {
  if (path.startsWith(".superspec/") || path.startsWith(".omx/")) return true;
  if (path.includes("/.superspec/") || path.includes("/.omx/")) return true;
  if (PROCESS_DOC_RE.test(path) || PROCESS_ARTIFACT_RE.test(path)) return true;
  return extname(path).toLowerCase() === ".md";
}

export function isCodeLikePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || isProcessOrOrdinaryDoc(normalized)) return false;
  const base = normalized.split("/").pop() ?? normalized;
  if (CODE_BASENAMES.has(base)) return true;
  return CODE_EXTENSIONS.has(extname(base).toLowerCase());
}

export function walkCodeFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkCodeFiles(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    const rel = full.slice(root.length + 1).replace(/\\/g, "/");
    if (isCodeLikePath(rel)) out.push(rel);
  }
  return out;
}

export function codeFileContentSha(projectRoot: string, path: string): string | null {
  try {
    const full = join(projectRoot, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return sha256Text(readlinkSync(full));
    return sha256File(full);
  } catch {
    return null;
  }
}

export function codeFileFingerprint(
  projectRoot: string,
  path: string,
  status: DirtyFileFingerprint["status"],
): DirtyFileFingerprint {
  if (status === "deleted") return { path, status, sha256: null };
  return { path, status, sha256: codeFileContentSha(projectRoot, path) ?? "sha256:missing" };
}

function unquoteGitPath(path: string): string {
  return path.trim().replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\/g, "/");
}

export function dirtyCodeFiles(projectRoot: string): { ok: true; files: DirtyFileFingerprint[] } | { ok: false; files: DirtyFileFingerprint[]; reason: string } {
  let output: string;
  try {
    output = execFileSync("git", ["-C", projectRoot, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    return {
      ok: false,
      files: [],
      reason: err instanceof Error ? err.message : "git status failed",
    };
  }

  const files: DirtyFileFingerprint[] = [];
  for (const rawLine of output.split("\n")) {
    if (!rawLine.trim()) continue;
    const statusCode = rawLine.slice(0, 2);
    const rawPath = rawLine.slice(3);
    if (statusCode.includes("R") && rawPath.includes(" -> ")) {
      const [oldRaw, newRaw] = rawPath.split(" -> ");
      const oldPath = unquoteGitPath(oldRaw);
      const newPath = unquoteGitPath(newRaw);
      if (isCodeLikePath(oldPath)) files.push(codeFileFingerprint(projectRoot, oldPath, "deleted"));
      if (isCodeLikePath(newPath)) files.push(codeFileFingerprint(projectRoot, newPath, "added"));
      continue;
    }
    const normalizedPath = unquoteGitPath(rawPath);
    if (!isCodeLikePath(normalizedPath)) continue;
    const deleted = statusCode.includes("D");
    const added = statusCode.includes("A") || statusCode === "??";
    files.push(codeFileFingerprint(projectRoot, normalizedPath, deleted ? "deleted" : added ? "added" : "modified"));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, files };
}

// 共享文件指纹原语：boundary_snapshot 与 code_state_check 的差异对比都走这里，
// 语义统一为「path 相同且 status、sha256 都一致才算未变化」，结果按路径字典序稳定输出。
export function diffFingerprints(left: DirtyFileFingerprint[], right: DirtyFileFingerprint[]): string[] {
  const leftMap = new Map(left.map(file => [file.path, file]));
  const rightMap = new Map(right.map(file => [file.path, file]));
  const changed: string[] = [];
  for (const path of new Set([...leftMap.keys(), ...rightMap.keys()])) {
    const before = leftMap.get(path);
    const after = rightMap.get(path);
    if (!before || !after || before.status !== after.status || before.sha256 !== after.sha256) {
      changed.push(path);
    }
  }
  return changed.sort();
}

export function dirtyCodePaths(projectRoot: string): { ok: true; paths: string[] } | { ok: false; paths: string[]; reason: string } {
  const dirty = dirtyCodeFiles(projectRoot);
  if (!dirty.ok) return { ok: false, paths: [], reason: dirty.reason };
  return { ok: true, paths: [...new Set(dirty.files.map(file => file.path))].sort() };
}

function isJavaTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return /(^|\/)src\/test\//i.test(normalized) ||
    /(?:Test|Tests|TestCase|IT|ITCase)\.java$/i.test(base);
}

/**
 * 仅暂存当前 task 启动后新生成的生产 Java 文件。
 * 不能安全归因的既有文件改动绝不自动 git add：它们可能包含用户或并行任务的未提交内容。
 * 测试源码和常见测试类命名会被排除；没有可用的启动边界或 Git 状态异常时，不影响任务完成。
 */
export function stageProductionJavaFilesSince(
  projectRoot: string,
  before: BoundarySnapshot | null,
): JavaAutoStageResult {
  if (!before) {
    return { status: "skipped", files: [], reason: "missing_task_start_boundary" };
  }
  const current = dirtyCodeFiles(projectRoot);
  if (!current.ok) {
    return { status: "failed", files: [], reason: current.reason };
  }

  const currentByPath = new Map(current.files.map(file => [file.path, file]));
  const beforeByPath = new Map(before.dirty_files.map(file => [file.path, file]));
  const files = diffFingerprints(before.dirty_files, current.files)
    .filter(path => path.toLowerCase().endsWith(".java"))
    .filter(path => !isJavaTestPath(path))
    // "added" 且 task-start 边界不存在，才是可归因于本任务的新生成文件。
    // 已有未跟踪文件或已有源码的任何修改一律不碰，避免把用户工作带入 index。
    .filter(path => !beforeByPath.has(path) && currentByPath.get(path)?.status === "added")
    .filter(path => currentByPath.get(path)?.status !== "deleted")
    .sort();
  if (files.length === 0) return { status: "skipped", files: [], reason: "no_changed_production_java" };

  try {
    execFileSync("git", ["-C", projectRoot, "add", "--", ...files], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { status: "staged", files };
  } catch (err) {
    return {
      status: "failed",
      files,
      reason: err instanceof Error ? err.message : "git add failed",
    };
  }
}

export function projectHasReadableDirectory(projectRoot: string): boolean {
  return existsSync(projectRoot) && statSync(projectRoot).isDirectory();
}
