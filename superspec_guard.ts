#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export * from "./src/core.ts";
export * from "./src/cli.ts";
export * from "./src/cli_args.ts";

import { main } from "./src/cli.ts";

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

const currentFile = realpathMaybe(process.argv[1] ?? "");
if (currentFile === realpathMaybe(new URL(import.meta.url).pathname)) {
  process.exitCode = main();
}
