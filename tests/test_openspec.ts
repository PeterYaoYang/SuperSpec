import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { openspecStatus, probeOpenSpec, validateOpenSpecChange } from "../src/openspec.ts";

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("OpenSpec runtime 在 Windows 通过 cmd.exe 调用 openspec.cmd", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-openspec-windows-"));
  const binDir = join(projectRoot, "bin");
  const commandLog = join(projectRoot, "commands.log");
  const change = "windows-change";
  const escapedLog = commandLog.replace(/'/g, "'\\''");
  const envNames = ["SUPERSPEC_TEST_MODE", "SUPERSPEC_TEST_PLATFORM", "ComSpec", "PATH"];
  const previous = new Map(envNames.map(name => [name, process.env[name]]));

  try {
    mkdirSync(join(projectRoot, "openspec", "changes", change), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "cmd.exe"), `#!/bin/sh
echo "cmd.exe $@" >> '${escapedLog}'
if [ "$1" = "/d" ]; then shift; fi
if [ "$1" = "/s" ]; then shift; fi
if [ "$1" = "/c" ]; then shift; fi
exec "$@"
`);
    writeExecutable(join(binDir, "openspec.cmd"), `#!/bin/sh
echo "openspec.cmd $@" >> '${escapedLog}'
case "$1" in
  --version) printf 'OpenSpec 1.4.1\\n' ;;
  status) printf '{"change":"windows-change"}\\n' ;;
  validate) exit 0 ;;
  *) echo "unexpected openspec command: $@" >&2; exit 1 ;;
esac
`);

    process.env.SUPERSPEC_TEST_MODE = "1";
    process.env.SUPERSPEC_TEST_PLATFORM = "win32";
    process.env.ComSpec = join(binDir, "cmd.exe");
    process.env.PATH = `${binDir}${delimiter}${previous.get("PATH") ?? ""}`;

    assert.deepEqual(probeOpenSpec(projectRoot, change), {
      available: true,
      version: "OpenSpec 1.4.1",
      changeExists: true,
    });
    assert.match(openspecStatus(projectRoot, change), /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(validateOpenSpecChange(projectRoot, change), {
      checked: true,
      ok: true,
      message: "OpenSpec 原生结构校验通过",
    });

    const commands = readFileSync(commandLog, "utf8");
    assert.match(commands, /^cmd\.exe \/d \/s \/c openspec\.cmd --version$/m);
    assert.match(commands, /^cmd\.exe \/d \/s \/c openspec\.cmd status --change windows-change --json$/m);
    assert.match(commands, /^cmd\.exe \/d \/s \/c openspec\.cmd validate windows-change --type change --strict --no-interactive$/m);
  } finally {
    restoreEnvironment(previous);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
