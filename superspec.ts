#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export * from "./src/init_cli.ts";
export * from "./src/cli.ts";
export * from "./src/doctor.ts";
export * from "./src/self_update.ts";

import { main } from "./src/cli.ts";
import { main_doctor, superspec_package_version } from "./src/doctor.ts";
import { main_init_async } from "./src/init_cli.ts";
import { update_self_then_rerun } from "./src/self_update.ts";

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function help(): string {
  return [
    "usage: superspec <command> [options]",
    "",
    "commands:",
    "  init        install SuperSpec Codex surfaces (asks project/user; default project)",
    "  update      update SuperSpec CLI, then update manifest-managed surfaces",
    "  uninstall   remove manifest-managed SuperSpec surfaces",
    "  check       run the SuperSpec check command surface",
    "  doctor      diagnose SuperSpec/OpenSpec/npm/PATH wiring",
    "  version     print SuperSpec CLI version",
    "",
    "examples:",
    "  superspec init --scope project",
    "  superspec init --scope user",
    "  superspec check check-init --change <change> --format agent",
    "  superspec doctor",
    "",
  ].join("\n");
}

function updateHelp(): string {
  return [
    "usage: superspec update [--scope {project,user}] [--path PATH] [--codex-home PATH] [--format {json,agent,user}] [--local-only]",
    "",
    "updates the global SuperSpec CLI from npm, then updates manifest-managed SuperSpec surfaces.",
    "",
    "options:",
    "  --scope {project,user}  update project .codex surfaces or user Codex home surfaces (default: project)",
    "  --project               equivalent to --scope project",
    "  --user, --global        equivalent to --scope user",
    "  --path PATH             project root for project scope (default: current directory)",
    "  --codex-home PATH       Codex user home for user scope (default: $CODEX_HOME or ~/.codex)",
    "  --format {json,agent,user} output format (default: user); use json for diagnostics/automation",
    "  --local-only            skip npm self-update and use the currently installed package",
    "  -h, --help              show this help",
    "",
  ].join("\n");
}

export async function main_superspec(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(help());
    return 0;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`${superspec_package_version()}\n`);
    return 0;
  }
  if (command === "init") return main_init_async(rest);
  if (command === "update") {
    if (rest.includes("-h") || rest.includes("--help")) {
      process.stdout.write(updateHelp());
      return 0;
    }
    const localOnly = rest.includes("--local-only") || rest.includes("--skip-self-update");
    const updateArgs = rest.filter((arg) => arg !== "--local-only" && arg !== "--skip-self-update");
    if (!localOnly) return update_self_then_rerun({ args: updateArgs });
    return main_init_async([...updateArgs, "--update"]);
  }
  if (command === "uninstall") return main_init_async([...rest, "--uninstall"]);
  if (command === "check" || command === "guard") return main(rest);
  if (command === "doctor") return main_doctor(rest);

  // Convenience fallback: `superspec check-init ...` behaves like `superspec check check-init ...`.
  if (command.startsWith("check-") || command === "status" || command === "recompute" || command === "init") {
    return main(argv);
  }

  process.stderr.write(`superspec: unknown command ${JSON.stringify(command)}\n\n${help()}`);
  return 2;
}

const currentFile = realpathMaybe(process.argv[1] ?? "");
if (currentFile === realpathMaybe(new URL(import.meta.url).pathname)) {
  process.exitCode = await main_superspec();
}
