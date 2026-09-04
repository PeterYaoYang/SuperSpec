#!/usr/bin/env node
// SuperSpec 流程引擎 — CLI 入口

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { installProject } from "./install.ts";
import { writeSnapshot } from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import { next as nextCmd } from "./next.ts";
import { proposeReady, commitTransition, transitionInit, transitionExplore, startApply, taskStart, taskComplete, reopen, reviewReady, accept } from "./transition.ts";
import type { State, TransitionResult } from "./types.ts";
import { recordJobSubmit, recordJobSubmitContent, recordUserDecision, recordUserDecisionContent, jobsList, jobsPacket } from "./record.ts";
import { recordTestRun, recordTestRunContent } from "./task.ts";
import { RecordInputDecodingError, decodeRecordInput } from "./record_input.ts";
import { probeOpenSpec, openspecStatus, changeRoot } from "./openspec.ts";
import { SUPERSPEC_VERSION } from "./version.ts";
import {
  DEFAULT_WORKFLOW_HOSTS,
  parseWorkflowHostsFlag,
  WorkflowConfigError,
  workflowHostsDeclared,
  workflowHostsForProject,
  workflowRiskForProject,
  type WorkflowHost,
} from "./workflow_config.ts";

const PACKAGE_NAME = "@peterxiaoyang/superspec";
const OPENSPEC_PACKAGE_NAME = "@fission-ai/openspec";
const OPENSPEC_REQUIRED_VERSION = "1.4.1";

// ===== 参数解析 =====

function parseArgs(argv: string[]): { command: string; subcommand?: string; opts: Record<string, string> } {
  const [command, subcommand, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
      opts[key] = val;
    }
  }
  // 如果 subcommand 以 -- 开头，说明没有 subcommand
  if (subcommand && subcommand.startsWith("--")) {
    Object.entries(parseFlags([subcommand, ...rest])).forEach(([k, v]) => { opts[k] = v; });
    return { command, opts };
  }
  return { command, subcommand, opts };
}

function parseFlags(args: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      opts[key] = val;
    }
  }
  return opts;
}

class StdinRecordInputError extends Error {
  constructor(flag: "--input" | "--report") {
    super(`${flag} - 需要通过 pipe 或重定向提供 JSON；不方便时请使用文件路径。`);
    this.name = "StdinRecordInputError";
  }
}

function readStdinRecordContent(flag: "--input" | "--report"): string {
  if (process.stdin.isTTY === true) {
    throw new StdinRecordInputError(flag);
  }
  return decodeRecordInput(readFileSync(0));
}

function transitionExitCode(result: TransitionResult): number {
  if (result.outcome === "blocked") return 0;
  return result.events_written === 0 ? 1 : 0;
}

function proposeReadyExitCode(result: TransitionResult): number {
  if (result.outcome === "blocked") return 0;
  return result.events_written === 0 && result.outcome === "advanced" && result.from_state === result.to_state ? 1 : 0;
}

function ensureWorkflowMode(projectRoot: string, _opts: Record<string, string>): boolean {
  try {
    workflowRiskForProject(projectRoot);
    return true;
  } catch (err) {
    console.error(err instanceof WorkflowConfigError ? err.message : String(err));
    return false;
  }
}

function parseVersion(version: string): { major: number; minor: number; patch: number; prerelease: string | null } | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a.localeCompare(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease == null) return 1;
  if (right.prerelease == null) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

function commandErrorMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const maybe = err as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
  const stderr = maybe.stderr ? Buffer.from(maybe.stderr).toString("utf8").trim() : "";
  const stdout = maybe.stdout ? Buffer.from(maybe.stdout).toString("utf8").trim() : "";
  return stderr || stdout || maybe.message || String(err);
}

type SelfUpdatePhase = "npm_view" | "global_install" | "version_check" | "version_mismatch" | "rerun" | "rerun_output";
type OpenSpecDependencyPhase = "version_check" | "global_install" | "version_mismatch";
type OpenSpecEnsureAction = "already_satisfied" | "installed" | "updated";

interface OpenSpecEnsureResult {
  package: string;
  required_version: string;
  before: string | null;
  after: string;
  action: OpenSpecEnsureAction;
}

class SelfUpdateError extends Error {
  readonly phase: SelfUpdatePhase;
  readonly latest: string | null;

  constructor(phase: SelfUpdatePhase, message: string, latest: string | null = null) {
    super(message);
    this.name = "SelfUpdateError";
    this.phase = phase;
    this.latest = latest;
  }
}

class OpenSpecDependencyError extends Error {
  readonly phase: OpenSpecDependencyPhase;
  readonly before: string | null;

  constructor(phase: OpenSpecDependencyPhase, message: string, before: string | null = null) {
    super(message);
    this.name = "OpenSpecDependencyError";
    this.phase = phase;
    this.before = before;
  }
}

function isTestMode(): boolean {
  return process.env.SUPERSPEC_TEST_MODE === "1" || process.env.NODE_ENV === "test";
}

function testEnv(name: string): string | undefined {
  return isTestMode() ? process.env[name] : undefined;
}

function runtimePlatform(): string {
  return testEnv("SUPERSPEC_TEST_PLATFORM") ?? process.platform;
}

function windowsAwareCommand(name: string): string {
  return runtimePlatform() === "win32" ? `${name}.cmd` : name;
}

function windowsCommandHost(): string {
  return testEnv("SUPERSPEC_TEST_CMD_EXE") ?? process.env.ComSpec ?? "cmd.exe";
}

function execFileTextSync(command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  if (runtimePlatform() !== "win32") return execFileSync(command, args, options);

  return execFileSync(windowsCommandHost(), ["/d", "/s", "/c", command, ...args], options);
}

function npmCommand(): string {
  return windowsAwareCommand("npm");
}

function superspecCommand(): string {
  return windowsAwareCommand("superspec");
}

function openspecCommand(): string {
  return windowsAwareCommand("openspec");
}

function selfUpdateError(phase: SelfUpdatePhase, err: unknown, latest: string | null = null): SelfUpdateError {
  return new SelfUpdateError(phase, commandErrorMessage(err), latest);
}

function attachSelfUpdateLatest(err: unknown, phase: SelfUpdatePhase, latest: string): SelfUpdateError {
  if (err instanceof SelfUpdateError) {
    return new SelfUpdateError(err.phase, err.message, err.latest ?? latest);
  }
  return selfUpdateError(phase, err, latest);
}

function selfUpdateFailurePayload(err: unknown): { ok: false; message: string; self_update: { updated: false; from: string; to: string | null; phase: SelfUpdatePhase | "unknown" } } {
  if (err instanceof SelfUpdateError) {
    return {
      ok: false,
      message: err.message,
      self_update: {
        updated: false,
        from: SUPERSPEC_VERSION,
        to: err.latest,
        phase: err.phase,
      },
    };
  }

  return {
    ok: false,
    message: commandErrorMessage(err),
    self_update: {
      updated: false,
      from: SUPERSPEC_VERSION,
      to: null,
      phase: "unknown",
    },
  };
}

function openSpecDependencyFailurePayload(err: OpenSpecDependencyError): {
  ok: false;
  message: string;
  openspec: {
    package: string;
    required_version: string;
    before: string | null;
    after: null;
    action: "failed";
    phase: OpenSpecDependencyPhase;
  };
} {
  return {
    ok: false,
    message: err.message,
    openspec: {
      package: OPENSPEC_PACKAGE_NAME,
      required_version: OPENSPEC_REQUIRED_VERSION,
      before: err.before,
      after: null,
      action: "failed",
      phase: err.phase,
    },
  };
}

function parseOpenSpecVersion(output: string): string | null {
  const match = output.trim().match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? null;
}

let openSpecVersionProbeCount = 0;

function mockedOpenSpecVersion(): string | undefined {
  const sequence = testEnv("SUPERSPEC_TEST_OPENSPEC_VERSION_SEQUENCE");
  if (sequence !== undefined) {
    const parts = sequence.split("|");
    const raw = parts[Math.min(openSpecVersionProbeCount, parts.length - 1)]?.trim() ?? "";
    openSpecVersionProbeCount += 1;
    if (/^(missing|error)$/i.test(raw)) throw new Error("openspec CLI 不可用");
    return raw;
  }

  const explicit = testEnv("SUPERSPEC_TEST_OPENSPEC_VERSION");
  if (explicit !== undefined) {
    if (/^(missing|error)$/i.test(explicit.trim())) throw new Error("openspec CLI 不可用");
    return explicit;
  }

  return isTestMode() ? OPENSPEC_REQUIRED_VERSION : undefined;
}

function pathOpenSpecVersion(): string {
  const mocked = mockedOpenSpecVersion();
  if (mocked !== undefined) {
    const parsed = parseOpenSpecVersion(mocked);
    if (!parsed) throw new Error(`无法解析 openspec --version 输出：${mocked}`);
    return parsed;
  }

  const output = execFileTextSync(openspecCommand(), ["--version"], {
    encoding: "utf8",
    env: process.env,
  });
  const parsed = parseOpenSpecVersion(output);
  if (!parsed) throw new Error(`无法解析 openspec --version 输出：${output.trim()}`);
  return parsed;
}

function installRequiredOpenSpecGlobal(before: string | null): void {
  const testError = testEnv("SUPERSPEC_TEST_OPENSPEC_INSTALL_ERROR");
  if (testError) throw new OpenSpecDependencyError("global_install", testError, before);
  if (testEnv("SUPERSPEC_TEST_SKIP_OPENSPEC_INSTALL") === "1") return;

  try {
    execFileTextSync(npmCommand(), ["install", "-g", `${OPENSPEC_PACKAGE_NAME}@${OPENSPEC_REQUIRED_VERSION}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new OpenSpecDependencyError(
      "global_install",
      `安装 OpenSpec ${OPENSPEC_REQUIRED_VERSION} 失败：${commandErrorMessage(err)}`,
      before,
    );
  }
}

function ensureOpenSpecCli(): OpenSpecEnsureResult {
  let before: string | null = null;
  try {
    before = pathOpenSpecVersion();
  } catch {
    before = null;
  }

  if (before === OPENSPEC_REQUIRED_VERSION) {
    return {
      package: OPENSPEC_PACKAGE_NAME,
      required_version: OPENSPEC_REQUIRED_VERSION,
      before,
      after: before,
      action: "already_satisfied",
    };
  }

  installRequiredOpenSpecGlobal(before);

  let after: string;
  try {
    after = pathOpenSpecVersion();
  } catch (err) {
    throw new OpenSpecDependencyError(
      "version_check",
      `安装后仍无法读取 openspec --version：${commandErrorMessage(err)}`,
      before,
    );
  }

  if (after !== OPENSPEC_REQUIRED_VERSION) {
    throw new OpenSpecDependencyError(
      "version_mismatch",
      `全局 openspec 版本仍为 ${after}，期望 ${OPENSPEC_REQUIRED_VERSION}。请检查 npm 全局 bin 是否在 PATH 前置。`,
      before,
    );
  }

  return {
    package: OPENSPEC_PACKAGE_NAME,
    required_version: OPENSPEC_REQUIRED_VERSION,
    before,
    after,
    action: before === null ? "installed" : "updated",
  };
}

function npmLatestVersion(): string {
  const testError = testEnv("SUPERSPEC_TEST_NPM_VIEW_ERROR");
  if (testError) throw new SelfUpdateError("npm_view", testError);
  const testLatest = testEnv("SUPERSPEC_TEST_LATEST_VERSION");
  if (testLatest) return testLatest;

  try {
    const output = execFileTextSync(npmCommand(), ["view", PACKAGE_NAME, "version"], { encoding: "utf8" });
    return output.trim().replace(/^"|"$/g, "");
  } catch (err) {
    throw selfUpdateError("npm_view", err);
  }
}

function installLatestGlobal(): void {
  const testError = testEnv("SUPERSPEC_TEST_GLOBAL_INSTALL_ERROR");
  if (testError) throw new SelfUpdateError("global_install", testError);
  if (testEnv("SUPERSPEC_TEST_SKIP_GLOBAL_INSTALL") === "1") return;

  try {
    execFileTextSync(npmCommand(), ["install", "-g", `${PACKAGE_NAME}@latest`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw selfUpdateError("global_install", err);
  }
}

function parseSuperSpecVersion(output: string): string | null {
  const match = output.trim().match(/^SuperSpec\s+(.+)$/);
  return match?.[1]?.trim() ?? null;
}

function pathCliVersion(): string {
  const testError = testEnv("SUPERSPEC_TEST_CLI_VERSION_ERROR");
  if (testError) throw new Error(testError);
  const testVersion = testEnv("SUPERSPEC_TEST_CLI_VERSION");
  if (testVersion) return testVersion;
  const testOutput = testEnv("SUPERSPEC_TEST_CLI_VERSION_OUTPUT");
  if (testOutput) {
    const parsed = parseSuperSpecVersion(testOutput);
    if (!parsed) throw new Error(`无法解析 superspec --version 输出：${testOutput}`);
    return parsed;
  }

  const output = execFileTextSync(superspecCommand(), ["--version"], {
    encoding: "utf8",
    env: process.env,
  });
  const parsed = parseSuperSpecVersion(output);
  if (!parsed) throw new Error(`无法解析 superspec --version 输出：${output.trim()}`);
  return parsed;
}

function assertUpdatedCliVersion(latest: string): void {
  let actual: string;
  try {
    actual = pathCliVersion();
  } catch (err) {
    throw selfUpdateError("version_check", err, latest);
  }
  if (actual !== latest) {
    throw new SelfUpdateError(
      "version_mismatch",
      `全局 superspec 版本仍为 ${actual}，期望 ${latest}。请检查 npm 全局 bin 是否在 PATH 前置。`,
      latest,
    );
  }
}

function rerunUpdatedCli(projectRoot: string, args: string[]): string {
  const testError = testEnv("SUPERSPEC_TEST_RERUN_ERROR");
  if (testError) throw new SelfUpdateError("rerun", testError);
  const testOutput = testEnv("SUPERSPEC_TEST_RERUN_OUTPUT");
  if (testOutput) return testOutput;

  try {
    return execFileTextSync(superspecCommand(), args, {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
    });
  } catch (err) {
    throw selfUpdateError("rerun", err);
  }
}

function updateSelfIfNeeded(projectRoot: string, rerunArgs: string[]): { updated: false; latest: string } | { updated: true; latest: string; output: string } {
  const latest = npmLatestVersion();
  if (compareVersions(latest, SUPERSPEC_VERSION) <= 0) return { updated: false, latest };

  try {
    installLatestGlobal();
  } catch (err) {
    throw attachSelfUpdateLatest(err, "global_install", latest);
  }
  assertUpdatedCliVersion(latest);
  let output: string;
  try {
    output = rerunUpdatedCli(projectRoot, rerunArgs);
  } catch (err) {
    throw attachSelfUpdateLatest(err, "rerun", latest);
  }
  return {
    updated: true,
    latest,
    output,
  };
}

function updatedCliOutput(output: string, latest: string): { exitCode: number; text: string } {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("新版 CLI 输出不是 JSON object");
    }
    const payload = {
      ...parsed,
      self_update: {
        updated: true,
        from: SUPERSPEC_VERSION,
        to: latest,
      },
    };
    return {
      exitCode: (payload as { ok?: unknown }).ok === false ? 1 : 0,
      text: JSON.stringify(payload, null, 2),
    };
  } catch {
    const failure = new SelfUpdateError("rerun_output", "新版 CLI 输出不是 JSON object", latest);
    return {
      exitCode: 1,
      text: JSON.stringify(selfUpdateFailurePayload(failure), null, 2),
    };
  }
}

async function askToUpdateSelfIfNeeded(projectRoot: string, rerunArgs: string[]): Promise<{ updated: false; latest: string | null } | { updated: true; latest: string; output: string }> {
  const assumeTty = testEnv("SUPERSPEC_TEST_ASSUME_TTY") === "1";
  if (!assumeTty && (!process.stdin.isTTY || !process.stdout.isTTY)) return { updated: false, latest: null };

  let latest: string;
  try {
    latest = npmLatestVersion();
  } catch (err) {
    console.error(`SuperSpec 检查最新版本失败：${commandErrorMessage(err)}。继续使用当前版本。`);
    return { updated: false, latest: null };
  }
  if (compareVersions(latest, SUPERSPEC_VERSION) <= 0) return { updated: false, latest };

  const testAnswer = testEnv("SUPERSPEC_TEST_PROMPT_ANSWER");
  if (testAnswer !== undefined) {
    if (/^n(o)?$/i.test(testAnswer.trim())) return { updated: false, latest };
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`发现 SuperSpec ${latest} 可用，当前为 ${SUPERSPEC_VERSION}。是否先升级再继续？ [Y/n] `);
      if (/^n(o)?$/i.test(answer.trim())) return { updated: false, latest };
    } finally {
      rl.close();
    }
  }

  try {
    installLatestGlobal();
  } catch (err) {
    throw attachSelfUpdateLatest(err, "global_install", latest);
  }
  assertUpdatedCliVersion(latest);
  try {
    return {
      updated: true,
      latest,
      output: rerunUpdatedCli(projectRoot, rerunArgs),
    };
  } catch (err) {
    throw attachSelfUpdateLatest(err, "rerun", latest);
  }
}

function parseSelectedHosts(raw: string | undefined): WorkflowHost[] {
  if (!raw) return DEFAULT_WORKFLOW_HOSTS;
  return parseWorkflowHostsFlag(raw);
}

function parseHostPromptAnswer(raw: string): WorkflowHost[] {
  const tokens = raw.toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (tokens.length === 0) return DEFAULT_WORKFLOW_HOSTS;
  const selected: WorkflowHost[] = [];
  for (const token of tokens) {
    if (token === "1" || token === "codex") selected.push("codex");
    else if (token === "2" || token === "omp") selected.push("omp");
    else if (token === "both" || token === "all") selected.push("codex", "omp");
    else throw new WorkflowConfigError(`无法识别的宿主选项：${token}。可用 1/codex、2/omp，或 both`);
  }
  return parseWorkflowHostsFlag(selected.join(","));
}

async function resolveInstallHosts(projectRoot: string, opts: Record<string, string>, mode: "install" | "update"): Promise<WorkflowHost[]> {
  if (opts.hosts) return parseSelectedHosts(opts.hosts);
  if (mode === "update" || workflowHostsDeclared(projectRoot)) return workflowHostsForProject(projectRoot);

  const assumeTty = testEnv("SUPERSPEC_TEST_ASSUME_TTY") === "1";
  if (!assumeTty && (!process.stdin.isTTY || !process.stdout.isTTY)) return DEFAULT_WORKFLOW_HOSTS;

  const testAnswer = testEnv("SUPERSPEC_TEST_HOSTS_ANSWER");
  if (testAnswer !== undefined) return parseHostPromptAnswer(testAnswer);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("选择 SuperSpec 入口宿主：1) Codex  2) OMP。可多选，例如 1,2；直接回车默认 Codex。 ");
    return parseHostPromptAnswer(answer);
  } finally {
    rl.close();
  }
}

function installOptionsFromCli(opts: Record<string, string>, hosts: WorkflowHost[], allowLegacyState = false) {
  return {
    hosts,
    allowLegacyState,
    ...(opts["omp-home"] ? { ompHome: opts["omp-home"] } : {}),
  };
}

// ===== 初始化 transition init =====

// ===== init/explore 现在在 transition.ts 中（走统一锁内路径）=====

// ===== 主分发 =====

function topLevelHelp(): string {
  return `SuperSpec 流程引擎 ${SUPERSPEC_VERSION}

用法：superspec <命令> [选项]

命令：
  status --change <C>              查看状态
  transition <子命令> --change <C>  状态流转（见下）
  record <子命令> --change <C>      登记证据（见下）
  jobs <子命令> --change <C>        工作项管理（见下）
  install [--hosts codex,omp]       安装项目工作流入口
  init --scope project              install 的兼容别名
  update [--hosts codex,omp]        升级 CLI 到 npm latest 并同步已选宿主入口
  version                           版本号

工作流配置见 .superspec/config.json（workflow.mode、workflow.budget）。

transition 子命令：
  init / explore / sync / next / propose-ready / start-apply
  task-start --task <T> / task-complete --task <T> [--input -]
  reopen --to explore|propose|apply --reason <TEXT>
  reopen --to apply --reason <TEXT> [--review-fix <JOB#FINDING>|--self-test-fix <TASK>]
  reopen --to propose --reason <TEXT> [--review-finding <JOB#FINDING>]
  review-ready / accept

record 子命令：
  job-submit --job <J> --report <F|->
  user-decision --input <F|->
  test-run --input <F|->

jobs 子命令：
  list / packet --job <J>
`;
}

function commandHelp(command: string | undefined, subcommand: string | undefined): string {
  if (command === "record" && subcommand === "user-decision") {
    return `用法：superspec record user-decision --change <C> --input <F|->

从 JSON 文件读取用户决定；--input - 表示从 stdin 读取。
输入至少包含 scope 和 answer，工作流给出的 question 可一并保留。

示例：
  printf '%s' '{"scope":"<next 返回的 scope>","question":"<原问题>","answer":"<用户答复>"}' | superspec record user-decision --change <C> --input -
`;
  }
  if (command === "record" && subcommand === "job-submit") {
    return `用法：superspec record job-submit --change <C> --job <J> --report <F|->

提交 reviewer JSON 报告；--report - 表示从 stdin 读取。报告契约以 jobs packet 返回的 report_schema 为准。

示例：
  superspec jobs packet --change <C> --job <J>
  superspec record job-submit --change <C> --job <J> --report report.json
`;
  }
  if (command === "record" && subcommand === "test-run") {
    return `用法：superspec record test-run --change <C> --input <F|->

登记测试证据；--input - 表示从 stdin 读取。输入需包含 test_id、task_structure_digest、command、cwd、exit_code 和 semantic_status。

示例：
  printf '%s' '{"test_id":"TEST-001","task_structure_digest":"sha256:<digest>","command":"npm test","cwd":"<project>","exit_code":0,"semantic_status":"expected_success"}' | superspec record test-run --change <C> --input -
`;
  }
  if (command === "transition" && subcommand === "propose-ready") {
    return `用法：superspec transition propose-ready --change <C>

校验当前计划材料和审查门禁；满足条件时推进到 propose_ready。工作流模式来自项目配置，不接受 --risk。
`;
  }
  return topLevelHelp();
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.log(topLevelHelp());
    return 0;
  }

  // version
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    console.log(`SuperSpec ${SUPERSPEC_VERSION}`);
    return 0;
  }

  const { command, subcommand, opts } = parseArgs(argv);
  if (argv.includes("--help") || argv.includes("-h") || command === "--help" || command === "-h") {
    console.log(commandHelp(command, subcommand));
    return 0;
  }
  const projectRoot = process.cwd();

  // install / init / update 不需要 --change
  if (command === "install" || command === "init") {
    if (command === "init" && opts.scope && opts.scope !== "project") {
      console.log(JSON.stringify({
        ok: false,
        message: "当前 beta 只支持 init --scope project",
      }));
      return 1;
    }

    try {
      const hosts = await resolveInstallHosts(projectRoot, opts, "install");
      if (opts["skip-self-update"] !== "true") {
        const hostArgs = ["--hosts", hosts.join(",")];
        if (opts["omp-home"]) hostArgs.push("--omp-home", opts["omp-home"]);
        const rerunArgs = command === "init"
          ? ["init", "--scope", "project", "--skip-self-update", ...hostArgs]
          : ["install", "--skip-self-update", ...hostArgs];
        const selfUpdate = await askToUpdateSelfIfNeeded(projectRoot, rerunArgs);
        if (selfUpdate.updated) {
          const rerun = updatedCliOutput(selfUpdate.output, selfUpdate.latest);
          console.log(rerun.text);
          return rerun.exitCode;
        }
      }
      const openspec = ensureOpenSpecCli();
      console.log(JSON.stringify({
        ...installProject(projectRoot, installOptionsFromCli(opts, hosts)),
        openspec,
      }));
      return 0;
    } catch (err) {
      console.log(JSON.stringify(err instanceof SelfUpdateError
        ? selfUpdateFailurePayload(err)
        : err instanceof OpenSpecDependencyError
          ? openSpecDependencyFailurePayload(err)
          : err instanceof WorkflowConfigError
            ? { ok: false, message: err.message }
        : { ok: false, message: commandErrorMessage(err) }));
      return 1;
    }
  }
  if (command === "update") {
    try {
      const hosts = await resolveInstallHosts(projectRoot, opts, "update");
      if (opts["skip-self-update"] !== "true") {
        const hostArgs = ["--hosts", hosts.join(",")];
        if (opts["omp-home"]) hostArgs.push("--omp-home", opts["omp-home"]);
        const selfUpdate = updateSelfIfNeeded(projectRoot, ["update", "--skip-self-update", ...hostArgs]);
        if (selfUpdate.updated) {
          const rerun = updatedCliOutput(selfUpdate.output, selfUpdate.latest);
          console.log(rerun.text);
          return rerun.exitCode;
        }
      }
      const openspec = ensureOpenSpecCli();
      const result = installProject(projectRoot, installOptionsFromCli(opts, hosts, true));
      console.log(JSON.stringify({
        ...result,
        openspec,
        message: `SuperSpec ${SUPERSPEC_VERSION} 已更新项目工作流`,
      }));
      return 0;
    } catch (err) {
      console.log(JSON.stringify(err instanceof SelfUpdateError
        ? selfUpdateFailurePayload(err)
        : err instanceof OpenSpecDependencyError
          ? openSpecDependencyFailurePayload(err)
          : err instanceof WorkflowConfigError
            ? { ok: false, message: err.message }
        : { ok: false, message: commandErrorMessage(err) }));
      return 1;
    }
  }

  const change = opts.change;
  if (!change && command !== "status") {
    console.error("错误：缺少 --change（用 --help 查看用法）");
    return 1;
  }

  try {
    switch (command) {
      case "status": {
        if (!change) {
          // 全局 status
          const probe = probeOpenSpec(projectRoot);
          console.log(JSON.stringify({ openspec: probe }, null, 2));
          return 0;
        }
        const cr = changeRoot(projectRoot, change);
        const snapshot = rebuildSnapshot(projectRoot, change, cr);
        const jobs = jobsList(projectRoot, change);
        const staleAcceptedJobs = Math.max(0, jobs.accepted.length - snapshot.accepted_jobs.length);
        console.log(JSON.stringify({
          change,
          state: snapshot.state,
          open_jobs: snapshot.open_jobs.length,
          accepted_jobs: snapshot.accepted_jobs.length,
          historical_accepted_jobs: jobs.accepted.length,
          stale_accepted_jobs: staleAcceptedJobs,
          rejected_jobs: jobs.rejected.length,
          active_task_attempts: snapshot.active_task_attempts.map(a => ({
            attempt_id: a.attempt_id,
            task_id: a.task_id,
            state: a.state,
          })),
          document_digests: snapshot.document_digests,
          last_transition: snapshot.last_transition,
        }, null, 2));
        return 0;
      }

      case "transition": {
        const cr = changeRoot(projectRoot, change);
        // mode 只能由项目配置和已冻结 round 快照决定；任何 transition 都不接受 --risk。
        if (opts.risk !== undefined) {
          console.error("工作流模式由 .superspec/config.json 的 workflow.mode 控制，不支持 --risk");
          return 1;
        }

        switch (subcommand) {
          case "init":
            console.log(JSON.stringify(transitionInit(projectRoot, change, cr), null, 2));
            return 0;

          case "explore":
            {
              if (!ensureWorkflowMode(projectRoot, opts)) return 1;
              console.log(JSON.stringify(transitionExplore(projectRoot, change, cr), null, 2));
            }
            return 0;

          case "sync": {
            const snapshot = rebuildSnapshot(projectRoot, change, cr, openspecStatus(projectRoot, change));
            writeSnapshot(projectRoot, change, snapshot);
            console.log(JSON.stringify({
              ok: true,
              state: snapshot.state,
              message: "snapshot 已重建",
              stale_accepted_removed: 0, // sync 不报告具体移除（轻量）
            }, null, 2));
            return 0;
          }

          case "next": {
            if (!ensureWorkflowMode(projectRoot, opts)) return 1;
            const result = nextCmd(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return 0;
          }

          case "propose-ready": {
            if (!ensureWorkflowMode(projectRoot, opts)) return 1;
            const result = proposeReady(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return proposeReadyExitCode(result);
          }

          case "start-apply": {
            const result = startApply(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return transitionExitCode(result);
          }

          case "task-start": {
            const taskId = opts.task;
            if (!taskId) { console.error("task-start 需要 --task"); return 1; }
            const result = taskStart(projectRoot, change, cr, taskId);
            console.log(JSON.stringify(result, null, 2));
            return transitionExitCode(result);
          }

          case "task-complete": {
            const taskId = opts.task;
            if (!taskId) { console.error("task-complete 需要 --task"); return 1; }
            let inputContent: string | null = null;
            if (opts.input) {
              if (opts.input !== "-") {
                console.error("task-complete 只接受 --input -");
                return 1;
              }
              try {
                inputContent = readStdinRecordContent("--input");
              } catch (err) {
                if (err instanceof StdinRecordInputError || err instanceof RecordInputDecodingError) {
                  console.error(err.message);
                  return 1;
                }
                throw err;
              }
            }
            const result = taskComplete(projectRoot, change, cr, taskId, inputContent);
            console.log(JSON.stringify(result, null, 2));
            return transitionExitCode(result);
          }

          case "reopen": {
            const to = opts.to as State | undefined;
            const reason = opts.reason;
            if (!to) { console.error("reopen 需要 --to"); return 1; }
            if (!reason) { console.error("reopen 需要 --reason"); return 1; }
            const result = reopen(projectRoot, change, cr, to, reason, {
              ...(opts["review-fix"] ? { reviewFix: opts["review-fix"] } : {}),
              ...(opts["review-finding"] ? { reviewFinding: opts["review-finding"] } : {}),
              ...(opts["self-test-fix"] ? { selfTestFix: opts["self-test-fix"] } : {}),
            });
            console.log(JSON.stringify(result, null, 2));
            return transitionExitCode(result);
          }

          case "review-ready": {
            if (!ensureWorkflowMode(projectRoot, opts)) return 1;
            const result = reviewReady(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return transitionExitCode(result);
          }

          case "accept": {
            const result = accept(projectRoot, change, cr);
            console.log(JSON.stringify(result, null, 2));
            return transitionExitCode(result);
          }

          default:
            console.error(`未知的 transition 子命令：${subcommand}`);
            return 1;
        }
      }

      case "record": {
        const cr = changeRoot(projectRoot, change);

        switch (subcommand) {
          case "job-submit": {
            const jobId = opts.job;
            const report = opts.report;
            if (!jobId || !report) {
              console.error("record job-submit 需要 --job 和 --report");
              return 1;
            }
            let result;
            try {
              result = report === "-"
                ? recordJobSubmitContent(projectRoot, change, cr, jobId, readStdinRecordContent("--report"))
                : recordJobSubmit(projectRoot, change, cr, jobId, report);
            } catch (err) {
              if (err instanceof StdinRecordInputError || err instanceof RecordInputDecodingError) {
                console.error(err.message);
                return 1;
              }
              throw err;
            }
            console.log(JSON.stringify(result, null, 2));
            return result.accepted ? 0 : 1;
          }

          case "user-decision": {
            const inputFile = opts.input;
            if (!inputFile) {
              console.error("record user-decision 需要 --input");
              return 1;
            }
            let result;
            try {
              result = inputFile === "-"
                ? recordUserDecisionContent(projectRoot, change, readStdinRecordContent("--input"))
                : recordUserDecision(projectRoot, change, inputFile);
            } catch (err) {
              if (err instanceof StdinRecordInputError || err instanceof RecordInputDecodingError) {
                console.error(err.message);
                return 1;
              }
              throw err;
            }
            console.log(JSON.stringify(result, null, 2));
            return result.accepted ? 0 : 1;
          }

          case "test-run": {
            const inputFile = opts.input;
            if (!inputFile) { console.error("record test-run 需要 --input"); return 1; }
            let result;
            try {
              result = inputFile === "-"
                ? recordTestRunContent(projectRoot, change, readStdinRecordContent("--input"))
                : recordTestRun(projectRoot, change, inputFile);
            } catch (err) {
              if (err instanceof StdinRecordInputError || err instanceof RecordInputDecodingError) {
                console.error(err.message);
                return 1;
              }
              throw err;
            }
            console.log(JSON.stringify(result, null, 2));
            return result.accepted ? 0 : 1;
          }

          default:
            console.error(`未知的 record 子命令：${subcommand}`);
            return 1;
        }
      }

      case "jobs": {
        switch (subcommand) {
          case "list": {
            const result = jobsList(projectRoot, change);
            console.log(JSON.stringify(result, null, 2));
            return 0;
          }

          case "packet": {
            const jobId = opts.job;
            if (!jobId) { console.error("jobs packet 需要 --job"); return 1; }
            const result = jobsPacket(projectRoot, change, jobId);
            console.log(JSON.stringify(result, null, 2));
            return result.found ? 0 : 1;
          }

          default:
            console.error(`未知的 jobs 子命令：${subcommand}`);
            return 1;
        }
      }

      default:
        console.error(`未知命令：${command}。可用：status, transition, record, jobs, install, init, update, version`);
        return 1;
    }
  } catch (err) {
    console.error(`错误：${(err as Error).message}`);
    return 2;
  }
}

// 入口
main(process.argv.slice(2)).then(exitCode => process.exit(exitCode));
