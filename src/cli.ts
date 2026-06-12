import { block, dispatch, GuardError, printDecision, reason } from "./core.ts";
import { emitArgparsePreamble, parse_argv, type ParsedArgs } from "./cli_args.ts";
import { dispatch_packet, is_packet_command } from "./packet_render.ts";
import { printPacket, printPacketError } from "./util.ts";

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: ParsedArgs | null = null;
  const rawCommand = argv[0] ?? "";
  try {
    const argparseExit = emitArgparsePreamble(argv);
    if (argparseExit !== null) return argparseExit;
    args = parse_argv(argv);
    if (is_packet_command(args.command)) {
      const result = dispatch_packet(args);
      printPacket(result.payload, { format: result.output_format });
      return 0;
    }
    const [decision] = dispatch(args);
    printDecision(decision, { command: args.command, format: args.format });
      return decision.allowed ? 0 : 1;
    } catch (err) {
    if ((args && is_packet_command(args.command)) || is_packet_command(rawCommand)) {
      const errCode = err instanceof GuardError ? "guard_error" : "guard_internal_error";
      printPacketError(errCode, `${(err as Error).message}`);
      return 2;
    }
    const change = args?.change ?? "?";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printDecision(block(change, "guard_error", [errReason]), { command: args?.command, format: args?.format });
    return 2;
  }
}
