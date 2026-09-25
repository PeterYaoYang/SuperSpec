/**
 * Evaluator provenance shared by Probe, Arena, M2 and M3.
 *
 * The evaluator source digest covers every entry point that can seal or grade a
 * run (probe, arena, m2) plus every module those entry points load: shared
 * libraries, worker-host adapters and judge adapters. Any change to them makes
 * existing seals report `evaluator_source_digest_match: false` and makes prior
 * regrades non-authoritative until they are rerun.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVALUATOR_ENTRY_POINTS = ["probe.mjs", "arena.mjs", "m2.mjs"];
const EVALUATOR_MODULE_DIRS = ["lib", "hosts", "judges"];

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** Evaluator source files relative to the eval root, in digest order. */
export function evaluatorSourceFiles(evalRoot = EVAL_ROOT) {
  const files = [...EVALUATOR_ENTRY_POINTS];
  for (const directory of EVALUATOR_MODULE_DIRS) {
    const absolute = join(evalRoot, directory);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute).filter(item => item.endsWith(".mjs")).sort()) files.push(`${directory}/${name}`);
  }
  return files;
}

export function currentEvaluatorDigest(evalRoot = EVAL_ROOT) {
  return sha256(JSON.stringify(Object.fromEntries(evaluatorSourceFiles(evalRoot)
    .map(path => [path, sha256(readFileSync(join(evalRoot, path)))]))));
}

/**
 * `.eval-runs/_recovered/` holds recovered, unsealed host session rollouts.
 * They are never Probe runs and must not be replayed, regraded or scanned.
 */
export function isRecoveredSessionPath(path, repoRoot = resolve(EVAL_ROOT, "..")) {
  const rel = relative(join(repoRoot, ".eval-runs", "_recovered"), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
