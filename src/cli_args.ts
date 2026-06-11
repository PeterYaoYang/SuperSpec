import { command_zh } from "./i18n.ts";
import { GuardError, parseDecisionOutputFormat, type DecisionOutputFormat } from "./util.ts";

export type ParsedArgs = {
  command: string;
  change: string;
  format?: DecisionOutputFormat;
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
  return ["--user-facing", ...(command === "recompute" ? ["--force-unlock", "--rebuild-corrupt"] : [])];
}

function rootUsage(): string {
  return `usage: superspec_guard [-h]\n                     {${COMMAND_LIST}}\n                     ...\n`;
}

function rootHelp(): string {
  const commandLines = COMMANDS.map((command) => {
    const zh = command_zh(command);
    return `  ${command.padEnd(22, " ")} ${zh.label_zh} / ${zh.hint_zh}\n`;
  }).join("");
  return `${rootUsage()}\nSuperSpec 守护检查（v1）\n\n位置参数：\n  {${COMMAND_LIST}}\n\n命令：\n${commandLines}\n可选参数：\n  -h, --help            显示帮助并退出\n`;
}

function commandUsage(command: string): string {
  const usageFlags = [
    "[-h]",
    ...requiredValueFlags(command).map((flag) => `${flag} ${flag.slice(2).replace(/-/g, "_").toUpperCase()}`),
    "[--format {json,agent,user}]",
    ...requiredBooleanFlags(command),
    ...optionalBooleanFlags(command),
  ];
  return `usage: superspec_guard ${command} ${usageFlags.join(" ")}\n`;
}

function commandHelp(command: string): string {
  const zh = command_zh(command);
  const lines = [commandUsage(command), `\n${zh.label_zh}：${zh.hint_zh}\n`, "\n可选参数：\n", "  -h, --help           显示帮助并退出\n"];
  for (const flag of requiredValueFlags(command)) {
    const metavariable = flag.slice(2).replace(/-/g, "_").toUpperCase();
    lines.push(`  ${flag} ${metavariable}\n`);
  }
  for (const flag of requiredBooleanFlags(command)) {
    lines.push(`  ${flag}\n`);
  }
  lines.push("  --format {json,agent,user}\n");
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
    process.stderr.write(`${rootUsage()}superspec_guard：错误：缺少必填参数：command\n`);
    return 2;
  }
  const command = argv[0];
  if (command === "-h" || command === "--help") {
    process.stdout.write(rootHelp());
    return 0;
  }
  if (!COMMANDS.includes(command as any)) {
    process.stderr.write(`${rootUsage()}superspec_guard：错误：命令无效：'${command}'；可选值：${COMMAND_CHOICES}\n`);
    return 2;
  }
  const args = argv.slice(1);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(commandHelp(command));
    return 0;
  }
  const missing = missingRequiredFlags(command, args);
  if (missing.length > 0) {
    process.stderr.write(`${commandUsage(command)}superspec_guard ${command}：错误：缺少必填参数：${missing.join(", ")}\n`);
    return 2;
  }
  return null;
}

export function parse_argv(argv: string[]): ParsedArgs {
  if (argv.length === 0) throw new Error("缺少命令");
  const command = argv[0];
  const args = argv.slice(1);
  const getValues = (flag: string): string[] => {
    const values: string[] = [];
    for (let idx = 0; idx < args.length; idx += 1) {
      if (args[idx] !== flag) continue;
      const value = args[idx + 1];
      if (value === undefined || value.startsWith("--")) throw new GuardError(`${flag} 缺少取值`);
      values.push(value);
    }
    return values;
  };
  const getValue = (flag: string): string | undefined => getValues(flag)[0];
  const formatValues = getValues("--format");
  for (const value of formatValues) parseDecisionOutputFormat(value);
  const selectedFormat = hasFlag(args, "--user-facing")
    ? "user"
    : (formatValues.length > 0 ? formatValues[formatValues.length - 1] : "json");
  const format = parseDecisionOutputFormat(selectedFormat);
  const change = getValue("--change");
  if (!change) throw new Error("缺少必填参数 --change");
  if (command === "init") {
    if (!hasFlag(args, "--create")) throw new Error("缺少必填参数 --create");
    return { command, change, format, create: true };
  }
  if (command === "check-artifact") {
    const artifact = getValue("--artifact");
    if (!artifact) throw new Error("缺少必填参数 --artifact");
    return { command, change, format, artifact };
  }
  if (command === "check-enter") {
    const gate = getValue("--gate");
    if (!gate) throw new Error("缺少必填参数 --gate");
    return { command, change, format, gate };
  }
  if (command === "check-task-reopen" || command === "check-task-edit" || command === "check-task-complete") {
    const taskId = getValue("--task-id");
    if (!taskId) throw new Error("缺少必填参数 --task-id");
    return { command, change, format, task_id: taskId };
  }
  const simple = new Set<string>(SIMPLE_COMMANDS);
  if (!simple.has(command)) throw new Error(`未知命令：${command}`);
  return {
    command,
    change,
    format,
    force_unlock: command === "recompute" && hasFlag(args, "--force-unlock"),
    rebuild_corrupt: command === "recompute" && hasFlag(args, "--rebuild-corrupt"),
  };
}
