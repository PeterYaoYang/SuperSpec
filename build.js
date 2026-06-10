#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

if (existsSync("dist")) {
  rmSync("dist", { recursive: true, force: true });
}

const tscPath = require.resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tscPath, "-p", "tsconfig.build.json"], { stdio: "inherit" });
