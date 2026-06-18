// SuperSpec 流程引擎 — OpenSpec 探测

import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface OpenSpecProbe {
  available: boolean;
  version: string | null;
  changeExists: boolean;
  error?: string;
}

/** B2 修复：校验 change 字符集，防 shell 注入 */
function validateChange(change: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(change)) {
    throw new Error(`change 名称含非法字符：${change}（只允许字母数字._-）`);
  }
}

export function probeOpenSpec(projectRoot: string, change?: string): OpenSpecProbe {
  try {
    const version = execSync("openspec --version 2>/dev/null", { encoding: "utf8" }).trim();
    let changeExists = false;
    if (change) {
      validateChange(change);
      changeExists = existsSync(join(projectRoot, "openspec", "changes", change));
    }
    return { available: true, version, changeExists };
  } catch {
    return { available: false, version: null, changeExists: false, error: "openspec CLI 不可用" };
  }
}

export function openspecStatus(projectRoot: string, change: string): string {
  validateChange(change);
  try {
    // B2 修复：用 execFileSync 数组传参，彻底避免 shell 解析
    const result = execFileSync("openspec", ["status", "--change", change, "--json"], {
      encoding: "utf8", cwd: projectRoot, stdio: ["pipe", "pipe", "ignore"],
    });
    return "sha256:" + createHash("sha256").update(result).digest("hex");
  } catch {
    return "sha256:unknown";
  }
}

export function changeRoot(projectRoot: string, change: string): string {
  return join(projectRoot, "openspec", "changes", change);
}
