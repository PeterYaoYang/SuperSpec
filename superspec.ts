#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export * from "./src/init_cli.ts";
export * from "./src/cli.ts";

import { main } from "./src/cli.ts";
import { main_init_async } from "./src/init_cli.ts";

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
    "  update      update manifest-managed SuperSpec surfaces",
    "  uninstall   remove manifest-managed SuperSpec surfaces",
    "  guard       run the SuperSpec guard command surface",
    "",
    "examples:",
    "  superspec init --scope project",
    "  superspec init --scope user",
    "  superspec guard check-init --change <change>",
    "",
  ].join("\n");
}

export async function main_superspec(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(help());
    return 0;
  }
  if (command === "init") return main_init_async(rest);
  if (command === "update") return main_init_async([...rest, "--update"]);
  if (command === "uninstall") return main_init_async([...rest, "--uninstall"]);
  if (command === "guard") return main(rest);

  // Convenience fallback: `superspec check-init ...` behaves like `superspec guard check-init ...`.
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
