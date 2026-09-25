/**
 * Judge-host registry. A judge runs an isolated model session whose final
 * answer is one JSON object: M2 semantic reviewers and the Probe AI simulated
 * user. Judges never see the Worker workspace.
 *
 * @typedef {object} JudgeRunner
 * @property {"reviewer"|"simulated_user"} role
 * @property {string} provider
 * @property {(request: { id?: string, turn?: number, model: string, reasoning: string, prompt: string, cwd?: string, tracePath: string, stderrPath: string }) => Promise<{ json: unknown, tracePath: string, stderrPath: string, attempts: number }>} run
 * @property {(signal?: string) => void} terminateAll
 *
 * @typedef {object} JudgeHost
 * @property {string} id
 * @property {string} adapter_version
 * @property {object[]} stale_temp_dir_rules
 * @property {(config: object) => JudgeRunner} createRunner
 * @property {(path: string) => import("../lib/trace.mjs").NormalizedTrace} parseTrace
 * @property {(tracePath: string) => string[]} sessionIds
 * @property {(tracePath: string, error: unknown) => string} failureDetail
 * @property {(trace: import("../lib/trace.mjs").NormalizedTrace) => object[]} usageObservations
 */

import { claudeJudgeHost } from "./claude.mjs";
import { codexJudgeHost } from "./codex.mjs";
import { ompJudgeHost } from "./omp.mjs";

export const DEFAULT_JUDGE_HOST_ID = "codex";

const JUDGE_HOSTS = new Map([
  [codexJudgeHost.id, codexJudgeHost],
  [claudeJudgeHost.id, claudeJudgeHost],
  [ompJudgeHost.id, ompJudgeHost],
]);

export function registeredJudgeHostIds() {
  return [...JUDGE_HOSTS.keys()].sort();
}

/**
 * @param {string} id
 * @returns {JudgeHost}
 */
export function getJudgeHost(id = DEFAULT_JUDGE_HOST_ID) {
  const host = JUDGE_HOSTS.get(id);
  if (!host) throw new Error(`unknown judge host: ${id}; registered judge hosts: ${registeredJudgeHostIds().join(", ")}`);
  return host;
}

/** Judge host that produced recorded reviews; M2 runs without host metadata used Codex. */
export function recordedJudgeHost(manifest) {
  return getJudgeHost(manifest?.judge_host?.id ?? DEFAULT_JUDGE_HOST_ID);
}

export function judgeIdentity(host) {
  return { id: host.id, adapter_version: host.adapter_version };
}
