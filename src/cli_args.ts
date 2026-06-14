import { command_zh } from "./i18n.ts";
import { GuardError, parseDecisionOutputFormat, parsePacketOutputFormat, type DecisionOutputFormat, type PacketOutputFormat } from "./util.ts";
import { normalize_gate } from "./openspec.ts";

export type ParsedArgs = {
  command: string;
  change: string;
  format?: DecisionOutputFormat;
  packet_format?: PacketOutputFormat;
  artifact?: string;
  gate?: string;
  task_id?: string;
  test_id?: string;
  phase?: "red" | "characterization" | "green";
  event_ref?: string;
  workflow?: string;
  entrypoint_token?: string;
  end_reason?: string;
  lifecycle_token?: string;
  role?: string;
  evidence_kind?: string;
  round?: number;
  executor_report_refs?: string[];
  task_code_review_report_refs?: string[];
  apply_worker_chain_refs?: string[];
  green_test_run_evidence_refs?: string[];
  red_test_run_evidence_refs?: string[];
  characterization_test_run_evidence_refs?: string[];
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
  "hook-health",
  "hook-session-status",
] as const;
const COMMANDS = [
  "init",
  ...SIMPLE_COMMANDS,
  "check-artifact",
  "check-enter",
  "check-task-reopen",
  "check-task-edit",
  "check-task-complete",
  "workflow-packet",
  "review-packet",
  "apply-test-packet",
  "apply-executor-packet",
  "apply-code-review-packet",
  "apply-verify-packet",
  "ledger-render",
  "hook-check-write",
  "hook-check-command",
  "hook-record-test",
  "hook-record-subagent-start",
  "hook-record-subagent-stop",
  "hook-session-begin",
  "hook-session-end",
] as const;
const COMMAND_LIST = COMMANDS.join(",");
const COMMAND_CHOICES = COMMANDS.map((item) => `'${item}'`).join(", ");

function isPacketCommand(command: string): boolean {
  return command === "workflow-packet"
    || command === "review-packet"
    || command === "apply-test-packet"
    || command === "apply-executor-packet"
    || command === "apply-code-review-packet"
    || command === "apply-verify-packet"
    || command === "ledger-render";
}

function requiredValueFlags(command: string): string[] {
  const flags = ["--change"];
  if (command === "check-artifact") flags.push("--artifact");
  if (command === "check-enter") flags.push("--gate");
  if (command === "check-task-reopen" || command === "check-task-edit" || command === "check-task-complete") flags.push("--task-id");
  if (command === "workflow-packet") flags.push("--gate");
  if (command === "review-packet") flags.push("--gate", "--role", "--round");
  if (command === "apply-test-packet") flags.push("--task-id", "--test-id", "--phase");
  if (command === "apply-executor-packet") flags.push("--task-id");
  if (command === "apply-code-review-packet") flags.push("--task-id", "--executor-report-ref");
  if (command === "apply-verify-packet") flags.push("--task-id", "--executor-report-ref", "--task-code-review-report-ref", "--green-test-run-evidence-ref");
  if (command === "ledger-render") flags.push("--gate");
  if (command === "hook-check-write" || command === "hook-check-command" || command === "hook-record-test"
    || command === "hook-record-subagent-start" || command === "hook-record-subagent-stop") flags.push("--event-ref");
  if (command === "hook-session-begin") flags.push("--workflow", "--entrypoint-token");
  if (command === "hook-session-end") flags.push("--reason");
  return flags;
}

function requiredBooleanFlags(command: string): string[] {
  return command === "init" ? ["--create"] : [];
}

function optionalBooleanFlags(command: string): string[] {
  if (isPacketCommand(command)) return [];
  return ["--user-facing", ...(command === "recompute" ? ["--force-unlock", "--rebuild-corrupt"] : [])];
}

function optionalValueFlags(command: string): string[] {
  if (command === "workflow-packet") return ["--task-id"];
  if (command === "review-packet") return ["--kind"];
  if (command === "apply-test-packet") return ["--task-code-review-report-ref"];
  if (command === "apply-executor-packet") return ["--apply-worker-chain-ref"];
  if (command === "apply-verify-packet") return ["--red-test-run-evidence-ref", "--characterization-test-run-evidence-ref"];
  if (command === "ledger-render") return ["--round"];
  if (command === "hook-session-end") return ["--lifecycle-token"];
  return [];
}

function formatUsage(command: string): string | null {
  if (command === "workflow-packet") return "--format {agent}";
  if (command === "review-packet"
    || command === "apply-test-packet"
    || command === "apply-executor-packet"
    || command === "apply-code-review-packet"
    || command === "apply-verify-packet") return "--format {agent,prompt}";
  if (command === "ledger-render") return null;
  return "[--format {json,agent,user}]";
}

function requiresFormat(command: string): boolean {
  return command === "workflow-packet"
    || command === "review-packet"
    || command === "apply-test-packet"
    || command === "apply-executor-packet"
    || command === "apply-code-review-packet"
    || command === "apply-verify-packet";
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
    ...(formatUsage(command) ? [formatUsage(command)!] : []),
    ...optionalValueFlags(command).map((flag) => `[${flag} ${flag.slice(2).replace(/-/g, "_").toUpperCase()}]`),
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
  const formatToken = formatUsage(command);
  if (formatToken) lines.push(`  ${formatToken}\n`);
  for (const flag of optionalValueFlags(command)) {
    const metavariable = flag.slice(2).replace(/-/g, "_").toUpperCase();
    lines.push(`  ${flag} ${metavariable}\n`);
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
  const missing = [...requiredValueFlags(command), ...requiredBooleanFlags(command)].filter((flag) => !hasFlag(args, flag));
  if (requiresFormat(command) && !hasFlag(args, "--format")) missing.push("--format");
  return missing;
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
  if (!isPacketCommand(command)) {
    const missing = missingRequiredFlags(command, args);
    if (missing.length > 0) {
      process.stderr.write(`${commandUsage(command)}superspec_guard ${command}：错误：缺少必填参数：${missing.join(", ")}\n`);
      return 2;
    }
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
  const isPacketOutputCommand = command === "workflow-packet"
    || command === "review-packet"
    || command === "apply-test-packet"
    || command === "apply-executor-packet"
    || command === "apply-code-review-packet"
    || command === "apply-verify-packet";
  const isPacketCommand = isPacketOutputCommand || command === "ledger-render";
  const selectedPacketFormat = formatValues.length > 0 ? formatValues[formatValues.length - 1] : undefined;
  if (isPacketOutputCommand) {
    if (!selectedPacketFormat) throw new GuardError("缺少必填参数 --format");
    for (const value of formatValues) parsePacketOutputFormat(value, { allowPrompt: command !== "workflow-packet" });
  } else {
    for (const value of formatValues) parseDecisionOutputFormat(value);
  }
  const selectedFormat = hasFlag(args, "--user-facing")
    ? "user"
    : (formatValues.length > 0 ? formatValues[formatValues.length - 1] : "json");
  const format = isPacketCommand ? undefined : parseDecisionOutputFormat(selectedFormat);
  const change = getValue("--change");
  if (!change) throw new (isPacketCommand ? GuardError : Error)("缺少必填参数 --change");
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
  if (command === "workflow-packet") {
    const gate = getValue("--gate");
    if (!gate) throw new GuardError("缺少必填参数 --gate");
    const normalizedGate = normalize_gate(gate);
    const taskId = getValue("--task-id");
    if ((normalizedGate === "task_edit" || normalizedGate === "task_complete" || normalizedGate === "task_reopen") && !taskId) {
      throw new GuardError("workflow-packet 缺少必填参数 --task-id");
    }
    return { command, change, gate, task_id: taskId, packet_format: parsePacketOutputFormat(selectedPacketFormat!, { allowPrompt: false }) };
  }
  if (command === "review-packet") {
    const gate = getValue("--gate");
    const role = getValue("--role");
    const roundValue = getValue("--round");
    const evidenceKind = getValue("--kind");
    if (!gate) throw new GuardError("缺少必填参数 --gate");
    if (!role) throw new GuardError("缺少必填参数 --role");
    if (!roundValue) throw new GuardError("缺少必填参数 --round");
    if (evidenceKind !== undefined && evidenceKind !== "source_guidance" && evidenceKind !== "verification_review") {
      throw new GuardError("--kind 只允许 source_guidance 或 verification_review");
    }
    const round = Number.parseInt(roundValue, 10);
    if (!Number.isInteger(round) || round < 1) throw new GuardError("--round 必须是大于等于 1 的整数");
    return {
      command,
      change,
      gate,
      role,
      evidence_kind: evidenceKind,
      round,
      packet_format: parsePacketOutputFormat(selectedPacketFormat!, { allowPrompt: true }),
    };
  }
  if (command === "apply-test-packet") {
    const taskId = getValue("--task-id");
    const testId = getValue("--test-id");
    const phase = getValue("--phase");
    if (!taskId) throw new GuardError("apply-test-packet 缺少必填参数 --task-id");
    if (!testId) throw new GuardError("apply-test-packet 缺少必填参数 --test-id");
    if (phase !== "red" && phase !== "characterization" && phase !== "green") {
      throw new GuardError("--phase 只允许 red、characterization 或 green");
    }
    return {
      command,
      change,
      task_id: taskId,
      test_id: testId,
      phase,
      task_code_review_report_refs: getValues("--task-code-review-report-ref"),
      packet_format: parsePacketOutputFormat(selectedPacketFormat!, { allowPrompt: true }),
    };
  }
  if (command === "apply-executor-packet") {
    const taskId = getValue("--task-id");
    if (!taskId) throw new GuardError("apply-executor-packet 缺少必填参数 --task-id");
    return {
      command,
      change,
      task_id: taskId,
      apply_worker_chain_refs: getValues("--apply-worker-chain-ref"),
      packet_format: parsePacketOutputFormat(selectedPacketFormat!, { allowPrompt: true }),
    };
  }
  if (command === "apply-code-review-packet") {
    const taskId = getValue("--task-id");
    const executorRefs = getValues("--executor-report-ref");
    if (!taskId) throw new GuardError("apply-code-review-packet 缺少必填参数 --task-id");
    if (executorRefs.length === 0) throw new GuardError("apply-code-review-packet 缺少必填参数 --executor-report-ref");
    return {
      command,
      change,
      task_id: taskId,
      executor_report_refs: executorRefs,
      packet_format: parsePacketOutputFormat(selectedPacketFormat!, { allowPrompt: true }),
    };
  }
  if (command === "apply-verify-packet") {
    const taskId = getValue("--task-id");
    const executorRefs = getValues("--executor-report-ref");
    const codeReviewRefs = getValues("--task-code-review-report-ref");
    const greenRefs = getValues("--green-test-run-evidence-ref");
    const redRefs = getValues("--red-test-run-evidence-ref");
    const characterizationRefs = getValues("--characterization-test-run-evidence-ref");
    if (!taskId) throw new GuardError("apply-verify-packet 缺少必填参数 --task-id");
    if (executorRefs.length === 0) throw new GuardError("apply-verify-packet 缺少必填参数 --executor-report-ref");
    if (codeReviewRefs.length === 0) throw new GuardError("apply-verify-packet 缺少必填参数 --task-code-review-report-ref");
    if (greenRefs.length === 0) throw new GuardError("apply-verify-packet 缺少必填参数 --green-test-run-evidence-ref");
    if (redRefs.length === 0 && characterizationRefs.length === 0) {
      throw new GuardError("apply-verify-packet requires --red-test-run-evidence-ref or --characterization-test-run-evidence-ref");
    }
    return {
      command,
      change,
      task_id: taskId,
      executor_report_refs: executorRefs,
      task_code_review_report_refs: codeReviewRefs,
      green_test_run_evidence_refs: greenRefs,
      red_test_run_evidence_refs: redRefs,
      characterization_test_run_evidence_refs: characterizationRefs,
      packet_format: parsePacketOutputFormat(selectedPacketFormat!, { allowPrompt: true }),
    };
  }
  if (command === "ledger-render") {
    const gate = getValue("--gate");
    const roundValue = getValue("--round");
    if (!gate) throw new GuardError("缺少必填参数 --gate");
    if (roundValue === undefined) return { command, change, gate };
    const round = Number.parseInt(roundValue, 10);
    if (!Number.isInteger(round) || round < 1) throw new GuardError("--round 必须是大于等于 1 的整数");
    return { command, change, gate, round };
  }
  if (command === "hook-check-write" || command === "hook-check-command" || command === "hook-record-test"
    || command === "hook-record-subagent-start" || command === "hook-record-subagent-stop") {
    const eventRef = getValue("--event-ref");
    if (!eventRef) throw new Error("缺少必填参数 --event-ref");
    return { command, change, format, event_ref: eventRef };
  }
  if (command === "hook-session-begin") {
    const workflow = getValue("--workflow");
    const entrypointToken = getValue("--entrypoint-token");
    if (!workflow) throw new Error("缺少必填参数 --workflow");
    if (!entrypointToken) throw new Error("缺少必填参数 --entrypoint-token");
    return { command, change, format, workflow, entrypoint_token: entrypointToken };
  }
  if (command === "hook-session-end") {
    const endReason = getValue("--reason");
    const lifecycleToken = getValue("--lifecycle-token");
    if (!endReason) throw new Error("缺少必填参数 --reason");
    return { command, change, format, end_reason: endReason, lifecycle_token: lifecycleToken ?? "" };
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
