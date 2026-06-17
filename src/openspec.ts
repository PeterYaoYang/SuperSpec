// SuperSpec 流程引擎 — OpenSpec 探测

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OpenSpecProbe {
  available: boolean;
  version: string | null;
  changeExists: boolean;
  error?: string;
}

export function probeOpenSpec(projectRoot: string, change?: string): OpenSpecProbe {
  try {
    const version = execSync("openspec --version 2>/dev/null", { encoding: "utf8" }).trim();
    let changeExists = false;
    if (change) {
      changeExists = existsSync(join(projectRoot, "openspec", "changes", change));
    }
    return { available: true, version, changeExists };
  } catch {
    return { available: false, version: null, changeExists: false, error: "openspec CLI 不可用" };
  }
}

export function openspecStatus(projectRoot: string, change: string): string {
  try {
    const result = execSync(
      `openspec status --change "${change}" --json 2>/dev/null`,
      { encoding: "utf8", cwd: projectRoot },
    );
    // 用 status 内容的 sha256 作为 digest
    const { createHash } = require("node:crypto");
    return "sha256:" + createHash("sha256").update(result).digest("hex");
  } catch {
    return "sha256:unknown";
  }
}

export function changeRoot(projectRoot: string, change: string): string {
  return join(projectRoot, "openspec", "changes", change);
}
