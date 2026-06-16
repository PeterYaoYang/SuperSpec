import {
  block,
  commandExists,
  GuardError,
  printDecision,
  reason,
  runCommand,
  openspec_cli_probe,
  parseDecisionOutputFormat,
  REQUIRED_OPENSPEC_MIN_VERSION,
  type DecisionOutputFormat,
  type JsonMap,
  type OpenspecCliProbe,
} from "./core.ts";
import { forced_openspec_install_plan, project_init, recommended_openspec_install_plan } from "./project_init.ts";
import { install_workflow, uninstall_workflow, update_workflow, type EngineAction, type EngineResult, type InstallScope } from "./install_engine.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { action_detail_zh, action_status_zh, reason_message_zh, system_failure_zh } from "./i18n.ts";

type InitArgs = {
  path: string;
  codexHome: string;
  mode: "install" | "update" | "uninstall";
  scope: InstallScope | null;
  format: DecisionOutputFormat;
  dryRun: boolean;
  force: boolean;
};

function usage(): string {
  return "usage: superspec init [-h] [--scope {project,user}] [--path PATH] [--codex-home PATH] [--format {json,agent,user}] [--create] [--update] [--uninstall] [--dry-run] [--force]\n";
}

function help(): string {
  return `${usage()}\n可选参数：\n  -h, --help             显示帮助并退出\n  --scope {project,user} 安装到当前项目的 .codex 目录，或安装到用户级 Codex 目录（默认：project）\n  --project              等价于 --scope project\n  --user                 等价于 --scope user\n  --global               兼容别名，等价于 --user\n  --path PATH            --scope project 时使用的项目根目录（默认：当前目录）\n  --codex-home PATH      --scope user 时使用的 Codex 用户目录（默认：$CODEX_HOME 或 ~/.codex）\n  --format {json,agent,user} 输出格式（默认：user）；json 用于诊断或自动化，agent 用于工作流消费\n  --user-facing          等价于 --format user\n  --create               兼容参数；init 默认就会创建缺失内容\n  --update               按 manifest 更新 SuperSpec 管理的文件；用户改动文件保留，新的版本写入 *.new\n  --uninstall            按 manifest 卸载 SuperSpec 管理的文件；.superspec 数据与既有/用户改动文件会保留\n  --dry-run              配合 --uninstall 时只预览将删除的文件，不实际修改\n  --force                安装时覆盖已有且内容不同的文件，并保留 *.bak 备份\n`;
}

function requestedOutputFormat(argv: string[]): DecisionOutputFormat | null {
  if (argv.includes("--user-facing")) return "user";
  let selected: string | null = null;
  for (let idx = 0; idx < argv.length; idx += 1) {
    if (argv[idx] !== "--format") continue;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("--")) return null;
    selected = value;
  }
  if (selected === null) return null;
  try {
    return parseDecisionOutputFormat(selected);
  } catch {
    return null;
  }
}

function fallbackOutputFormat(argv: string[]): DecisionOutputFormat {
  return requestedOutputFormat(argv) ?? "user";
}

function parse_init_argv(argv: string[]): InitArgs {
  const getValues = (flag: string): string[] => {
    const values: string[] = [];
    for (let idx = 0; idx < argv.length; idx += 1) {
      if (argv[idx] !== flag) continue;
      const value = argv[idx + 1];
      if (value === undefined || value.startsWith("--")) throw new GuardError(`${flag} 缺少取值`);
      values.push(value);
    }
    return values;
  };
  const getValue = (flag: string): string | undefined => getValues(flag)[0];
  const update = argv.includes("--update");
  const uninstall = argv.includes("--uninstall");
  if (update && uninstall) throw new GuardError("--update 与 --uninstall 不能同时使用");
  const scopeFlag = getValue("--scope");
  if (scopeFlag !== undefined && !["project", "user", "global"].includes(scopeFlag)) throw new GuardError("--scope 只能是 project 或 user");
  const userShortcut = argv.includes("--user") || argv.includes("--global");
  if (userShortcut && argv.includes("--project")) throw new GuardError("--user/--global 与 --project 不能同时使用");
  let scope: InstallScope | null = scopeFlag === "global" ? "user" : (scopeFlag as InstallScope | undefined) ?? null;
  if (userShortcut) scope = "user";
  if (argv.includes("--project")) scope = "project";
  const formatValues = getValues("--format");
  for (const value of formatValues) parseDecisionOutputFormat(value);
  const selectedFormat = argv.includes("--user-facing")
    ? "user"
    : (formatValues.length > 0 ? formatValues[formatValues.length - 1] : "user");
  const format = parseDecisionOutputFormat(selectedFormat);
  return {
    path: resolve(getValue("--path") ?? process.cwd()),
    codexHome: resolve(getValue("--codex-home") ?? process.env.CODEX_HOME ?? joinHomeCodex()),
    mode: uninstall ? "uninstall" : update ? "update" : "install",
    scope,
    format,
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
  };
}

function joinHomeCodex(): string {
  return `${homedir()}/.codex`;
}

function scopeLabel(scope: InstallScope | undefined): string {
  return scope === "user" ? "用户级" : "项目级";
}

function modeLabel(mode: InitArgs["mode"] | undefined, dryRun: boolean | undefined): string {
  if (mode === "update") return "更新";
  if (mode === "uninstall") return dryRun ? "卸载预览" : "卸载";
  return "初始化";
}

function actionSummary(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return "";
  const counts = new Map<string, number>();
  for (const item of actions) {
    if (!item || typeof item !== "object") continue;
    const status = String((item as EngineAction).status ?? "");
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const changedOrder = ["created", "updated", "removed", "would_remove", "skipped", "failed"];
  const parts = changedOrder
    .map((status) => [status, counts.get(status) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${action_status_zh(status)} ${count} 项`);
  if (parts.length > 0) return parts.join("，");
  const okCount = counts.get("ok") ?? 0;
  return okCount > 0 ? `已检查 ${okCount} 项，无需改动` : "";
}

function actionTarget(action: string): string {
  const match = action.match(/^(?:install|update|uninstall(?: rmdir)?)\s+(.+)$/u);
  return match?.[1] ?? "";
}

function skippedActionNotes(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  const groups = new Map<string, { count: number; targets: string[] }>();
  for (const item of actions) {
    if (!item || typeof item !== "object") continue;
    const action = String((item as EngineAction).action ?? "");
    const status = String((item as EngineAction).status ?? "");
    if (status !== "skipped") continue;
    const detail = String((item as EngineAction).detail ?? "");
    const note = detail ? action_detail_zh(detail) : "有文件被保留未改动；需要完整列表时添加 --format json。";
    const target = actionTarget(action);
    const group = groups.get(note) ?? { count: 0, targets: [] };
    group.count += 1;
    if (target && group.targets.length < 3) group.targets.push(target);
    groups.set(note, group);
  }
  return [...groups.entries()].map(([note, group]) => {
    const hiddenCount = group.count - group.targets.length;
    if (group.targets.length === 0) return `${note}（${group.count} 项）`;
    const suffix = hiddenCount > 0 ? ` 等 ${group.count} 项` : "";
    return `${note}（${group.targets.join("，")}${suffix}）`;
  });
}

function knownInitProblemMessageZh(message: string): string | null {
  if (/install manifest missing; run superspec init before --update/iu.test(message)) {
    return "缺少安装清单；请先运行 superspec init，再执行 update。";
  }
  if (/install manifest missing; nothing to uninstall/iu.test(message)) {
    return "缺少安装清单；当前没有可卸载的 SuperSpec 管理文件。";
  }
  return null;
}

function reasonTextZh(item: JsonMap): string {
  const code = String(item.code ?? "");
  const message = String(item.message ?? "");
  const refs = Array.isArray(item.refs) ? item.refs.map((ref: unknown) => String(ref)) : [];
  return knownInitProblemMessageZh(message) ?? reason_message_zh(code, message, refs);
}

function renderInitUserDecision(decision: JsonMap, opts: { mode?: InitArgs["mode"]; scope?: InstallScope; targetRoot?: string; dryRun?: boolean } = {}): string {
  const lines: string[] = [];
  const op = modeLabel(opts.mode, opts.dryRun);
  lines.push(`SuperSpec ${op}${decision.allowed ? "完成" : "未完成"}。`);
  lines.push(`范围：${scopeLabel(opts.scope)}。`);
  const root = opts.targetRoot ?? String(decision.install_root ?? decision.project_root ?? "");
  if (root) lines.push(`位置：${root}`);

  const summary = actionSummary(decision.actions);
  if (decision.allowed && summary) lines.push(`处理：${summary}。`);

  const skippedNotes = skippedActionNotes(decision.actions);
  if (decision.allowed && skippedNotes.length > 0) {
    lines.push("跳过项：");
    for (const note of skippedNotes) lines.push(`- ${note}`);
  }

  const reasons = Array.isArray(decision.block_reasons) ? decision.block_reasons : [];
  if (!decision.allowed && reasons.length > 0) {
    lines.push("原因：");
    for (const item of reasons) lines.push(`- ${reasonTextZh(item as JsonMap)}`);
    lines.push("修正后重新运行同一命令；需要完整诊断时添加 --format json。");
  }

  return `${lines.join("\n")}\n`;
}

function printInitDecision(decision: JsonMap, opts: { command?: string; format: DecisionOutputFormat; mode?: InitArgs["mode"]; scope?: InstallScope; targetRoot?: string; dryRun?: boolean }): void {
  if (opts.format === "user") {
    process.stdout.write(renderInitUserDecision(decision, opts));
    return;
  }
  printDecision(decision, { command: opts.command ?? "init", format: opts.format });
}

function commandFailure(proc: { stdout: string; stderr: string; error?: Error; status: number | null }): string {
  const output = (proc.error?.message ?? (proc.stderr || proc.stdout)).trim();
  if (output) return system_failure_zh(output, `安装命令执行失败（退出状态码 ${proc.status ?? "未知"}）。`);
  if (proc.status !== null) return `安装命令执行失败（退出状态码 ${proc.status}）。`;
  return "安装命令执行失败，请查看终端日志后重试。";
}

function shouldRetryOpenSpecInstallWithForce(proc: { stdout: string; stderr: string; error?: Error }): boolean {
  const output = `${proc.error?.message ?? ""}\n${proc.stderr}\n${proc.stdout}`;
  const binConflict = /\bEEXIST\b|already exists|file exists|Refusing to delete|will not overwrite|would overwrite/iu.test(output);
  const openspecBin = /\bopenspec(?:\.(?:cmd|ps1))?\b/iu.test(output);
  return binConflict && openspecBin;
}

function engineDecision(gate: string, projectRoot: string, result: EngineResult, nextActions: string[]): { allowed: boolean; [key: string]: any } {
  if (result.problems.length > 0) {
    const decision = block("project", gate, result.problems.map((item) => reason(`${gate}_failed`, item)));
    return { ...decision, project_root: projectRoot, actions: result.actions, next_allowed_actions: [`fix ${gate}_failed reasons, then rerun`] };
  }
  return {
    allowed: true,
    decision: "allow",
    change_id: null,
    gate,
    project_root: projectRoot,
    actions: result.actions,
    block_reasons: [],
    next_allowed_actions: nextActions,
    trust_warnings: [".superspec runtime data is never touched by install/update/uninstall; only manifest-managed files are"],
  };
}

async function promptInstallScope(): Promise<InstallScope> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question("请选择安装范围：project 还是 user？[project] ")).trim().toLowerCase();
      if (answer === "" || answer === "project" || answer === "p" || answer === "1" || answer === "项目") return "project";
      if (answer === "user" || answer === "u" || answer === "2" || answer === "global" || answer === "g" || answer === "用户") return "user";
      process.stderr.write("请输入 project 或 user。\n");
    }
  } finally {
    rl.close();
  }
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export function maybe_install_missing_openspec(opts: {
  cwd: string;
  scope: InstallScope;
  mode: InitArgs["mode"];
  interactive?: boolean;
  commandExistsFn?: (cmd: string, meta?: { cwd?: string }) => boolean;
  probeOpenspecFn?: (meta?: { cwd?: string }) => OpenspecCliProbe;
  run?: typeof runCommand;
  writeStderr?: (text: string) => void;
}): "not-needed" | "installed" | "skipped" | "failed" {
  const commandExistsFn = opts.commandExistsFn ?? ((cmd: string, meta?: { cwd?: string }) => commandExists(cmd, { cwd: meta?.cwd }));
  if (opts.mode !== "install") return "not-needed";
  const run = opts.run ?? runCommand;
  const probeOpenspecFn = opts.probeOpenspecFn ?? ((meta?: { cwd?: string }) => openspec_cli_probe({ cwd: meta?.cwd, commandExistsFn, run }));
  const before = probeOpenspecFn({ cwd: opts.cwd });
  if (before.ok) return "not-needed";

  const writeStderr = opts.writeStderr ?? ((text: string) => {
    process.stderr.write(text);
  });
  const plan = recommended_openspec_install_plan({ cwd: opts.cwd, commandExistsFn });
  if (plan === null) {
    writeStderr(`${before.message}。SuperSpec 需要 @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION}，但未找到 npm、pnpm、yarn 或 bun，无法自动安装。\n`);
    return "skipped";
  }

  writeStderr(`${before.message}。SuperSpec 需要 @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION}，将自动安装或升级。\n`);
  writeStderr(`正在安装 OpenSpec CLI：${plan.rendered}\n`);
  let proc = run(plan.cmd, plan.args, { cwd: opts.cwd, timeout: 300_000 });
  if ((proc.error || proc.status !== 0) && shouldRetryOpenSpecInstallWithForce(proc)) {
    const forcedPlan = forced_openspec_install_plan(plan);
    writeStderr(`OpenSpec CLI 安装遇到全局 bin 冲突，正在覆盖重试：${forcedPlan.rendered}\n`);
    proc = run(forcedPlan.cmd, forcedPlan.args, { cwd: opts.cwd, timeout: 300_000 });
  }
  if (proc.error || proc.status !== 0) {
    writeStderr(`自动安装 OpenSpec CLI 失败：${commandFailure(proc)}\n`);
    return "failed";
  }
  const after = probeOpenspecFn({ cwd: opts.cwd });
  if (!after.ok) {
    writeStderr(`安装命令已完成，但当前 PATH 里的 openspec 仍不可用：${after.message}。请重新打开终端或确认全局 bin 已在 PATH 中，然后重新运行 superspec init；Windows PowerShell 请运行 superspec.cmd init。\n`);
    return "failed";
  }
  writeStderr("OpenSpec CLI 安装或升级完成，继续执行 superspec init。\n");
  return "installed";
}

function openspecPreflightBlocked(args: InitArgs, scope: InstallScope, installResult: "skipped" | "failed"): number {
  const targetRoot = scope === "user" ? args.codexHome : args.path;
  const code = installResult === "skipped" ? "openspec_auto_install_unavailable" : "openspec_auto_install_failed";
  const message = installResult === "skipped"
    ? `OpenSpec CLI 不满足 SuperSpec 要求，且未找到可用包管理器自动安装 @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION}。`
    : `OpenSpec CLI 自动安装或升级 @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION} 未完成。`;
  const decision = block("project", "openspec_preflight", [reason(code, message)], {
    next_actions: [`install or upgrade @fission-ai/openspec >= ${REQUIRED_OPENSPEC_MIN_VERSION}, then rerun \`superspec init --scope ${scope}\``],
  });
  printInitDecision({
    ...decision,
    project_root: args.path,
    install_scope: scope,
    install_root: targetRoot,
  }, {
    command: "init",
    format: args.format,
    mode: args.mode,
    scope,
    targetRoot,
    dryRun: args.dryRun,
  });
  return 1;
}

function run_init(args: InitArgs, scope: InstallScope): number {
  const targetRoot = scope === "user" ? args.codexHome : args.path;
  const gatePrefix = scope === "user" ? "user" : "project";
  let summary: { allowed: boolean; [key: string]: any };
  if (args.mode === "uninstall") {
    summary = engineDecision(`${gatePrefix}_uninstall`, targetRoot, uninstall_workflow(targetRoot, { dryRun: args.dryRun, scope }), [
      `managed SuperSpec surfaces removed; run superspec init --scope ${scope} to reinstall`,
    ]);
  } else if (args.mode === "update") {
    summary = engineDecision(`${gatePrefix}_update`, targetRoot, update_workflow(targetRoot, { scope }), [
      scope === "project" ? "review *.new files for user-modified surfaces, then rerun superspec check check-init" : "review *.new files for user-modified user-level surfaces",
    ]);
  } else if (scope === "user") {
    summary = engineDecision("user_install", targetRoot, install_workflow(targetRoot, { force: args.force, scope: "user" }), [
      "user-level SuperSpec Codex surfaces installed; use superspec init --scope project inside a repo when project-local surfaces are needed",
    ]);
  } else {
    summary = project_init(args.path, { force: args.force }) as { allowed: boolean; [key: string]: any };
  }
  summary.install_scope = scope;
  summary.install_root = targetRoot;
  printInitDecision(summary, {
    command: "init",
    format: args.format,
    mode: args.mode,
    scope,
    targetRoot,
    dryRun: args.dryRun,
  });
  return summary.allowed ? 0 : 1;
}

export function main_init(argv: string[] = process.argv.slice(2)): number {
  let args: InitArgs | null = null;
  try {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(help());
      return 0;
    }
    args = parse_init_argv(argv);
    const scope = args.scope ?? "project";
    const openspecInstall = maybe_install_missing_openspec({ cwd: args.path, scope, mode: args.mode });
    if (openspecInstall === "failed" || openspecInstall === "skipped") return openspecPreflightBlocked(args, scope, openspecInstall);
    return run_init(args, scope);
  } catch (err) {
    const change = "project";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printInitDecision(block(change, "guard_error", [errReason]), {
      command: "init",
      format: args?.format ?? fallbackOutputFormat(argv),
      mode: args?.mode,
      scope: args?.scope ?? "project",
      targetRoot: args?.path,
      dryRun: args?.dryRun,
    });
    return 2;
  }
}

export async function main_init_async(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: InitArgs | null = null;
  try {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(help());
      return 0;
    }
    args = parse_init_argv(argv);
    const scope = args.scope ?? (canPrompt() ? await promptInstallScope() : "project");
    const openspecInstall = maybe_install_missing_openspec({ cwd: args.path, scope, mode: args.mode });
    if (openspecInstall === "failed" || openspecInstall === "skipped") return openspecPreflightBlocked(args, scope, openspecInstall);
    return run_init(args, scope);
  } catch (err) {
    const change = "project";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printInitDecision(block(change, "guard_error", [errReason]), {
      command: "init",
      format: args?.format ?? fallbackOutputFormat(argv),
      mode: args?.mode,
      scope: args?.scope ?? "project",
      targetRoot: args?.path,
      dryRun: args?.dryRun,
    });
    return 2;
  }
}
