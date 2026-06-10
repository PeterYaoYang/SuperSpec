#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export * from "./src/init_cli.ts";

import { main_init_async } from "./src/init_cli.ts";

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

const currentFile = realpathMaybe(process.argv[1] ?? "");
if (currentFile === realpathMaybe(new URL(import.meta.url).pathname)) {
  process.exitCode = await main_init_async();
}
