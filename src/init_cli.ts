import { block, commandExists, GuardError, printDecision, reason, runCommand } from "./core.ts";
import { project_init, recommended_openspec_install_plan } from "./project_init.ts";
import { install_workflow, uninstall_workflow, update_workflow, type EngineResult, type InstallScope } from "./install_engine.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { system_failure_zh } from "./i18n.ts";

type InitArgs = {
  path: string;
  codexHome: string;
  mode: "install" | "update" | "uninstall";
  scope: InstallScope | null;
  dryRun: boolean;
  force: boolean;
};

function usage(): string {
  return "usage: superspec init [-h] [--scope {project,user}] [--path PATH] [--codex-home PATH] [--create] [--update] [--uninstall] [--dry-run] [--force]\n";
}

function help(): string {
  return `${usage()}\n可选参数：\n  -h, --help             显示帮助并退出\n  --scope {project,user} 安装到当前项目的 .codex 目录，或安装到用户级 Codex 目录（默认：project）\n  --project              等价于 --scope project\n  --user                 等价于 --scope user\n  --global               兼容别名，等价于 --user\n  --path PATH            --scope project 时使用的项目根目录（默认：当前目录）\n  --codex-home PATH      --scope user 时使用的 Codex 用户目录（默认：$CODEX_HOME 或 ~/.codex）\n  --create               兼容参数；init 默认就会创建缺失内容\n  --update               按 manifest 更新受管 SuperSpec 内容；用户改动文件保留，新的版本写入 *.new\n  --uninstall            按 manifest 卸载受管 SuperSpec 内容；.superspec 数据与既有/用户改动文件会保留\n  --dry-run              配合 --uninstall 时只预览将删除的文件，不实际修改\n  --force                安装时覆盖已有且内容不同的文件，并保留 *.bak 备份\n`;
}

function parse_init_argv(argv: string[]): InitArgs {
  const getValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("--")) throw new GuardError(`${flag} 缺少取值`);
    return value;
  };
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
  return {
    path: resolve(getValue("--path") ?? process.cwd()),
    codexHome: resolve(getValue("--codex-home") ?? process.env.CODEX_HOME ?? joinHomeCodex()),
    mode: uninstall ? "uninstall" : update ? "update" : "install",
    scope,
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
  };
}

function joinHomeCodex(): string {
  return `${homedir()}/.codex`;
}

function commandFailure(proc: { stdout: string; stderr: string; error?: Error; status: number | null }): string {
  const output = (proc.error?.message ?? (proc.stderr || proc.stdout)).trim();
  if (output) return system_failure_zh(output, `安装命令执行失败（退出状态码 ${proc.status ?? "未知"}）。`);
  if (proc.status !== null) return `安装命令执行失败（退出状态码 ${proc.status}）。`;
  return "安装命令执行失败，请查看终端日志后重试。";
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

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  try {
    for (;;) {
      const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (answer === "") return defaultYes;
      if (["y", "yes", "是", "好", "确认"].includes(answer)) return true;
      if (["n", "no", "否", "不", "取消"].includes(answer)) return false;
      process.stderr.write("请输入 y / n，或输入 是 / 否。\n");
    }
  } finally {
    rl.close();
  }
}

export async function maybe_install_missing_openspec(opts: {
  cwd: string;
  scope: InstallScope;
  mode: InitArgs["mode"];
  interactive?: boolean;
  commandExistsFn?: (cmd: string, meta?: { cwd?: string }) => boolean;
  confirm?: (question: string) => Promise<boolean>;
  run?: typeof runCommand;
  writeStderr?: (text: string) => void;
}): Promise<"not-needed" | "installed" | "skipped" | "failed"> {
  const commandExistsFn = opts.commandExistsFn ?? ((cmd: string, meta?: { cwd?: string }) => commandExists(cmd, { cwd: meta?.cwd }));
  if (opts.scope !== "project" || opts.mode !== "install") return "not-needed";
  if (commandExistsFn("openspec", { cwd: opts.cwd })) return "not-needed";
  if (!(opts.interactive ?? canPrompt())) return "skipped";

  const plan = recommended_openspec_install_plan({ cwd: opts.cwd, commandExistsFn });
  if (plan === null) return "skipped";

  const confirm = opts.confirm ?? ((question: string) => promptYesNo(question));
  const accepted = await confirm(`未检测到 openspec CLI。是否现在尝试自动安装？\n将执行：${plan.rendered}`);
  if (!accepted) return "skipped";

  const writeStderr = opts.writeStderr ?? ((text: string) => {
    process.stderr.write(text);
  });
  writeStderr(`正在安装 OpenSpec CLI：${plan.rendered}\n`);
  const proc = (opts.run ?? runCommand)(plan.cmd, plan.args, { cwd: opts.cwd, timeout: 300_000 });
  if (proc.error || proc.status !== 0) {
    writeStderr(`自动安装 OpenSpec CLI 失败：${commandFailure(proc)}\n`);
    return "failed";
  }
  if (!commandExistsFn("openspec", { cwd: opts.cwd })) {
    writeStderr("安装命令已完成，但当前 PATH 里仍未检测到 `openspec`。请重新打开终端或确认全局 bin 已在 PATH 中，然后重新运行 superspec init。\n");
    return "failed";
  }
  writeStderr("OpenSpec CLI 安装完成，继续执行 superspec init。\n");
  return "installed";
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
      scope === "project" ? "review *.new files for user-modified surfaces, then rerun superspec guard check-init" : "review *.new files for user-modified user-level surfaces",
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
  printDecision(summary, { command: "init" });
  return summary.allowed ? 0 : 1;
}

export function main_init(argv: string[] = process.argv.slice(2)): number {
  try {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(help());
      return 0;
    }
    const args = parse_init_argv(argv);
    return run_init(args, args.scope ?? "project");
  } catch (err) {
    const change = "project";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printDecision(block(change, "guard_error", [errReason]), { command: "init" });
    return 2;
  }
}

export async function main_init_async(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(help());
      return 0;
    }
    const args = parse_init_argv(argv);
    const scope = args.scope ?? (canPrompt() ? await promptInstallScope() : "project");
    await maybe_install_missing_openspec({ cwd: args.path, scope, mode: args.mode });
    return run_init(args, scope);
  } catch (err) {
    const change = "project";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printDecision(block(change, "guard_error", [errReason]), { command: "init" });
    return 2;
  }
}
