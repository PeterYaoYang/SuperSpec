// 计划材料快照：审查工作项按内容指纹保存材料正文，后续复审据此计算相对已通过基线的差异。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeDir, listMarkdownFiles, sha256File } from "./store.ts";
import type { Job, MaterialDeltaEntry, MaterialFileRef } from "./types.ts";

const MISSING_SHA = "sha256:missing";
// 超过该长度的差异不再内联，审查者改为完整阅读该文件
const MAX_DIFF_CHARS = 60_000;

function blobPath(projectRoot: string, change: string, sha: string): string {
  return join(changeDir(projectRoot, change), "material-blobs", `${sha.replace(/^sha256:/, "")}.md`);
}

/** 绑定路径展开为逐文件指纹；以 / 结尾的目录绑定展开为其中的 .md 文件，与目录聚合指纹同口径。 */
export function materialManifest(changeRoot: string, boundPaths: string[]): MaterialFileRef[] {
  const files: MaterialFileRef[] = [];
  for (const path of boundPaths) {
    if (path.endsWith("/")) {
      for (const rel of listMarkdownFiles(join(changeRoot, path))) {
        const filePath = `${path}${rel}`;
        files.push({ path: filePath, sha: sha256File(join(changeRoot, filePath)) ?? MISSING_SHA });
      }
    } else {
      files.push({ path, sha: sha256File(join(changeRoot, path)) ?? MISSING_SHA });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** 只保存内容与清单指纹一致的正文：读取时文件已被改动则跳过，差异计算会退回完整审查。 */
export function storeMaterialBlobs(projectRoot: string, change: string, changeRoot: string, manifest: MaterialFileRef[]): void {
  for (const file of manifest) {
    if (file.sha === MISSING_SHA) continue;
    const target = blobPath(projectRoot, change, file.sha);
    if (existsSync(target)) continue;
    let content: Buffer;
    try {
      content = readFileSync(join(changeRoot, file.path));
    } catch {
      continue;
    }
    if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== file.sha) continue;
    mkdirSync(join(changeDir(projectRoot, change), "material-blobs"), { recursive: true });
    writeFileSync(target, content);
  }
}

function boundPathCovers(boundPath: string, filePath: string): boolean {
  return boundPath.endsWith("/") ? filePath.startsWith(boundPath) : filePath === boundPath;
}

/** 相对 review_baseline 内容完全未变的绑定路径；没有基线时为空集合。 */
export function baselineUnchangedBoundPaths(job: Job): Set<string> {
  const unchanged = new Set<string>();
  if (!job.review_baseline || !job.material_manifest) return unchanged;
  const before = new Map(job.review_baseline.material_manifest.map(file => [file.path, file.sha]));
  const after = new Map(job.material_manifest.map(file => [file.path, file.sha]));
  for (const bound of job.boundFiles) {
    if (!bound.path.endsWith("/") && !before.has(bound.path)) continue;
    const paths = [...new Set([...before.keys(), ...after.keys()])].filter(path => boundPathCovers(bound.path, path));
    if (paths.every(path => before.get(path) === after.get(path))) unchanged.add(bound.path);
  }
  return unchanged;
}

function unifiedDiff(oldFile: string, newFile: string, path: string): { diff?: string; diff_unavailable?: string } {
  const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--unified=3", "--", oldFile, newFile], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return { diff_unavailable: `差异生成失败：${result.error?.message ?? result.stderr.trim()}` };
  }
  const body = result.stdout.split("\n").filter(line =>
    !line.startsWith("diff --git ") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ ")
  );
  const diff = [`--- a/${path}`, `+++ b/${path}`, ...body].join("\n").trimEnd();
  if (diff.length > MAX_DIFF_CHARS) return { diff_unavailable: `差异超过 ${MAX_DIFF_CHARS} 字符，请完整阅读该文件` };
  return { diff };
}

/** 本工作项材料相对 review_baseline 的逐文件变化；新增文件不附差异，需要完整阅读。 */
export function materialDelta(projectRoot: string, change: string, job: Job): MaterialDeltaEntry[] {
  if (!job.review_baseline || !job.material_manifest) return [];
  const before = new Map(job.review_baseline.material_manifest.map(file => [file.path, file.sha]));
  const after = new Map(job.material_manifest.map(file => [file.path, file.sha]));
  const entries: MaterialDeltaEntry[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldSha = before.get(path);
    const newSha = after.get(path);
    if (oldSha === newSha) continue;
    if (!oldSha || oldSha === MISSING_SHA) {
      entries.push({ path, status: "added" });
      continue;
    }
    if (!newSha || newSha === MISSING_SHA) {
      entries.push({ path, status: "removed" });
      continue;
    }
    const oldBlob = blobPath(projectRoot, change, oldSha);
    const newBlob = blobPath(projectRoot, change, newSha);
    if (!existsSync(oldBlob) || !existsSync(newBlob)) {
      entries.push({ path, status: "modified", diff_unavailable: "缺少材料快照，请完整阅读该文件" });
      continue;
    }
    entries.push({ path, status: "modified", ...unifiedDiff(oldBlob, newBlob, path) });
  }
  return entries;
}
