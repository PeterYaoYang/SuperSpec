import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { build_doctor_report, main_superspec, render_doctor_report, superspec_package_version, update_self_then_rerun } from "../superspec.ts";

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

async function captureOutput(fn: () => number | Promise<number>): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  (process.stdout.write as any) = (chunk: any) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr.write as any) = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const status = await fn();
    return { status, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test("top-level version commands print the package version", async () => {
  const expected = `${superspec_package_version()}\n`;
  for (const argv of [["-v"], ["--version"], ["version"]]) {
    const result = await captureOutput(() => main_superspec(argv));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, "");
  }
});

test("doctor report diagnoses healthy PATH, npm, and OpenSpec wiring", () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-doctor-"));
  try {
    const packageRoot = join(tmp, "pkg");
    const expectedBin = join(packageRoot, "bin", "superspec.js");
    const npmRoot = join(tmp, "global", "lib", "node_modules");
    writeText(join(packageRoot, "package.json"), JSON.stringify({ name: "@peterxiaoyang/superspec", version: "9.8.7" }));
    writeText(expectedBin, "#!/usr/bin/env node\n");
    mkdirSync(join(npmRoot, "@peterxiaoyang", "superspec"), { recursive: true });

    const report = build_doctor_report({
      cwd: tmp,
      packageRoot,
      argv0: expectedBin,
      platform: "darwin",
      commandExistsFn: (cmd) => ["superspec", "npm", "openspec"].includes(cmd),
      run: (cmd, args) => {
        if (cmd === "sh" && args[0] === "-c") return { status: 0, stdout: `${expectedBin}\n`, stderr: "" };
        if (cmd === "npm" && args.join(" ") === "prefix -g") return { status: 0, stdout: `${join(tmp, "global")}\n`, stderr: "" };
        if (cmd === "npm" && args.join(" ") === "root -g") return { status: 0, stdout: `${npmRoot}\n`, stderr: "" };
        if (cmd === "openspec" && args.join(" ") === "--version") return { status: 0, stdout: "OpenSpec 1.4.1\n", stderr: "" };
        if (cmd === "openspec" && args[1] === "--help") return { status: 0, stdout: "", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected command: ${cmd} ${args.join(" ")}` };
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.superspec.version, "9.8.7");
    assert.equal(report.openspec.ok, true);
    assert.ok(report.checks.some((check) => check.name === "superspec command owner" && check.status === "ok"));
    assert.match(render_doctor_report(report), /SuperSpec doctor/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("self update installs latest package and reruns update through the refreshed CLI", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let stdout = "";
  let stderr = "";
  const status = update_self_then_rerun({
    args: ["--scope", "project"],
    cwd: "/repo",
    commandExistsFn: (cmd) => cmd === "npm" || cmd === "superspec",
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "npm") return { status: 0, stdout: "updated\n", stderr: "" };
      if (cmd === "superspec") return { status: 0, stdout: "{\"allowed\":true}\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { cmd: "npm", args: ["install", "-g", "@peterxiaoyang/superspec@latest"] },
    { cmd: "superspec", args: ["update", "--scope", "project", "--skip-self-update"] },
  ]);
  assert.equal(stdout, "{\"allowed\":true}\n");
  assert.match(stderr, /Updating SuperSpec CLI/u);
});

test("self update retries with force only for superspec global bin conflicts", () => {
  const calls: string[] = [];
  const status = update_self_then_rerun({
    args: [],
    cwd: "/repo",
    commandExistsFn: (cmd) => cmd === "npm" || cmd === "superspec",
    run: (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "npm" && !args.includes("--force")) {
        return { status: 1, stdout: "", stderr: "npm error EEXIST: file already exists, File exists: /bin/superspec" };
      }
      if (cmd === "npm") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "superspec") return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
    writeStdout: () => {},
    writeStderr: () => {},
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    "npm install -g @peterxiaoyang/superspec@latest",
    "npm install -g --force @peterxiaoyang/superspec@latest",
    "superspec update --skip-self-update",
  ]);
});

test("top-level update local-only skips npm self update", async () => {
  const result = await captureOutput(() => main_superspec(["update", "--local-only", "--help"]));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--local-only/u);
  assert.doesNotMatch(result.stderr, /Updating SuperSpec CLI/u);
});

test("top-level update local-only preserves explicit output formats", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "superspec-top-update-format-"));
  try {
    await captureOutput(() => main_superspec(["init", "--path", tmp, "--format", "json"]));

    const jsonResult = await captureOutput(() => main_superspec(["update", "--local-only", "--path", tmp, "--format", "json"]));
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const json = JSON.parse(jsonResult.stdout);
    assert.equal(json.allowed, true);
    assert.equal(json.gate, "project_update");
    assert.equal(json.install_scope, "project");

    const agentResult = await captureOutput(() => main_superspec(["update", "--local-only", "--path", tmp, "--format", "agent"]));
    assert.equal(agentResult.status, 0, agentResult.stderr);
    const agent = JSON.parse(agentResult.stdout);
    assert.equal(agent.allowed, true);
    assert.equal(agent.workflow_action, "continue");
    assert.equal(existsSync(join(tmp, ".codex", "skills", "superspec-explore", "SKILL.md")), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
