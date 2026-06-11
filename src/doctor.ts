import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PACKAGE_ROOT } from "./install_engine.ts";
import { openspec_cli_probe } from "./openspec.ts";
import { commandExists, runCommand, type JsonMap } from "./util.ts";

type RunResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type RunFn = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; platform?: NodeJS.Platform }) => RunResult;
type CommandExistsFn = (cmd: string, meta?: { cwd?: string }) => boolean;
type CheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  status: CheckStatus;
  name: string;
  detail: string;
  refs?: string[];
};

export type DoctorReport = {
  ok: boolean;
  cwd: string;
  superspec: JsonMap;
  node: JsonMap;
  npm: JsonMap;
  openspec: JsonMap;
  checks: DoctorCheck[];
  next_actions: string[];
};

function readPackageJson(packageRoot: string): JsonMap {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function superspec_package_version(packageRoot: string = PACKAGE_ROOT): string {
  const version = readPackageJson(packageRoot).version;
  return typeof version === "string" && version ? version : "0.0.0";
}

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function pathInfo(filePath: string | null): JsonMap | null {
  if (!filePath) return null;
  const info: JsonMap = { path: filePath, exists: existsSync(filePath) };
  if (!info.exists) return info;
  try {
    const stat = lstatSync(filePath);
    info.kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    if (stat.isSymbolicLink()) info.link_target = readlinkSync(filePath);
    info.realpath = realpathMaybe(filePath);
  } catch (err) {
    info.error = (err as Error).message;
  }
  return info;
}

function firstNonEmptyLine(text: string): string | null {
  return text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? null;
}

function commandPath(cmd: string, opts: { cwd: string; platform: NodeJS.Platform; commandExistsFn: CommandExistsFn; run: RunFn }): string | null {
  if (!opts.commandExistsFn(cmd, { cwd: opts.cwd })) return null;
  const proc = opts.platform === "win32"
    ? opts.run("where.exe", [cmd], { cwd: opts.cwd, timeout: 15_000, platform: opts.platform })
    : opts.run("sh", ["-c", `command -v ${cmd}`], { cwd: opts.cwd, timeout: 15_000, platform: opts.platform });
  if (proc.error || proc.status !== 0) return null;
  return firstNonEmptyLine(proc.stdout);
}

function npmValue(args: string[], opts: { cwd: string; platform: NodeJS.Platform; commandExistsFn: CommandExistsFn; run: RunFn }): JsonMap {
  if (!opts.commandExistsFn("npm", { cwd: opts.cwd })) return { available: false, value: null, error: "npm not found on PATH" };
  const proc = opts.run("npm", args, { cwd: opts.cwd, timeout: 15_000, platform: opts.platform });
  if (proc.error || proc.status !== 0) {
    return {
      available: true,
      value: null,
      error: (proc.error?.message ?? (proc.stderr || proc.stdout)).trim(),
    };
  }
  return { available: true, value: firstNonEmptyLine(proc.stdout), error: null };
}

function containsUnscopedSuperspecNodeModule(value: string | undefined): boolean {
  if (!value) return false;
  return /[/\\]node_modules[/\\]superspec[/\\]/u.test(value);
}

function add(checks: DoctorCheck[], status: CheckStatus, name: string, detail: string, refs?: string[]): void {
  checks.push({ status, name, detail, refs });
}

export function build_doctor_report(opts: {
  cwd?: string;
  packageRoot?: string;
  argv0?: string;
  platform?: NodeJS.Platform;
  commandExistsFn?: CommandExistsFn;
  run?: RunFn;
} = {}): DoctorReport {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const commandExistsFn = opts.commandExistsFn ?? ((cmd: string, meta?: { cwd?: string }) => commandExists(cmd, { cwd: meta?.cwd, platform }));
  const packageJson = readPackageJson(packageRoot);
  const version = superspec_package_version(packageRoot);
  const packageName = typeof packageJson.name === "string" ? packageJson.name : "unknown";
  const expectedBin = join(packageRoot, "bin", "superspec.js");
  const resolvedCommand = commandPath("superspec", { cwd, platform, commandExistsFn, run });
  const command = pathInfo(resolvedCommand);
  const prefix = npmValue(["prefix", "-g"], { cwd, platform, commandExistsFn, run });
  const root = npmValue(["root", "-g"], { cwd, platform, commandExistsFn, run });
  const npmRoot = typeof root.value === "string" ? root.value : null;
  const scopedPackage = npmRoot ? pathInfo(join(npmRoot, "@peterxiaoyang", "superspec")) : null;
  const unscopedPackage = npmRoot ? pathInfo(join(npmRoot, "superspec")) : null;
  const openspecProbe = openspec_cli_probe({ cwd, commandExistsFn, run });

  const checks: DoctorCheck[] = [];
  const nextActions: string[] = [];

  if (packageName === "@peterxiaoyang/superspec" && version !== "0.0.0") {
    add(checks, "ok", "package metadata", `${packageName}@${version}`);
  } else {
    add(checks, "fail", "package metadata", `could not identify @peterxiaoyang/superspec package metadata under ${packageRoot}`);
  }

  if (openspecProbe.ok) {
    add(checks, "ok", "OpenSpec CLI", openspecProbe.message);
  } else {
    add(checks, "fail", "OpenSpec CLI", openspecProbe.message);
    nextActions.push("npm install -g @fission-ai/openspec@latest");
  }

  if (!command) {
    add(checks, "warn", "superspec command", "`superspec` is not resolvable from PATH in this shell");
  } else {
    const commandRealpath = typeof command.realpath === "string" ? command.realpath : undefined;
    const commandTarget = typeof command.link_target === "string" ? command.link_target : undefined;
    if (containsUnscopedSuperspecNodeModule(commandRealpath) || containsUnscopedSuperspecNodeModule(commandTarget)) {
      add(checks, "fail", "superspec command owner", "`superspec` points at the unscoped `superspec` package, which conflicts with @peterxiaoyang/superspec", [String(command.path)]);
      nextActions.push("npm uninstall -g superspec");
      nextActions.push("npm install -g @peterxiaoyang/superspec@latest");
    } else if (existsSync(expectedBin) && commandRealpath && realpathMaybe(expectedBin) !== commandRealpath) {
      add(checks, "warn", "superspec command owner", "`superspec` on PATH does not point at this package root", [String(command.path), expectedBin]);
    } else {
      add(checks, "ok", "superspec command owner", "`superspec` resolves to this package");
    }
  }

  if (root.error) {
    add(checks, "warn", "npm global root", String(root.error));
  } else if (npmRoot) {
    add(checks, "ok", "npm global root", npmRoot);
  }

  if (unscopedPackage?.exists) {
    add(checks, "warn", "unscoped superspec package", "global package `superspec` is installed and can claim the same `superspec` binary", [String(unscopedPackage.path)]);
    nextActions.push("npm uninstall -g superspec");
  }

  if (scopedPackage && !scopedPackage.exists) {
    add(checks, "warn", "scoped superspec package", "@peterxiaoyang/superspec is not present under npm global root", [String(scopedPackage.path)]);
  }

  const dedupedNextActions = [...new Set(nextActions)];
  return {
    ok: !checks.some((check) => check.status === "fail"),
    cwd,
    superspec: {
      name: packageName,
      version,
      package_root: packageRoot,
      expected_bin: expectedBin,
      entry: opts.argv0 ?? process.argv[1] ?? null,
      command,
      scoped_global_package: scopedPackage,
      unscoped_global_package: unscopedPackage,
    },
    node: {
      version: process.versions.node,
      exec_path: process.execPath,
      platform,
    },
    npm: {
      prefix,
      root,
    },
    openspec: {
      ok: openspecProbe.ok,
      state: openspecProbe.state,
      version: openspecProbe.version,
      message: openspecProbe.message,
    },
    checks,
    next_actions: dedupedNextActions,
  };
}

export function render_doctor_report(report: DoctorReport): string {
  const lines = [
    "SuperSpec doctor",
    "",
    `SuperSpec: ${report.superspec.name}@${report.superspec.version}`,
    `Package root: ${report.superspec.package_root}`,
    `Command path: ${report.superspec.command?.path ?? "not found"}`,
    `OpenSpec: ${report.openspec.message}`,
    `Node: ${report.node.version} (${report.node.platform})`,
    `npm prefix: ${report.npm.prefix.value ?? "unknown"}`,
    `npm root: ${report.npm.root.value ?? "unknown"}`,
    "",
    "Checks:",
    ...report.checks.map((check) => {
      const refs = check.refs && check.refs.length > 0 ? ` (${check.refs.join(", ")})` : "";
      return `  [${check.status}] ${check.name}: ${check.detail}${refs}`;
    }),
  ];
  if (report.next_actions.length > 0) {
    lines.push("", "Next actions:", ...report.next_actions.map((action) => `  ${action}`));
  }
  lines.push("");
  return lines.join("\n");
}

function doctorHelp(): string {
  return [
    "usage: superspec doctor [--json]",
    "",
    "diagnoses SuperSpec, OpenSpec, npm global package, and PATH wiring.",
    "",
    "options:",
    "  --json      print machine-readable JSON",
    "  -h, --help  show this help",
    "",
  ].join("\n");
}

export function main_doctor(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(doctorHelp());
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    process.stderr.write(`superspec doctor: unknown option ${JSON.stringify(unknown[0])}\n\n${doctorHelp()}`);
    return 2;
  }
  const report = build_doctor_report();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(render_doctor_report(report));
  }
  return report.ok ? 0 : 1;
}
