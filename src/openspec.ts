// SuperSpec 流程引擎 — OpenSpec 探测

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface OpenSpecProbe {
  available: boolean;
  version: string | null;
  changeExists: boolean;
  error?: string;
}

export interface OpenSpecStrictValidation {
  /** 调用方已经按冻结 profile 决定是否执行 strict validation。 */
  checked: boolean;
  ok: boolean;
  message: string;
}

function isTestMode(): boolean {
  return process.env.SUPERSPEC_TEST_MODE === "1" || process.env.NODE_ENV === "test";
}

function runtimePlatform(): string {
  return isTestMode() ? process.env.SUPERSPEC_TEST_PLATFORM ?? process.platform : process.platform;
}

function windowsCommandHost(): string {
  return process.env.ComSpec ?? "cmd.exe";
}

/**
 * 在 Windows 上，npm 安装的 CLI 是 .cmd 启动器，不能被 execFileSync 直接执行。
 * 保留数组参数传递；只有启动器这一层通过 cmd.exe 运行。
 */
function execOpenSpec(args: string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  if (runtimePlatform() !== "win32") return execFileSync("openspec", args, options);
  return execFileSync(windowsCommandHost(), ["/d", "/s", "/c", "openspec.cmd", ...args], options);
}

/** B2 修复：校验 change 字符集，防 shell 注入 */
function validateChange(change: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(change)) {
    throw new Error(`change 名称含非法字符：${change}（只允许字母数字._-）`);
  }
}

export function probeOpenSpec(projectRoot: string, change?: string): OpenSpecProbe {
  try {
    const version = execOpenSpec(["--version"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
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
    // B2 修复：参数始终走数组；Windows 仅通过 cmd.exe 运行 .cmd 启动器。
    const result = execOpenSpec(["status", "--change", change, "--json"], {
      encoding: "utf8", cwd: projectRoot, stdio: ["pipe", "pipe", "ignore"],
    });
    return "sha256:" + createHash("sha256").update(result).digest("hex");
  } catch {
    return "sha256:unknown";
  }
}

/**
 * 计划阶段的原生 OpenSpec 结构 gate。
 *
 * 调用方已通过冻结的 planning profile 确认应执行 strict validation。这里不再
 * 读取实时 config.yaml，避免计划就绪后环境变化导致准入标准漂移。
 */
export function validateOpenSpecChange(projectRoot: string, change: string): OpenSpecStrictValidation {
  validateChange(change);
  try {
    execOpenSpec(["validate", change, "--type", "change", "--strict", "--no-interactive"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { checked: true, ok: true, message: "OpenSpec 原生结构校验通过" };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; code?: unknown };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : failure.stdout?.toString("utf8") ?? "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString("utf8") ?? "";
    const detail = [stdout, stderr].map(value => value.trim()).filter(Boolean).join("；");
    return {
      checked: true,
      ok: false,
      message: `OpenSpec strict 校验失败${detail ? `：${detail}` : "；请确认 openspec CLI 可用并修复 proposal/specs 结构"}`,
    };
  }
}

export function changeRoot(projectRoot: string, change: string): string {
  return join(projectRoot, "openspec", "changes", change);
}
