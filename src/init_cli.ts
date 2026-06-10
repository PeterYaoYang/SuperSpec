import { block, GuardError, printDecision, reason } from "./core.ts";
import { project_init } from "./project_init.ts";
import { install_workflow, uninstall_workflow, update_workflow, type EngineResult, type InstallScope } from "./install_engine.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

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
  return `${usage()}\noptional arguments:\n  -h, --help             show this help message and exit\n  --scope {project,user} install into this project's .codex directory or into the Codex user home (default: project)\n  --project              shortcut for --scope project\n  --user                 shortcut for --scope user\n  --global               compatibility alias for --user\n  --path PATH            project root for --scope project (default: current directory)\n  --codex-home PATH      Codex user home for --scope user (default: $CODEX_HOME or ~/.codex)\n  --create               accepted for compatibility; init creates missing surfaces by default\n  --update               manifest-driven update of managed SuperSpec surfaces (user-modified files kept, new version written to *.new)\n  --uninstall            manifest-driven removal of managed SuperSpec surfaces (.superspec data and preexisting/user-modified files are kept)\n  --dry-run              with --uninstall: print what would be removed without touching files\n  --force                with install: overwrite pre-existing different files (backs up *.bak)\n`;
}

function parse_init_argv(argv: string[]): InitArgs {
  const getValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("--")) throw new GuardError(`${flag} requires a value`);
    return value;
  };
  const update = argv.includes("--update");
  const uninstall = argv.includes("--uninstall");
  if (update && uninstall) throw new GuardError("--update and --uninstall are mutually exclusive");
  const scopeFlag = getValue("--scope");
  if (scopeFlag !== undefined && !["project", "user", "global"].includes(scopeFlag)) throw new GuardError("--scope must be project or user");
  const userShortcut = argv.includes("--user") || argv.includes("--global");
  if (userShortcut && argv.includes("--project")) throw new GuardError("--user/--global and --project are mutually exclusive");
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
      const answer = (await rl.question("Install SuperSpec Codex surfaces to project or user? [project] ")).trim().toLowerCase();
      if (answer === "" || answer === "project" || answer === "p" || answer === "1") return "project";
      if (answer === "user" || answer === "u" || answer === "2" || answer === "global" || answer === "g") return "user";
      process.stderr.write("Please answer project or user.\n");
    }
  } finally {
    rl.close();
  }
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
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
  printDecision(summary);
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
    printDecision(block(change, "guard_error", [errReason]));
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
    return run_init(args, scope);
  } catch (err) {
    const change = "project";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printDecision(block(change, "guard_error", [errReason]));
    return 2;
  }
}
