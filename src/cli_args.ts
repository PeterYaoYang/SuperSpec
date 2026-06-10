export type ParsedArgs = {
  command: string;
  change: string;
  artifact?: string;
  gate?: string;
  task_id?: string;
  create?: boolean;
  force_unlock?: boolean;
  rebuild_corrupt?: boolean;
};

const SIMPLE_COMMANDS = [
  "status",
  "recompute",
  "check-init",
  "check-apply-ready",
  "check-review-ready",
  "check-review-complete",
  "check-verify-ready",
  "check-archive-ready",
  "check-archived",
] as const;
const COMMANDS = [
  "init",
  ...SIMPLE_COMMANDS,
  "check-artifact",
  "check-enter",
  "check-task-reopen",
  "check-task-edit",
  "check-task-complete",
] as const;
const COMMAND_LIST = COMMANDS.join(",");
const COMMAND_CHOICES = COMMANDS.map((item) => `'${item}'`).join(", ");

function requiredValueFlags(command: string): string[] {
  const flags = ["--change"];
  if (command === "check-artifact") flags.push("--artifact");
  if (command === "check-enter") flags.push("--gate");
  if (command === "check-task-reopen" || command === "check-task-edit" || command === "check-task-complete") flags.push("--task-id");
  return flags;
}

function requiredBooleanFlags(command: string): string[] {
  return command === "init" ? ["--create"] : [];
}

function optionalBooleanFlags(command: string): string[] {
  return command === "recompute" ? ["--force-unlock", "--rebuild-corrupt"] : [];
}

function rootUsage(): string {
  return `usage: superspec_guard [-h]\n                     {${COMMAND_LIST}}\n                     ...\n`;
}

function rootHelp(): string {
  return `${rootUsage()}\nsuperspec Sync Guard (v1)\n\npositional arguments:\n  {${COMMAND_LIST}}\n\noptional arguments:\n  -h, --help            show this help message and exit\n`;
}

function commandUsage(command: string): string {
  const usageFlags = [
    "[-h]",
    ...requiredValueFlags(command).map((flag) => `${flag} ${flag.slice(2).replace(/-/g, "_").toUpperCase()}`),
    ...requiredBooleanFlags(command),
    ...optionalBooleanFlags(command),
  ];
  return `usage: superspec_guard ${command} ${usageFlags.join(" ")}\n`;
}

function commandHelp(command: string): string {
  const lines = [commandUsage(command), "\noptional arguments:\n", "  -h, --help           show this help message and exit\n"];
  for (const flag of requiredValueFlags(command)) {
    const metavariable = flag.slice(2).replace(/-/g, "_").toUpperCase();
    lines.push(`  ${flag} ${metavariable}\n`);
  }
  for (const flag of requiredBooleanFlags(command)) {
    lines.push(`  ${flag}\n`);
  }
  for (const flag of optionalBooleanFlags(command)) {
    lines.push(`  ${flag}\n`);
  }
  return lines.join("");
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function missingRequiredFlags(command: string, args: string[]): string[] {
  return [...requiredValueFlags(command), ...requiredBooleanFlags(command)].filter((flag) => !hasFlag(args, flag));
}

export function emitArgparsePreamble(argv: string[]): number | null {
  if (argv.length === 0) {
    process.stderr.write(`${rootUsage()}superspec_guard: error: the following arguments are required: command\n`);
    return 2;
  }
  const command = argv[0];
  if (command === "-h" || command === "--help") {
    process.stdout.write(rootHelp());
    return 0;
  }
  if (!COMMANDS.includes(command as any)) {
    process.stderr.write(`${rootUsage()}superspec_guard: error: argument command: invalid choice: '${command}' (choose from ${COMMAND_CHOICES})\n`);
    return 2;
  }
  const args = argv.slice(1);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(commandHelp(command));
    return 0;
  }
  const missing = missingRequiredFlags(command, args);
  if (missing.length > 0) {
    process.stderr.write(`${commandUsage(command)}superspec_guard ${command}: error: the following arguments are required: ${missing.join(", ")}\n`);
    return 2;
  }
  return null;
}

export function parse_argv(argv: string[]): ParsedArgs {
  if (argv.length === 0) throw new Error("missing command");
  const command = argv[0];
  const args = argv.slice(1);
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    return args[idx + 1];
  };
  const change = getValue("--change");
  if (!change) throw new Error("missing required --change");
  if (command === "init") {
    if (!hasFlag(args, "--create")) throw new Error("missing required --create");
    return { command, change, create: true };
  }
  if (command === "check-artifact") {
    const artifact = getValue("--artifact");
    if (!artifact) throw new Error("missing required --artifact");
    return { command, change, artifact };
  }
  if (command === "check-enter") {
    const gate = getValue("--gate");
    if (!gate) throw new Error("missing required --gate");
    return { command, change, gate };
  }
  if (command === "check-task-reopen" || command === "check-task-edit" || command === "check-task-complete") {
    const taskId = getValue("--task-id");
    if (!taskId) throw new Error("missing required --task-id");
    return { command, change, task_id: taskId };
  }
  const simple = new Set<string>(SIMPLE_COMMANDS);
  if (!simple.has(command)) throw new Error(`unknown command: ${command}`);
  return {
    command,
    change,
    force_unlock: command === "recompute" && hasFlag(args, "--force-unlock"),
    rebuild_corrupt: command === "recompute" && hasFlag(args, "--rebuild-corrupt"),
  };
}
