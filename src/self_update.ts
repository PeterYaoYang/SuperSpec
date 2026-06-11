import { commandExists, runCommand } from "./util.ts";

type RunResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type RunFn = typeof runCommand;
type CommandExistsFn = (cmd: string, meta?: { cwd?: string }) => boolean;

const SUPERSPEC_NPM_PACKAGE = "@peterxiaoyang/superspec";

function renderCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

function commandFailure(proc: RunResult): string {
  const output = (proc.error?.message ?? (proc.stderr || proc.stdout)).trim();
  if (output) return output;
  return proc.status === null ? "command failed" : `command exited with status ${proc.status}`;
}

function shouldRetrySuperSpecInstallWithForce(proc: RunResult): boolean {
  const output = `${proc.error?.message ?? ""}\n${proc.stderr}\n${proc.stdout}`;
  const binConflict = /\bEEXIST\b|already exists|file exists|Refusing to delete|will not overwrite|would overwrite/iu.test(output);
  const superspecBin = /\bsuperspec(?:\.(?:cmd|ps1))?\b/iu.test(output);
  return binConflict && superspecBin;
}

export function update_self_then_rerun(opts: {
  args: string[];
  cwd?: string;
  run?: RunFn;
  commandExistsFn?: CommandExistsFn;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}): number {
  const cwd = opts.cwd ?? process.cwd();
  const run = opts.run ?? runCommand;
  const commandExistsFn = opts.commandExistsFn ?? ((cmd: string, meta?: { cwd?: string }) => commandExists(cmd, { cwd: meta?.cwd }));
  const writeStdout = opts.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = opts.writeStderr ?? ((text: string) => process.stderr.write(text));
  if (!commandExistsFn("npm", { cwd })) {
    writeStderr("SuperSpec update requires npm on PATH to install @peterxiaoyang/superspec@latest. Use `superspec update --local-only` to update surfaces from the currently installed package.\n");
    return 1;
  }

  const installArgs = ["install", "-g", `${SUPERSPEC_NPM_PACKAGE}@latest`];
  writeStderr(`Updating SuperSpec CLI: ${renderCommand("npm", installArgs)}\n`);
  let install = run("npm", installArgs, { cwd, timeout: 300_000 });
  if ((install.error || install.status !== 0) && shouldRetrySuperSpecInstallWithForce(install)) {
    const forcedArgs = ["install", "-g", "--force", `${SUPERSPEC_NPM_PACKAGE}@latest`];
    writeStderr(`SuperSpec CLI install hit a global bin conflict; retrying with: ${renderCommand("npm", forcedArgs)}\n`);
    install = run("npm", forcedArgs, { cwd, timeout: 300_000 });
  }
  if (install.error || install.status !== 0) {
    writeStderr(`SuperSpec CLI update failed: ${commandFailure(install)}\n`);
    return 1;
  }

  if (!commandExistsFn("superspec", { cwd })) {
    writeStderr("SuperSpec CLI update completed, but `superspec` is not resolvable from PATH. Reopen the shell or check npm global bin configuration.\n");
    return 1;
  }

  const rerunArgs = ["update", ...opts.args, "--skip-self-update"];
  const rerun = run("superspec", rerunArgs, { cwd, timeout: 300_000 });
  if (rerun.stdout) writeStdout(rerun.stdout);
  if (rerun.stderr) writeStderr(rerun.stderr);
  if (rerun.error || rerun.status !== 0) {
    if (rerun.error && !rerun.stderr) writeStderr(`SuperSpec update rerun failed: ${rerun.error.message}\n`);
    return rerun.status ?? 1;
  }
  return 0;
}
