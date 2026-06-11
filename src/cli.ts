import { block, dispatch, GuardError, printDecision, reason } from "./core.ts";
import { emitArgparsePreamble, parse_argv, type ParsedArgs } from "./cli_args.ts";

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: ParsedArgs | null = null;
  try {
    const argparseExit = emitArgparsePreamble(argv);
    if (argparseExit !== null) return argparseExit;
    args = parse_argv(argv);
    const [decision] = dispatch(args);
    printDecision(decision, { command: args.command, format: args.format });
    return decision.allowed ? 0 : 1;
  } catch (err) {
    const change = args?.change ?? "?";
    const errReason = err instanceof GuardError ? reason("guard_error", err.message) : reason("guard_internal_error", `${(err as Error).name}: ${(err as Error).message}`);
    printDecision(block(change, "guard_error", [errReason]), { command: args?.command, format: args?.format });
    return 2;
  }
}
