#!/usr/bin/env node
import "./src/core.ts";

export * from "./src/hooks/adapter.ts";

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runHookAdapter } from "./src/hooks/adapter.ts";

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

const currentFile = realpathMaybe(process.argv[1] ?? "");
export function main_hook(argv: string[] = process.argv.slice(2)): number {
  const stdin = readStdin();
  const result = runHookAdapter(argv, stdin);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (currentFile === realpathMaybe(new URL(import.meta.url).pathname)) {
  process.exitCode = main_hook();
}
