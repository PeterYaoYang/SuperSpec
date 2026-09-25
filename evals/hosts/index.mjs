/**
 * Worker-host registry. A worker host adapts one agent CLI (Codex, Claude Code,
 * OMP) to the Probe: how it is found, isolated, launched and resumed, and how
 * its session records become a NormalizedTrace (see ../lib/trace.mjs).
 *
 * @typedef {object} WorkerHost
 * @property {string} id
 * @property {string} adapter_version
 * @property {string} display_name
 * @property {string} executable                 Tool key of the host CLI in the resolved tool map.
 * @property {string} home_env_key               Environment variable naming the isolated host home.
 * @property {string[]} sensitive_env_keys       Host environment names the Worker must not read.
 * @property {string} command_evidence_source    Evidence label for a completed command record.
 * @property {boolean} commands_inherit_launch_cwd  Shell tool never records cwd and always runs in the Worker launch cwd.
 * @property {{ sandbox: string, approval: string }} launch_policy  Sandbox/approval posture recorded in the manifest.
 * @property {{ provider: string, model: string }} eval_defaults  Worker provider/model when the runner is given none.
 * @property {string[]} [workspace_noise_dirs]   Workspace directories the host CLI creates by itself; excluded from scope.
 * @property {object[]} stale_temp_dir_rules     Temp-dir name rules for the startup stale sweep.
 * @property {(lookup: (name: string) => string|null, options?: { injection?: string|null }) => Record<string, string|null>} resolveTools
 * @property {() => [string, string[]][]} versionProbes
 * @property {(provider: string, options?: object) => object} providerProfile
 * @property {(options: { runId: string, providerProfile: object, registry?: object }) => { home: string, hostHome: string, auth: object, tempDirs: string[] }} createIsolation
 * @property {(isolation: object) => void} assertIsolationReady
 * @property {(options: object) => Record<string, string>} controlledEnv
 * @property {(options: object) => object} controlManifest
 * @property {(options: object) => Promise<object>} negotiateFeatures
 * @property {(options: { isolation: object }) => string[]} installArgs  Extra `superspec install` flags selecting this host's entry points.
 * @property {(prompt: string) => string} translateWorkerPrompt  Rewrites scenario skill references into this host's invocation syntax.
 * @property {(options: object) => object} prepareWorkspace
 * @property {(options: object) => { args: string[], manifest: object }} launchFeatures
 * @property {(path: string) => boolean} isGuidanceFile
 * @property {(options: object) => string[]} freshLaunchArgs
 * @property {(options: object) => string[]} resumeLaunchArgs
 * @property {(isolation: object, sessionId: string) => object} sessionStorageEvidence
 * @property {string} sessionNotStoredMessage
 * @property {(paths: string|string[], options?: object) => import("../lib/trace.mjs").NormalizedTrace} parseTrace
 * @property {(records: unknown[], options?: object) => import("../lib/trace.mjs").NormalizedTrace} normalizeRecords
 * @property {(item: object, sourceShape?: string) => object} normalizeCommandItem
 * @property {(trace: import("../lib/trace.mjs").NormalizedTrace|null, options?: { sessionIndex?: object|null, window?: { started_at: string, ended_at: string|null }|null }) => object} independentAgentAudit
 * @property {(trace: import("../lib/trace.mjs").NormalizedTrace) => object[]} usageObservations
 * @property {(isolation: object, destDir: string) => object} collectSessionArtifacts
 */

import { claudeWorkerHost } from "./claude.mjs";
import { codexWorkerHost } from "./codex.mjs";
import { ompWorkerHost } from "./omp.mjs";

export const DEFAULT_WORKER_HOST_ID = "codex";

const WORKER_HOSTS = new Map([
  [codexWorkerHost.id, codexWorkerHost],
  [claudeWorkerHost.id, claudeWorkerHost],
  [ompWorkerHost.id, ompWorkerHost],
]);

export function registeredWorkerHostIds() {
  return [...WORKER_HOSTS.keys()].sort();
}

/** @param {"provider"|"model"} field */
export function workerHostDefaultsText(field) {
  return registeredWorkerHostIds().map(id => `${id}=${WORKER_HOSTS.get(id).eval_defaults[field]}`).join(", ");
}

/**
 * @param {string} id
 * @returns {WorkerHost}
 */
export function getWorkerHost(id = DEFAULT_WORKER_HOST_ID) {
  const host = WORKER_HOSTS.get(id);
  if (!host) throw new Error(`unknown worker host: ${id}; registered hosts: ${registeredWorkerHostIds().join(", ")}`);
  return host;
}

/** Host that produced a recorded run; runs recorded before host metadata existed are Codex runs. */
export function recordedWorkerHost(manifest) {
  return getWorkerHost(manifest?.host?.id ?? DEFAULT_WORKER_HOST_ID);
}

export function hostIdentity(host) {
  return { id: host.id, adapter_version: host.adapter_version };
}
