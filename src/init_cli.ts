import { block, GuardError, printDecision, reason } from "./core.ts";
import { project_init } from "./project_init.ts";
import { uninstall_workflow, update_workflow, type EngineResult } from "./install_engine.ts";

type InitArgs = { path: string; mode: "install" | "update" | "uninstall"; dryRun: boolean; force: boolean };

function usage(): string {
  return "usage: superspec_init [-h] [--path PATH] [--create] [--update] [--uninstall] [--dry-run] [--force]\n";
}

function help(): string {
  return `${usage()}\noptional arguments:\n  -h, --help           show this help message and exit\n  --path PATH          project root to initialize (default: current directory)\n  --create             accepted for compatibility; project init creates missing surfaces by default\n  --update             manifest-driven update of managed SuperSpec surfaces (user-modified files kept, new version written to *.new)\n  --uninstall          manifest-driven removal of managed SuperSpec surfaces (.superspec data and preexisting/user-modified files are kept)\n  --dry-run            with --uninstall: print what would be removed without touching files\n  --force              with install: overwrite pre-existing different files (backs up *.bak)\n`;
}

function parse_init_argv(argv: string[]): InitArgs {
  const getValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  };
  const update = argv.includes("--update");
  const uninstall = argv.includes("--uninstall");
  if (update && uninstall) throw new GuardError("--update and --uninstall are mutually exclusive");
  return {
    path: getValue("--path") ?? process.cwd(),
    mode: uninstall ? "uninstall" : update ? "update" : "install",
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
  };
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

export function main_init(argv: string[] = process.argv.slice(2)): number {
  try {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(help());
      return 0;
    }
    const args = parse_init_argv(argv);
    let summary: { allowed: boolean; [key: string]: any };
    if (args.mode === "uninstall") {
      summary = engineDecision("project_uninstall", args.path, uninstall_workflow(args.path, { dryRun: args.dryRun }), [
        "managed SuperSpec surfaces removed; run superspec-init (or this repository's superspec_init.ts) to reinstall",
      ]);
    } else if (args.mode === "update") {
      summary = engineDecision("project_update", args.path, update_workflow(args.path), [
        "review *.new files for user-modified surfaces, then rerun superspec-guard check-init",
      ]);
    } else {
      summary = project_init(args.path, { force: args.force }) as { allowed: boolean; [key: string]: any };
    }
    printDecision(summary);
    return summary.allowed ? 0 : 1;
  } catch (err) {
    const change = "project";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printDecision(block(change, "guard_error", [errReason]));
    return 2;
  }
}
