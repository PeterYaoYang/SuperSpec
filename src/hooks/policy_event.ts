import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { JsonMap, Reason } from "../util.ts";
import { GuardError, isObject, reason, renderList, safe_within, sha256_text, toPosix } from "../util.ts";
import type { HookEvent } from "./types.ts";

export type NormalizedHookEvent = {
  event: HookEvent;
  hook_event_id: string;
  hook_event_name: string;
  session_id: string;
  cwd: string;
  tool_name: string;
  command: string;
};

export type WriteExtraction = {
  target_paths: string[];
  trust_root_text_matches: string[];
  archive_command: boolean;
  internal_hook_writer_command: boolean;
  unsafe_lifecycle_termination_command: boolean;
  unsupported_write_surface: boolean;
  task_checkbox_completions: string[];
  task_checkbox_reopens: string[];
  shell_write_command: boolean;
  reasons: Reason[];
};

export function readHookEventRef(eventRef: string): HookEvent {
  if (!eventRef) throw new GuardError("hook_event_ref_missing");
  const text = readFileSync(eventRef, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GuardError(`hook_event_unparsable: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) throw new GuardError("hook_event_unparsable: event must be a JSON object");
  return parsed as HookEvent;
}

function stableEventDigest(event: HookEvent): string {
  const explicit = String(event.hook_event_id ?? event.tool_use_id ?? event.agent_id ?? "");
  const payload = explicit ? `${explicit}\n${JSON.stringify(event)}` : JSON.stringify(event);
  return sha256_text(payload);
}

export function normalizeHookEvent(event: HookEvent): NormalizedHookEvent {
  const hookEventName = typeof event.hook_event_name === "string" && event.hook_event_name
    ? event.hook_event_name
    : "Unknown";
  const toolInput = isObject(event.tool_input) ? event.tool_input : {};
  return {
    event,
    hook_event_id: stableEventDigest(event),
    hook_event_name: hookEventName,
    session_id: typeof event.session_id === "string" && event.session_id ? event.session_id : "unknown-session",
    cwd: typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd(),
    tool_name: typeof event.tool_name === "string" && event.tool_name ? event.tool_name : "",
    command: typeof toolInput.command === "string" ? toolInput.command : "",
  };
}

export function cleanRelPath(pathValue: string): string {
  return toPosix(pathValue).replace(/^\.\/+/u, "").replace(/\/+$/u, "").toLowerCase();
}

export function pathsIntersect(a: string, b: string): boolean {
  const left = cleanRelPath(a);
  const right = cleanRelPath(b);
  if (!left || left === "." || !right || right === ".") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathAtOrUnder(pathValue: string, root: string): boolean {
  const path = cleanRelPath(pathValue);
  const normalizedRoot = cleanRelPath(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

export function isSuperSpecTrustRootPath(pathValue: string, opts: { changeRootRel?: string } = {}): boolean {
  const rel = cleanRelPath(pathValue);
  const commonRoots = [
    ".codex/superspec",
    ".superspec",
  ];
  if (commonRoots.some((root) => pathAtOrUnder(rel, root))) return true;
  if (opts.changeRootRel && pathAtOrUnder(rel, `${cleanRelPath(opts.changeRootRel)}/.superspec`)) return true;
  return /^openspec\/changes\/[^/]+\/\.superspec(?:\/|$)/u.test(rel);
}

export function anyPathInScope(paths: string[], scope: string): boolean {
  return paths.some((path) => pathsIntersect(path, scope));
}

function addOutsideRepoReason(reasons: Reason[] | undefined, rawPath: string): void {
  if (!reasons) return;
  const ref = toPosix(rawPath.trim().replace(/^['"]|['"]$/gu, ""));
  if (!ref || reasons.some((item) => item.code === "target_path_outside_repo" && item.refs.includes(ref))) return;
  reasons.push(reason("target_path_outside_repo", `write target escapes the hook repo root: ${ref}`, [ref]));
}

function realpathMaybe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function resolvePhysicalPath(base: string, pathValue: string): string {
  const absolute = isAbsolute(pathValue);
  const rawParts = pathValue.split(/[\\/]+/u);
  let current = absolute ? resolve("/") : realpathMaybe(base);
  for (const part of rawParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = resolve(current, part);
    current = existsSync(next) ? realpathMaybe(next) : next;
  }
  return current;
}

function normalizeTargetPath(rawPath: string, cwd: string, repoRoot: string, opts: { stripDiffPrefix?: boolean } = {}, reasons?: Reason[]): string | null {
  const stripped = rawPath.trim().replace(/^['"]|['"]$/gu, "");
  if (!stripped || stripped === "/dev/null") return null;
  const withoutPrefix = opts.stripDiffPrefix ? stripped.replace(/^a\//u, "").replace(/^b\//u, "") : stripped;
  const abs = resolvePhysicalPath(cwd, withoutPrefix);
  const rel = relative(realpathMaybe(repoRoot), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    addOutsideRepoReason(reasons, stripped);
    return null;
  }
  return toPosix(rel);
}

function pushPath(paths: Set<string>, rawPath: string, cwd: string, repoRoot: string, opts: { stripDiffPrefix?: boolean } = {}, reasons?: Reason[]): void {
  const rel = normalizeTargetPath(rawPath, cwd, repoRoot, opts, reasons);
  if (rel) paths.add(rel);
}

function addShellPathTrustRootReason(reasons: Reason[] | undefined, rawPath: string): void {
  if (!reasons) return;
  const ref = toPosix(rawPath.trim().replace(/^['"]|['"]$/gu, ""));
  if (!ref || reasons.some((item) => item.code === "shell_path_may_touch_trust_root" && item.refs.includes(ref))) return;
  reasons.push(reason("shell_path_may_touch_trust_root", `shell-expanded path may touch a SuperSpec trust root: ${ref}`, [ref]));
}

function shellPathHasMeta(rawPath: string): boolean {
  return /[*?\[{\$`~]/u.test(rawPath.trim().replace(/^['"]|['"]$/gu, ""));
}

function shellStaticPrefix(rawPath: string): string {
  const stripped = rawPath.trim().replace(/^['"]|['"]$/gu, "");
  const meta = stripped.search(/[*?\[{\$`~]/u);
  if (meta < 0) return stripped;
  const prefix = stripped.slice(0, meta).replace(/\/+$/u, "");
  return prefix || ".";
}

function trustRootUnderShellPrefix(root: string, prefix: string, opts: { allowPartialPrefix: boolean }): boolean {
  const normalizedRoot = cleanRelPath(root);
  const normalizedPrefix = cleanRelPath(prefix);
  if (!normalizedPrefix || normalizedPrefix === ".") return true;
  if (opts.allowPartialPrefix) return normalizedRoot.startsWith(normalizedPrefix);
  return normalizedRoot === normalizedPrefix || normalizedRoot.startsWith(`${normalizedPrefix}/`);
}

function shellPathMayTouchTrustRoot(rawPath: string, cwd: string, repoRoot: string): boolean {
  const rawPrefix = shellStaticPrefix(rawPath);
  const normalizedPrefix = normalizeTargetPath(rawPrefix, cwd, repoRoot);
  const prefix = cleanRelPath(normalizedPrefix ?? rawPrefix);
  if (isSuperSpecTrustRootPath(prefix)) return true;
  const hasMeta = shellPathHasMeta(rawPath);
  const commonRoots = [
    ".codex/superspec",
    ".superspec",
    "openspec/changes",
  ];
  const changePrefix = prefix.match(/^(openspec\/changes\/[^/]+)(?:\/.*)?$/u);
  const dynamicChangeTrustRoot = changePrefix ? `${changePrefix[1]}/.superspec` : "";
  return commonRoots.some((root) => trustRootUnderShellPrefix(root, prefix, { allowPartialPrefix: hasMeta }))
    || Boolean(dynamicChangeTrustRoot && trustRootUnderShellPrefix(dynamicChangeTrustRoot, prefix, { allowPartialPrefix: hasMeta }));
}

function addDestructiveTrustRootReason(reasons: Reason[] | undefined, rawPath: string, cwd: string, repoRoot: string): void {
  if (!reasons) return;
  if (shellPathMayTouchTrustRoot(rawPath, cwd, repoRoot)) addShellPathTrustRootReason(reasons, rawPath);
}

function shellPathPrefix(rawPath: string): string {
  return shellStaticPrefix(rawPath);
}

function pushShellPath(paths: Set<string>, rawPath: string, cwd: string, repoRoot: string, reasons?: Reason[]): void {
  const stripped = rawPath.trim().replace(/^['"]|['"]$/gu, "");
  if (stripped.startsWith("~")) {
    addOutsideRepoReason(reasons, stripped);
    return;
  }
  if (shellPathHasMeta(stripped) && shellPathMayTouchTrustRoot(stripped, cwd, repoRoot)) {
    addShellPathTrustRootReason(reasons, stripped);
    return;
  }
  pushPath(paths, shellPathPrefix(rawPath), cwd, repoRoot, {}, reasons);
}

function addTrustRootLinkSourceReason(reasons: Reason[] | undefined, rawPath: string, cwd: string, repoRoot: string): void {
  if (!reasons) return;
  const stripped = rawPath.trim().replace(/^['"]|['"]$/gu, "");
  if (shellPathHasMeta(stripped) && shellPathMayTouchTrustRoot(stripped, cwd, repoRoot)) {
    addShellPathTrustRootReason(reasons, stripped);
    return;
  }
  const rel = normalizeTargetPath(rawPath, cwd, repoRoot);
  if (!rel || !isSuperSpecTrustRootPath(rel)) return;
  if (reasons.some((item) => item.code === "protected_trust_root_link_source" && item.refs.includes(rel))) return;
  reasons.push(reason("protected_trust_root_link_source", `link source points at a SuperSpec trust root: ${rel}`, [rel]));
}

function readHexEscape(command: string, index: number, maxLength: number): { value: string; next: number } | null {
  let hex = "";
  let next = index;
  while (next < command.length && hex.length < maxLength && /[0-9A-Fa-f]/u.test(command[next])) {
    hex += command[next];
    next += 1;
  }
  if (!hex) return null;
  return { value: String.fromCodePoint(Number.parseInt(hex, 16)), next };
}

function readOctalEscape(command: string, index: number): { value: string; next: number } {
  let octal = "";
  let next = index;
  while (next < command.length && octal.length < 3 && /[0-7]/u.test(command[next])) {
    octal += command[next];
    next += 1;
  }
  return { value: String.fromCodePoint(Number.parseInt(octal, 8)), next };
}

function readAnsiCQuoted(command: string, index: number): { value: string; next: number } {
  let current = "";
  let cursor = index;
  const simpleEscapes: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    e: "\u001b",
    E: "\u001b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    "\"": "\"",
  };
  while (cursor < command.length) {
    const ch = command[cursor];
    if (ch === "'") return { value: current, next: cursor + 1 };
    if (ch !== "\\") {
      current += ch;
      cursor += 1;
      continue;
    }
    const escaped = command[cursor + 1];
    if (!escaped) {
      current += "\\";
      cursor += 1;
      continue;
    }
    if (escaped === "x") {
      const hex = readHexEscape(command, cursor + 2, 2);
      if (hex) {
        current += hex.value;
        cursor = hex.next;
        continue;
      }
    } else if (escaped === "u") {
      const hex = readHexEscape(command, cursor + 2, 4);
      if (hex) {
        current += hex.value;
        cursor = hex.next;
        continue;
      }
    } else if (escaped === "U") {
      const hex = readHexEscape(command, cursor + 2, 8);
      if (hex) {
        current += hex.value;
        cursor = hex.next;
        continue;
      }
    } else if (/[0-7]/u.test(escaped)) {
      const octal = readOctalEscape(command, cursor + 1);
      current += octal.value;
      cursor = octal.next;
      continue;
    } else if (simpleEscapes[escaped] !== undefined) {
      current += simpleEscapes[escaped];
      cursor += 2;
      continue;
    }
    current += escaped;
    cursor += 2;
  }
  return { value: current, next: cursor };
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let index = 0;
  const push = (): void => {
    if (current) tokens.push(current);
    current = "";
  };
  while (index < command.length) {
    const ch = command[index];
    if (escaped) {
      current += ch === "(" || ch === ")" ? `\\${ch}` : ch;
      escaped = false;
      index += 1;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      if (command[index + 1] === "\n") {
        index += 2;
        continue;
      }
      if (command[index + 1] === "\r" && command[index + 2] === "\n") {
        index += 3;
        continue;
      }
      escaped = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (quote === "\"" && ch === "\\" && command[index + 1]) {
        if (command[index + 1] === "\n") {
          index += 2;
          continue;
        }
        if (command[index + 1] === "\r" && command[index + 2] === "\n") {
          index += 3;
          continue;
        }
        current += command[index + 1];
        index += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      index += 1;
      continue;
    }
    if (ch === "$" && command[index + 1] === "'") {
      const ansi = readAnsiCQuoted(command, index + 2);
      current += ansi.value;
      index = ansi.next;
      continue;
    }
    if (ch === "$" && command[index + 1] === "\"") {
      quote = "\"";
      index += 2;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "\n") {
      push();
      tokens.push(";");
      index += 1;
      continue;
    }
    if (ch === "\r" && command[index + 1] === "\n") {
      push();
      tokens.push(";");
      index += 2;
      continue;
    }
    if (/\s/u.test(ch)) {
      push();
      index += 1;
      continue;
    }
    if (ch === ">") {
      push();
      if (command[index + 1] === "&") {
        tokens.push(">&");
        index += 2;
      } else if (command[index + 1] === ">") {
        tokens.push(">>");
        index += 2;
      } else if (command[index + 1] === "|") {
        tokens.push(">|");
        index += 2;
      } else {
        tokens.push(">");
        index += 1;
      }
      continue;
    }
    if (ch === "&" && command[index + 1] === ">") {
      push();
      if (command[index + 2] === ">") {
        tokens.push("&>>");
        index += 3;
      } else {
        tokens.push("&>");
        index += 2;
      }
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      push();
      tokens.push(ch);
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  push();
  return tokens;
}

function shellCommandName(token: string): string {
  return token.split("/").pop() ?? token;
}

function isShellSeparator(token: string): boolean {
  return token === ";" || token === "|" || token === "&" || token === "(" || token === ")";
}

function shellCommandEnd(tokens: string[], start: number): number {
  let end = start;
  while (end < tokens.length && !isShellSeparator(tokens[end])) end += 1;
  return end;
}

function redirectionTarget(tokens: string[], idx: number): { target: string | null; skip: number } | null {
  const token = tokens[idx];
  if (/^\d+$/u.test(token) && redirectionTarget(tokens, idx + 1)) {
    const nested = redirectionTarget(tokens, idx + 1);
    return nested ? { target: nested.target, skip: nested.skip + 1 } : null;
  }
  if (![">", ">>", ">|", "&>", "&>>", ">&"].includes(token)) return null;
  const candidate = tokens[idx + 1];
  if (!candidate || isShellSeparator(candidate) || redirectionTarget(tokens, idx + 1)) {
    return { target: null, skip: 1 };
  }
  if (token === ">&" && (/^\d+$/u.test(candidate) || candidate === "-")) {
    return { target: null, skip: 2 };
  }
  return { target: candidate, skip: 2 };
}

function isAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function skipWrapperOptions(tokens: string[], start: number, end: number, optionsWithValues: Set<string>): number {
  let idx = start;
  while (idx < end) {
    const token = tokens[idx];
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip;
      continue;
    }
    if (token === "--") return idx + 1;
    if (!token.startsWith("-") || token === "-") return idx;
    if (optionsWithValues.has(token)) idx += 2;
    else idx += 1;
  }
  return idx;
}

function shellCommandIndexInSegment(tokens: string[], start: number, end: number): number | null {
  let idx = start;
  while (idx < end) {
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip;
      continue;
    }
    if (isAssignmentToken(tokens[idx])) {
      idx += 1;
      continue;
    }
    const name = shellCommandName(tokens[idx]);
    if (name === "{") {
      idx += 1;
      continue;
    }
    if (name === "env") {
      if (envSplitCommandAt(tokens, idx, end)) return idx;
      idx = skipWrapperOptions(tokens, idx + 1, end, new Set(["-u", "--unset", "-C", "--chdir", "-S"]));
      while (idx < end && isAssignmentToken(tokens[idx])) idx += 1;
      continue;
    }
    if (name === "sudo") {
      idx = skipWrapperOptions(tokens, idx + 1, end, new Set([
        "-A", "-a", "-b", "-C", "-c", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
      ]));
      continue;
    }
    if (["builtin", "command", "exec", "noglob"].includes(name)) {
      idx = skipWrapperOptions(tokens, idx + 1, end, new Set([]));
      continue;
    }
    return idx;
  }
  return null;
}

type NestedExecutableCommand = {
  command: string;
  cwd?: string;
  possibleParentPaths?: string[];
  possibleParentRawPaths?: string[];
};

function nestedShellCommands(tokens: string[], start = 0): string[] {
  const commands: string[] = [];
  for (let segmentStart = start; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx !== null) {
      commands.push(...nestedExecutableCommandsAt(tokens, commandIdx, segmentEnd).map((nested) => nested.command));
    }
    segmentStart = segmentEnd;
  }
  return commands;
}

function lastShellCommandSegment(tokens: string[]): { commandIdx: number; segmentEnd: number } | null {
  let last: { commandIdx: number; segmentEnd: number } | null = null;
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx !== null) last = { commandIdx, segmentEnd };
    segmentStart = segmentEnd;
  }
  return last;
}

function nestedExecutableCommandsAt(tokens: string[], start: number, end: number, cwd?: string, repoRoot?: string): NestedExecutableCommand[] {
  const direct = nestedShellCommandAt(tokens, start, end)
    ?? envSplitCommandAt(tokens, start, end)
    ?? evalCommandAt(tokens, start, end)
    ?? packageRunnerCommandAt(tokens, start, end);
  const commands: NestedExecutableCommand[] = direct ? [{ command: direct }] : [];
  commands.push(...findExecCommandsAt(tokens, start, end, cwd, repoRoot));
  return commands;
}

function nestedShellCommandAt(tokens: string[], start: number, end: number): string | null {
  const name = shellCommandName(tokens[start]);
  if (!["bash", "sh", "zsh", "dash", "fish"].includes(name)) return null;
  for (let idx = start + 1; idx < end; idx += 1) {
    const token = tokens[idx];
    if (token === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/u.test(token)) {
      const candidate = tokens[idx + 1];
      return candidate && idx + 1 < end ? candidate : null;
    }
  }
  return null;
}

function envSplitCommandAt(tokens: string[], start: number, end: number): string | null {
  if (shellCommandName(tokens[start]) !== "env") return null;
  for (let idx = start + 1; idx < end; idx += 1) {
    const token = tokens[idx];
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (token === "-S" || token === "--split-string") {
      const candidate = tokens[idx + 1];
      return candidate && idx + 1 < end ? candidate : null;
    }
    if (token.startsWith("-S") && token.length > 2) return token.slice(2);
    if (token.startsWith("--split-string=")) return token.slice("--split-string=".length);
  }
  return null;
}

function evalCommandAt(tokens: string[], start: number, end: number): string | null {
  if (shellCommandName(tokens[start]) !== "eval") return null;
  const parts: string[] = [];
  for (let idx = start + 1; idx < end; idx += 1) {
    const token = tokens[idx];
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    parts.push(token);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function shellQuoteToken(token: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(token)) return token;
  return `'${token.replace(/'/gu, "'\\''")}'`;
}

function shellCommandFromTokens(parts: string[]): string | null {
  return parts.length > 0 ? parts.map((part) => shellQuoteToken(part)).join(" ") : null;
}

function packageOptionHasValue(token: string, optionsWithValues: Set<string>): boolean {
  if (token.startsWith("--") && token.includes("=")) return false;
  return optionsWithValues.has(token);
}

function packageSubcommandIndex(args: string[], subcommands: Set<string>): number | null {
  const optionsWithValues = new Set([
    "-C",
    "-c",
    "-F",
    "-w",
    "--cache",
    "--config",
    "--cwd",
    "--dir",
    "--filter",
    "--globalconfig",
    "--prefix",
    "--registry",
    "--userconfig",
    "--workspace",
  ]);
  for (let idx = 0; idx < args.length; idx += 1) {
    const token = args[idx];
    if (token === "--") continue;
    if (token.startsWith("--")) {
      if (packageOptionHasValue(token, optionsWithValues) && args[idx + 1]) idx += 1;
      continue;
    }
    if (/^-[^-]/u.test(token)) {
      if (token.length === 2 && optionsWithValues.has(token) && args[idx + 1]) idx += 1;
      continue;
    }
    return subcommands.has(token) ? idx : null;
  }
  return null;
}

function packageCallCommand(args: string[], start: number): string | null {
  const optionsWithValues = new Set([
    "-p",
    "-F",
    "-w",
    "--cache",
    "--cwd",
    "--dir",
    "--filter",
    "--package",
    "--registry",
    "--shell",
    "--userconfig",
    "--workspace",
  ]);
  for (let idx = start; idx < args.length; idx += 1) {
    const token = args[idx];
    if (token === "--") return null;
    if (token === "-c" || token === "--call") return args[idx + 1] ?? null;
    if (token.startsWith("-c") && token.length > 2) return token.slice(2);
    if (token.startsWith("--call=")) return token.slice("--call=".length);
    if (token.startsWith("--")) {
      if (packageOptionHasValue(token, optionsWithValues) && args[idx + 1]) idx += 1;
      continue;
    }
    if (/^-[^-]/u.test(token)) {
      if (token.length === 2 && optionsWithValues.has(token) && args[idx + 1]) idx += 1;
      continue;
    }
    return null;
  }
  return null;
}

function packageExecutableArgs(args: string[], start: number): string[] {
  const optionsWithValues = new Set([
    "-p",
    "-F",
    "-w",
    "--cache",
    "--cwd",
    "--dir",
    "--filter",
    "--package",
    "--registry",
    "--shell",
    "--userconfig",
    "--workspace",
  ]);
  let idx = start;
  while (idx < args.length) {
    const token = args[idx];
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token.startsWith("--")) {
      if (token.includes("=")) {
        idx += 1;
      } else if (packageOptionHasValue(token, optionsWithValues) && args[idx + 1]) {
        idx += 2;
      } else {
        idx += 1;
      }
      continue;
    }
    if (/^-[^-]/u.test(token)) {
      if (token.length === 2 && optionsWithValues.has(token) && args[idx + 1]) idx += 2;
      else idx += 1;
      continue;
    }
    break;
  }
  const command = args.slice(idx);
  const separator = command.indexOf("--");
  if (separator >= 0) command.splice(separator, 1);
  return command;
}

function skipPackageGlobalOptions(args: string[]): number {
  const optionsWithValues = new Set([
    "-C",
    "--cwd",
    "--cache",
    "--config",
    "--global-folder",
    "--modules-folder",
    "--mutex",
    "--prefix",
    "--registry",
    "--userconfig",
  ]);
  let idx = 0;
  while (idx < args.length) {
    const token = args[idx];
    if (token === "--") return idx + 1;
    if (token.startsWith("--")) {
      if (packageOptionHasValue(token, optionsWithValues) && args[idx + 1]) idx += 2;
      else idx += 1;
      continue;
    }
    if (/^-[^-]/u.test(token)) {
      if (token.length === 2 && optionsWithValues.has(token) && args[idx + 1]) idx += 2;
      else idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

function packageRunnerCommandAt(tokens: string[], start: number, end: number): string | null {
  const name = shellCommandName(tokens[start]);
  const args = sameShellCommandArguments(tokens, start + 1, end);
  if (name === "npx" || name === "bunx") return packageCallCommand(args, 0) ?? shellCommandFromTokens(packageExecutableArgs(args, 0));
  if (name === "npm") {
    const subcommand = packageSubcommandIndex(args, new Set(["exec", "x"]));
    return subcommand === null ? null : packageCallCommand(args, subcommand + 1) ?? shellCommandFromTokens(packageExecutableArgs(args, subcommand + 1));
  }
  if (name === "yarn") {
    const first = skipPackageGlobalOptions(args);
    if (args[first] === "workspace" && args[first + 1]) {
      const subcommand = packageSubcommandIndex(args.slice(first + 2), new Set(["exec", "dlx"]));
      return subcommand === null ? null : packageCallCommand(args, first + subcommand + 3) ?? shellCommandFromTokens(packageExecutableArgs(args, first + subcommand + 3));
    }
  }
  if (name === "pnpm" || name === "yarn") {
    const subcommand = packageSubcommandIndex(args, new Set(["exec", "dlx"]));
    return subcommand === null ? null : packageCallCommand(args, subcommand + 1) ?? shellCommandFromTokens(packageExecutableArgs(args, subcommand + 1));
  }
  if (name === "bun") {
    const subcommand = packageSubcommandIndex(args, new Set(["x"]));
    return subcommand === null ? null : packageCallCommand(args, subcommand + 1) ?? shellCommandFromTokens(packageExecutableArgs(args, subcommand + 1));
  }
  return null;
}

function backtickCommandSubstitutions(command: string): string[] {
  const commands: string[] = [];
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let inBacktick = false;
  let backtickEscaped = false;
  let current = "";
  for (let idx = 0; idx < command.length; idx += 1) {
    const ch = command[idx];
    if (inBacktick) {
      if (backtickEscaped) {
        current += ch;
        backtickEscaped = false;
        continue;
      }
      if (ch === "\\") {
        backtickEscaped = true;
        continue;
      }
      if (ch === "`") {
        if (current.trim()) commands.push(current);
        current = "";
        inBacktick = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
        continue;
      }
      if (ch === "`") {
        inBacktick = true;
        current = "";
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      current = "";
    }
  }
  return commands;
}

function dollarParenCommandSubstitutions(command: string): string[] {
  const commands: string[] = [];
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let idx = 0; idx < command.length; idx += 1) {
    const ch = command[idx];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\"" && quote === "\"") {
      quote = null;
      continue;
    }
    if (ch === "\"" && quote === null) {
      quote = "\"";
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === "$" && command[idx + 1] === "(") {
      const parsed = readDollarParen(command, idx + 2);
      if (parsed) {
        if (parsed.value.trim()) commands.push(parsed.value);
        idx = parsed.next - 1;
      }
    }
  }
  return commands;
}

function readDollarParen(command: string, start: number): { value: string; next: number } | null {
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let current = "";
  for (let idx = start; idx < command.length; idx += 1) {
    const ch = command[idx];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "$" && command[idx + 1] === "(") {
      depth += 1;
      current += "$(";
      idx += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { value: current, next: idx + 1 };
    }
    current += ch;
  }
  return null;
}

function commandSubstitutions(command: string): string[] {
  return [...backtickCommandSubstitutions(command), ...dollarParenCommandSubstitutions(command)];
}

function findCommandRoots(tokens: string[], start: number, end: number): string[] {
  const roots: string[] = [];
  for (let idx = start + 1; idx < end; idx += 1) {
    const token = tokens[idx];
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (["-H", "-L", "-P"].includes(token)) continue;
    if (token === "-D") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    if (/^-O\d*$/u.test(token)) continue;
    if (token === "!" || token === "(" || token === "\\(" || token.startsWith("-")) break;
    roots.push(token);
  }
  return roots.length > 0 ? roots : ["."];
}

function findExecdirCwds(tokens: string[], start: number, end: number, cwd?: string, repoRoot?: string): string[] {
  if (!cwd || !repoRoot) return [];
  const cwds = new Set<string>();
  for (const root of findCommandRoots(tokens, start, end)) {
    if (root.startsWith("~") || shellPathHasMeta(root)) continue;
    cwds.add(resolvePhysicalPath(cwd, root));
  }
  return [...cwds];
}

function findHasDelete(tokens: string[], start: number, end: number): boolean {
  if (shellCommandName(tokens[start]) !== "find") return false;
  for (let idx = start + 1; idx < end; idx += 1) {
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (tokens[idx] === "-delete") return true;
  }
  return false;
}

function findDeleteRoots(tokens: string[], start: number, end: number): string[] {
  return findHasDelete(tokens, start, end) ? findCommandRoots(tokens, start, end) : [];
}

function findRootParentPaths(tokens: string[], start: number, end: number, cwd?: string, repoRoot?: string): string[] {
  if (!cwd || !repoRoot) return [];
  const paths = new Set<string>();
  for (const root of findCommandRoots(tokens, start, end)) {
    pushShellPath(paths, root, cwd, repoRoot);
  }
  return [...paths];
}

function findRootParentRawPaths(tokens: string[], start: number, end: number): string[] {
  return findCommandRoots(tokens, start, end);
}

function findExecCommandsAt(tokens: string[], start: number, end: number, cwd?: string, repoRoot?: string): NestedExecutableCommand[] {
  if (shellCommandName(tokens[start]) !== "find") return [];
  const commands: NestedExecutableCommand[] = [];
  for (let idx = start + 1; idx < end; idx += 1) {
    const token = tokens[idx];
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(token)) continue;
    const parts: string[] = [];
    for (idx += 1; idx < end; idx += 1) {
      const part = tokens[idx];
      if (part === ";" || part === "+") break;
      parts.push(part);
    }
    const command = shellCommandFromTokens(parts);
    if (!command) continue;
    if (token === "-execdir" || token === "-okdir") {
      const execdirCwds = findExecdirCwds(tokens, start, end, cwd, repoRoot);
      const possibleParentPaths = findRootParentPaths(tokens, start, end, cwd, repoRoot);
      const possibleParentRawPaths = findRootParentRawPaths(tokens, start, end);
      if (execdirCwds.length > 0) {
        commands.push(...execdirCwds.map((execCwd) => ({ command, cwd: execCwd, possibleParentPaths, possibleParentRawPaths })));
      } else {
        commands.push({ command, possibleParentPaths, possibleParentRawPaths });
      }
    } else {
      commands.push({ command });
    }
  }
  return commands;
}

function shortOptionAttachedValue(token: string, opt: string): string | null {
  if (!token.startsWith("-") || token.startsWith("--")) return null;
  const index = token.indexOf(opt, 1);
  if (index < 0 || index === token.length - 1) return null;
  return token.slice(index + 1);
}

function shellCommandPathOperands(tokens: string[], start: number): { operands: string[]; targetDirs: string[] } {
  const operands: string[] = [];
  const targetDirs: string[] = [];
  let optionsEnded = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      if (token.startsWith("--target-directory=")) targetDirs.push(token.slice("--target-directory=".length));
      else if (token === "--target-directory" && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        targetDirs.push(tokens[idx + 1]);
        idx += 1;
      }
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(token)) {
      const attachedTarget = shortOptionAttachedValue(token, "t");
      if (attachedTarget) {
        targetDirs.push(attachedTarget);
      } else if (token.includes("t") && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        targetDirs.push(tokens[idx + 1]);
        idx += 1;
      } else if (/[mog]/u.test(token) && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        idx += 1;
      }
      continue;
    }
    operands.push(token);
  }
  return { operands, targetDirs };
}

function pushShellRedirectionPaths(tokens: string[], paths: Set<string>, cwd: string, repoRoot: string, reasons: Reason[] | undefined, start = 0, end = tokens.length): void {
  for (let idx = start; idx < end; idx += 1) {
    const redirect = redirectionTarget(tokens, idx);
    if (!redirect) continue;
    if (redirect.target) pushShellPath(paths, redirect.target, cwd, repoRoot, reasons);
    idx += redirect.skip - 1;
  }
}

function sedInPlaceTargets(tokens: string[], start: number): { hasInPlace: boolean; targets: string[] } {
  const operands: string[] = [];
  let hasInPlace = false;
  let hasScriptFlag = false;
  let optionsEnded = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      if (token === "--in-place" || token.startsWith("--in-place=")) hasInPlace = true;
      if (token === "--expression" || token === "--file") {
        hasScriptFlag = true;
        if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      } else if (token.startsWith("--expression=") || token.startsWith("--file=")) {
        hasScriptFlag = true;
      }
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(token)) {
      if (token === "-i" || token.startsWith("-i") || /^-[A-Za-z]*i/u.test(token)) hasInPlace = true;
      if (token === "-e" || token === "-f") {
        hasScriptFlag = true;
        if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      }
      continue;
    }
    operands.push(token);
  }
  if (!hasInPlace) return { hasInPlace: false, targets: [] };
  return { hasInPlace: true, targets: hasScriptFlag ? operands : operands.slice(1) };
}

function teeTargets(tokens: string[], start: number): string[] {
  const targets: string[] = [];
  let optionsEnded = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-")) continue;
    targets.push(token);
  }
  return targets;
}

function shellOperands(tokens: string[], start: number, optionsWithValues: Set<string> = new Set()): string[] {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      if (packageOptionHasValue(token, optionsWithValues) && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(token)) {
      if (token.length === 2 && optionsWithValues.has(token) && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    operands.push(token);
  }
  return operands;
}

function isRsyncDeleteOption(token: string): boolean {
  return token === "--del" || token === "--delete" || token.startsWith("--delete-");
}

function rsyncValueOptions(): Set<string> {
  return new Set([
    "-B",
    "-e",
    "-f",
    "-M",
    "-T",
    "--address",
    "--backup-dir",
    "--block-size",
    "--bwlimit",
    "--checksum-choice",
    "--chmod",
    "--chown",
    "--compare-dest",
    "--compress-choice",
    "--compress-level",
    "--contimeout",
    "--copy-as",
    "--copy-dest",
    "--debug",
    "--dir-merge",
    "--exclude",
    "--exclude-from",
    "--files-from",
    "--filter",
    "--filter-from",
    "--groupmap",
    "--iconv",
    "--include",
    "--include-from",
    "--info",
    "--link-dest",
    "--log-file",
    "--log-file-format",
    "--max-alloc",
    "--max-delete",
    "--max-size",
    "--min-size",
    "--modify-window",
    "--only-write-batch",
    "--out-format",
    "--outbuf",
    "--partial-dir",
    "--password-file",
    "--port",
    "--protocol",
    "--remote-option",
    "--remote-shell",
    "--rsh",
    "--rsync-path",
    "--skip-compress",
    "--sockopts",
    "--suffix",
    "--temp-dir",
    "--timeout",
    "--usermap",
    "--write-batch",
    "--zc",
    "--zl",
  ]);
}

function rsyncTargets(tokens: string[], start: number): { operands: string[]; optionTargets: string[]; optionTargetDirs: string[]; removeSourceFiles: boolean; deleteExtraneous: boolean } {
  const optionTargets: string[] = [];
  const optionTargetDirs: string[] = [];
  let removeSourceFiles = false;
  let deleteExtraneous = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (isRsyncDeleteOption(token)) {
      deleteExtraneous = true;
      continue;
    }
    if (token === "--remove-source-files") {
      removeSourceFiles = true;
      continue;
    }
    if (token === "--log-file" || token === "--write-batch" || token === "--only-write-batch") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        optionTargets.push(tokens[idx + 1]);
        idx += 1;
      }
      continue;
    }
    if (token.startsWith("--log-file=")) optionTargets.push(token.slice("--log-file=".length));
    if (token.startsWith("--write-batch=")) optionTargets.push(token.slice("--write-batch=".length));
    if (token.startsWith("--only-write-batch=")) optionTargets.push(token.slice("--only-write-batch=".length));
    if (token === "--backup-dir" || token === "--partial-dir" || token === "--temp-dir") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        optionTargetDirs.push(tokens[idx + 1]);
        idx += 1;
      }
      continue;
    }
    if (token === "-T") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        optionTargetDirs.push(tokens[idx + 1]);
        idx += 1;
      }
      continue;
    }
    const attachedTempDir = shortOptionAttachedValue(token, "T");
    if (attachedTempDir) {
      optionTargetDirs.push(attachedTempDir);
      continue;
    }
    if (token.startsWith("--backup-dir=")) optionTargetDirs.push(token.slice("--backup-dir=".length));
    if (token.startsWith("--partial-dir=")) optionTargetDirs.push(token.slice("--partial-dir=".length));
    if (token.startsWith("--temp-dir=")) optionTargetDirs.push(token.slice("--temp-dir=".length));
  }
  const operands = shellOperands(tokens, start, rsyncValueOptions());
  return { operands, optionTargets, optionTargetDirs, removeSourceFiles, deleteExtraneous };
}

function urlPathBasename(value: string): string | null {
  let raw = value;
  try {
    raw = new URL(value).pathname;
  } catch {
    raw = value.split(/[?#]/u)[0] ?? value;
  }
  const name = basename(raw.replace(/[\\/]+$/u, ""));
  return name && name !== "." && name !== ".." ? name : null;
}

function joinShellPath(dir: string, name: string): string {
  if (!dir || dir === "." || isAbsolute(name)) return name;
  return `${dir.replace(/[\\/]+$/u, "")}/${name}`;
}

function curlPathWriteOptions(): Set<string> {
  return new Set([
    "--cookie-jar",
    "--dump-header",
    "--etag-save",
    "--libcurl",
    "--stderr",
    "--trace",
    "--trace-ascii",
  ]);
}

function pushCurlPathTarget(targets: string[], value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value !== "-") targets.push(value);
  return true;
}

function curlOutputTargets(tokens: string[], start: number): { targets: string[]; ambiguousTargetDirs: string[]; configDrivenWrite: boolean; unknownWriteTarget: boolean; writes: boolean } {
  const targets: string[] = [];
  const outputNames: string[] = [];
  const ambiguousTargetDirs: string[] = [];
  const remoteUrls: string[] = [];
  let outputDir = ".";
  let remoteName = false;
  let headerDerivedName = false;
  let configDrivenWrite = false;
  let unknownWriteTarget = false;
  let writes = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (token === "-K" || token === "--config") {
      writes = true;
      configDrivenWrite = true;
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    if (token.startsWith("--config=") || (token.startsWith("-K") && token.length > 2)) {
      writes = true;
      configDrivenWrite = true;
      continue;
    }
    if (token === "-o" || token === "--output") {
      writes = true;
      if (pushCurlPathTarget(outputNames, tokens[idx + 1])) idx += 1;
      else unknownWriteTarget = true;
      continue;
    }
    if (token.startsWith("--output=")) {
      writes = true;
      if (!pushCurlPathTarget(outputNames, token.slice("--output=".length))) unknownWriteTarget = true;
      continue;
    }
    if (token.startsWith("-o") && token.length > 2) {
      writes = true;
      if (!pushCurlPathTarget(outputNames, token.slice(2))) unknownWriteTarget = true;
      continue;
    }
    if (/^-[A-Za-z]*o$/u.test(token)) {
      writes = true;
      if (pushCurlPathTarget(outputNames, tokens[idx + 1])) idx += 1;
      else unknownWriteTarget = true;
      continue;
    }
    if (token === "-D" || token === "-c" || /^-[A-Za-z]*[Dc]$/u.test(token)) {
      writes = true;
      if (pushCurlPathTarget(targets, tokens[idx + 1])) idx += 1;
      else unknownWriteTarget = true;
      continue;
    }
    const attachedDumpHeader = shortOptionAttachedValue(token, "D");
    if (attachedDumpHeader) {
      writes = true;
      pushCurlPathTarget(targets, attachedDumpHeader);
      continue;
    }
    const attachedCookieJar = shortOptionAttachedValue(token, "c");
    if (attachedCookieJar) {
      writes = true;
      pushCurlPathTarget(targets, attachedCookieJar);
      continue;
    }
    if (curlPathWriteOptions().has(token)) {
      writes = true;
      if (pushCurlPathTarget(targets, tokens[idx + 1])) idx += 1;
      else unknownWriteTarget = true;
      continue;
    }
    const pathWriteOption = [...curlPathWriteOptions()].find((option) => token.startsWith(`${option}=`));
    if (pathWriteOption) {
      writes = true;
      if (!pushCurlPathTarget(targets, token.slice(pathWriteOption.length + 1))) unknownWriteTarget = true;
      continue;
    }
    if (token === "--url") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        remoteUrls.push(tokens[idx + 1]);
        idx += 1;
      }
      continue;
    }
    if (token.startsWith("--url=")) {
      remoteUrls.push(token.slice("--url=".length));
      continue;
    }
    if (token === "--output-dir") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        outputDir = tokens[idx + 1];
        idx += 1;
      }
      continue;
    }
    if (token.startsWith("--output-dir=")) {
      outputDir = token.slice("--output-dir=".length);
      continue;
    }
    if (token === "-J" || token === "--remote-header-name" || /^-[A-Za-z]*J[A-Za-z]*$/u.test(token)) {
      headerDerivedName = true;
      if (token === "--remote-header-name") continue;
    }
    if (token === "-O" || token === "--remote-name" || token === "--remote-name-all" || /^-[A-Za-z]*O[A-Za-z]*$/u.test(token)) {
      writes = true;
      remoteName = true;
      continue;
    }
      if (!token.startsWith("-")) remoteUrls.push(token);
  }
  for (const outputName of outputNames) targets.push(joinShellPath(outputDir, outputName));
  if (remoteName && headerDerivedName) {
    ambiguousTargetDirs.push(outputDir);
  } else if (remoteName) {
    for (const remoteUrl of remoteUrls) {
      const name = urlPathBasename(remoteUrl);
      if (name) targets.push(joinShellPath(outputDir, name));
    }
  }
  return { targets, ambiguousTargetDirs, configDrivenWrite, unknownWriteTarget, writes };
}

function wgetOutputTargets(tokens: string[], start: number): { targets: string[]; ambiguousTargetDirs: string[]; writes: boolean } {
  const targets: string[] = [];
  const ambiguousTargetDirs: string[] = [];
  const remoteUrls: string[] = [];
  let directoryPrefix = ".";
  let writes = false;
  let headerDerivedName = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (token === "-O" || token === "--output-document") {
      writes = true;
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        targets.push(tokens[idx + 1]);
        idx += 1;
      }
      continue;
    }
    if (token.startsWith("--output-document=")) {
      writes = true;
      targets.push(token.slice("--output-document=".length));
      continue;
    }
    if (token === "-P" || token === "--directory-prefix") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        directoryPrefix = tokens[idx + 1];
        idx += 1;
      }
      continue;
    }
    const attachedPrefix = shortOptionAttachedValue(token, "P");
    if (attachedPrefix) {
      directoryPrefix = attachedPrefix;
      continue;
    }
    if (token.startsWith("--directory-prefix=")) {
      directoryPrefix = token.slice("--directory-prefix=".length);
      continue;
    }
    if (token === "--content-disposition") {
      headerDerivedName = true;
      continue;
    }
    if (token.startsWith("-O") && token.length > 2) {
      writes = true;
      targets.push(token.slice(2));
      continue;
    }
    if (!token.startsWith("-")) remoteUrls.push(token);
  }
  if (targets.length === 0 && remoteUrls.length > 0) {
    writes = true;
    if (headerDerivedName) {
      ambiguousTargetDirs.push(directoryPrefix);
    } else {
      for (const remoteUrl of remoteUrls) {
        const name = urlPathBasename(remoteUrl);
        if (name) targets.push(joinShellPath(directoryPrefix, name));
      }
    }
  }
  return { targets, ambiguousTargetDirs, writes };
}

function stripTarMemberPath(member: string, stripComponents: number): string | null {
  if (stripComponents <= 0) return member;
  const parts = member.split(/[\\/]+/u).filter((part) => part && part !== ".");
  if (parts.length <= stripComponents) return null;
  return parts.slice(stripComponents).join("/");
}

function tarTargets(tokens: string[], start: number): { archiveTargets: string[]; extractionTargets: string[]; ambiguousTargetDirs: string[] } {
  const archiveTargets: string[] = [];
  const extractionTargets: string[] = [];
  const ambiguousTargetDirs: string[] = [];
  const archiveFiles: string[] = [];
  const memberTargets: string[] = [];
  let directory = ".";
  let stripComponents = 0;
  let extractMode = false;
  let archiveWriteMode = false;
  let pendingFile = false;
  let pendingDirectory = false;
  let pendingStripComponents = false;
  let sawOptionCluster = false;
  let transformUnknown = false;
  const rememberMember = (member: string): void => {
    const stripped = stripTarMemberPath(member, stripComponents);
    if (stripped) memberTargets.push(joinShellPath(directory, stripped));
    else ambiguousTargetDirs.push(directory);
  };
  const handleOptionCluster = (token: string): void => {
    sawOptionCluster = true;
    if (/[cruAd]/u.test(token)) archiveWriteMode = true;
    if (token.includes("x")) extractMode = true;
    const attachedDirectory = shortOptionAttachedValue(token, "C");
    if (attachedDirectory) {
      directory = attachedDirectory;
      return;
    }
    const attachedFile = shortOptionAttachedValue(token, "f");
    if (attachedFile) {
      if (attachedFile !== "-") archiveFiles.push(attachedFile);
    } else if (token.includes("f")) {
      pendingFile = true;
    }
  };
  const handleOldStyleCluster = (cluster: string, idx: number): number => {
    sawOptionCluster = true;
    let cursor = idx;
    for (const option of cluster) {
      if (/[cruAd]/u.test(option)) archiveWriteMode = true;
      if (option === "x") extractMode = true;
      if (option === "C") {
        if (tokens[cursor + 1] && !isShellSeparator(tokens[cursor + 1])) {
          cursor += 1;
          directory = tokens[cursor];
        } else {
          pendingDirectory = true;
        }
        continue;
      }
      if (option === "f") {
        if (tokens[cursor + 1] && !isShellSeparator(tokens[cursor + 1])) {
          cursor += 1;
          if (tokens[cursor] !== "-") archiveFiles.push(tokens[cursor]);
        } else {
          pendingFile = true;
        }
      }
    }
    return cursor;
  };
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (pendingFile) {
      if (token !== "-") archiveFiles.push(token);
      pendingFile = false;
      continue;
    }
    if (pendingDirectory) {
      directory = token;
      pendingDirectory = false;
      continue;
    }
    if (pendingStripComponents) {
      const parsed = Number.parseInt(token, 10);
      if (Number.isFinite(parsed) && parsed >= 0) stripComponents = parsed;
      else transformUnknown = true;
      pendingStripComponents = false;
      continue;
    }
    if (token === "--extract" || token === "--get") {
      extractMode = true;
      continue;
    }
    if (["--create", "--append", "--update", "--concatenate", "--catenate", "--delete"].includes(token)) {
      archiveWriteMode = true;
      continue;
    }
    if (token === "-f" || token === "--file") {
      pendingFile = true;
      continue;
    }
    if (token.startsWith("--file=")) {
      const file = token.slice("--file=".length);
      if (file !== "-") archiveFiles.push(file);
      continue;
    }
    if (token === "-C" || token === "--directory") {
      pendingDirectory = true;
      continue;
    }
    if (token.startsWith("--directory=")) {
      directory = token.slice("--directory=".length);
      continue;
    }
    if (token === "--strip-components") {
      pendingStripComponents = true;
      continue;
    }
    if (token.startsWith("--strip-components=")) {
      const parsed = Number.parseInt(token.slice("--strip-components=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) stripComponents = parsed;
      else transformUnknown = true;
      continue;
    }
    if (token === "--transform" || token === "--xform") {
      transformUnknown = true;
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    if (token.startsWith("--transform=") || token.startsWith("--xform=")) {
      transformUnknown = true;
      continue;
    }
    if (/^-[^-]/u.test(token)) {
      handleOptionCluster(token);
      continue;
    }
    if (!sawOptionCluster && /^[A-Za-z]+$/u.test(token) && /[ctxruAdfC]/u.test(token)) {
      idx = handleOldStyleCluster(token, idx);
      continue;
    }
    rememberMember(token);
  }
  if (archiveWriteMode) archiveTargets.push(...archiveFiles);
  if (extractMode) {
    if (transformUnknown) ambiguousTargetDirs.push(directory);
    if (memberTargets.length > 0) {
      extractionTargets.push(...memberTargets);
    } else if (!transformUnknown) {
      ambiguousTargetDirs.push(directory);
    }
  }
  return { archiveTargets, extractionTargets, ambiguousTargetDirs };
}

function unzipTargets(tokens: string[], start: number): { targets: string[]; ambiguousTargetDirs: string[] } {
  const targets: string[] = [];
  const ambiguousTargetDirs: string[] = [];
  const members: string[] = [];
  let directory = ".";
  let archiveSeen = false;
  for (let idx = start; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (isShellSeparator(token)) break;
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (token === "-d") {
      if (tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) {
        directory = tokens[idx + 1];
        idx += 1;
      }
      continue;
    }
    const attachedDirectory = shortOptionAttachedValue(token, "d");
    if (attachedDirectory) {
      directory = attachedDirectory;
      continue;
    }
    if (token.startsWith("-") && token !== "-") continue;
    if (!archiveSeen) {
      archiveSeen = true;
      continue;
    }
    members.push(token);
  }
  if (!archiveSeen) return { targets, ambiguousTargetDirs };
  if (members.length > 0) {
    for (const member of members) targets.push(joinShellPath(directory, member));
  } else {
    ambiguousTargetDirs.push(directory);
  }
  return { targets, ambiguousTargetDirs };
}

function shellTokensIncludeWrite(tokens: string[]): boolean {
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    for (let idx = segmentStart; idx < segmentEnd; idx += 1) {
      const redirect = redirectionTarget(tokens, idx);
      if (redirect?.target) return true;
      if (redirect) {
        idx += redirect.skip - 1;
        continue;
      }
    }
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx === null) {
      segmentStart = segmentEnd;
      continue;
    }
    const name = shellCommandName(tokens[commandIdx]);
    if (name === "sed") {
      if (sedInPlaceTargets(tokens, commandIdx + 1).hasInPlace) return true;
    } else if (name === "find") {
      if (findHasDelete(tokens, commandIdx, segmentEnd)) return true;
    } else if (name === "curl") {
      if (curlOutputTargets(tokens, commandIdx + 1).writes) return true;
    } else if (name === "wget") {
      if (wgetOutputTargets(tokens, commandIdx + 1).writes) return true;
    } else if (["tee", "mv", "cp", "rm", "install", "ln", "mkdir", "touch", "truncate", "dd", "tar", "unzip", "rsync"].includes(name)) {
      return true;
    }
    segmentStart = segmentEnd;
  }
  return false;
}

function addCurlConfigWriteReason(reasons: Reason[] | undefined): void {
  if (!reasons) return;
  if (reasons.some((item) => item.code === "curl_config_write_target_unknown")) return;
  reasons.push(reason("curl_config_write_target_unknown", "curl --config/-K can hide output paths from the hook classifier"));
}

function addCurlWriteTargetUnknownReason(reasons: Reason[] | undefined): void {
  if (!reasons) return;
  if (reasons.some((item) => item.code === "curl_write_target_unknown")) return;
  reasons.push(reason("curl_write_target_unknown", "curl write option is missing a concrete output path"));
}

function shellCdTarget(tokens: string[], start: number, end: number): string | null {
  let optionsEnded = false;
  for (let idx = start; idx < end; idx += 1) {
    const token = tokens[idx];
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token !== "-" && token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function firstShellArgument(tokens: string[], start: number, end: number, optionsWithValues: Set<string> = new Set()): string | null {
  let optionsEnded = false;
  for (let idx = start; idx < end; idx += 1) {
    const token = tokens[idx];
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("--")) {
      if (optionsWithValues.has(token) && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(token)) {
      if ([...optionsWithValues].some((option) => token === option) && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    return token;
  }
  return null;
}

function shellCwdAfterCd(target: string | null, cwd: string, repoRoot: string): string {
  if (!target || target === "-" || target.startsWith("~") || /[*?\[{\$`]/u.test(target)) {
    return resolve(repoRoot, "..");
  }
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function pushShellCommandOperandPaths(command: string, paths: Set<string>, cwd: string, repoRoot: string, reasons: Reason[] | undefined, depth = 0): boolean {
  const tokens = shellTokens(command);
  let currentCwd = cwd;
  let nestedShellWrite = false;
  let localShellWrite = false;
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    pushShellRedirectionPaths(tokens, paths, currentCwd, repoRoot, reasons, segmentStart, segmentEnd);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx !== null) {
      const name = shellCommandName(tokens[commandIdx]);
      if (depth < 3) {
        for (const nestedCommand of nestedExecutableCommandsAt(tokens, commandIdx, segmentEnd, currentCwd, repoRoot)) {
          const nested = extractShellPaths(nestedCommand.command, nestedCommand.cwd ?? currentCwd, repoRoot, reasons ?? [], depth + 1);
          for (const path of nested.paths) paths.add(path);
          nestedShellWrite = nestedShellWrite || nested.shell_write_command;
          if (nested.shell_write_command) {
            for (const rawParentPath of nestedCommand.possibleParentRawPaths ?? []) {
              addDestructiveTrustRootReason(reasons, rawParentPath, currentCwd, repoRoot);
            }
            for (const parentPath of nestedCommand.possibleParentPaths ?? []) {
              addDestructiveTrustRootReason(reasons, parentPath, currentCwd, repoRoot);
              paths.add(parentPath);
            }
          }
        }
      }
      if (name === "find") {
        const roots = findDeleteRoots(tokens, commandIdx, segmentEnd);
        if (roots.length > 0) {
          localShellWrite = true;
          for (const root of roots) {
            addDestructiveTrustRootReason(reasons, root, currentCwd, repoRoot);
            pushShellPath(paths, root, currentCwd, repoRoot, reasons);
          }
        }
      } else if (name === "tee") {
        for (const target of teeTargets(tokens, commandIdx + 1)) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
      } else if (name === "sed") {
        for (const target of sedInPlaceTargets(tokens, commandIdx + 1).targets) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
      } else if (name === "rsync") {
        const { operands, optionTargets, optionTargetDirs, removeSourceFiles, deleteExtraneous } = rsyncTargets(tokens, commandIdx + 1);
        for (const optionTarget of optionTargets) pushShellPath(paths, optionTarget, currentCwd, repoRoot, reasons);
        for (const optionTargetDir of optionTargetDirs) {
          pushShellPath(paths, optionTargetDir, currentCwd, repoRoot, reasons);
          pushTargetDirectoryPaths(paths, optionTargetDir, operands, currentCwd, repoRoot, reasons);
        }
        if (removeSourceFiles) {
          for (const source of operands.slice(0, -1)) {
            addDestructiveTrustRootReason(reasons, source, currentCwd, repoRoot);
            pushShellPath(paths, source, currentCwd, repoRoot, reasons);
          }
        }
        const target = operands.at(-1);
        if (target) {
          if (deleteExtraneous) addDestructiveTrustRootReason(reasons, target, currentCwd, repoRoot);
          pushShellPath(paths, target, currentCwd, repoRoot, reasons);
          if (operands.length > 1) pushTargetDirectoryPaths(paths, target, operands.slice(0, -1), currentCwd, repoRoot, reasons);
        }
      } else if (name === "curl") {
        const output = curlOutputTargets(tokens, commandIdx + 1);
        localShellWrite = localShellWrite || output.writes;
        if (output.configDrivenWrite) addCurlConfigWriteReason(reasons);
        if (output.unknownWriteTarget) addCurlWriteTargetUnknownReason(reasons);
        for (const target of output.targets) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
        for (const targetDir of output.ambiguousTargetDirs) {
          addDestructiveTrustRootReason(reasons, targetDir, currentCwd, repoRoot);
          pushShellPath(paths, targetDir, currentCwd, repoRoot, reasons);
        }
      } else if (name === "wget") {
        const output = wgetOutputTargets(tokens, commandIdx + 1);
        localShellWrite = localShellWrite || output.writes;
        for (const target of output.targets) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
        for (const targetDir of output.ambiguousTargetDirs) {
          addDestructiveTrustRootReason(reasons, targetDir, currentCwd, repoRoot);
          pushShellPath(paths, targetDir, currentCwd, repoRoot, reasons);
        }
      } else if (name === "dd") {
        for (let argIdx = commandIdx + 1; argIdx < segmentEnd; argIdx += 1) {
          const token = tokens[argIdx];
          const redirect = redirectionTarget(tokens, argIdx);
          if (redirect) {
            argIdx += redirect.skip - 1;
            continue;
          }
          if (token.startsWith("of=")) pushShellPath(paths, token.slice("of=".length), currentCwd, repoRoot, reasons);
        }
      } else if (name === "tar") {
        const { archiveTargets, extractionTargets, ambiguousTargetDirs } = tarTargets(tokens, commandIdx + 1);
        for (const target of archiveTargets) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
        for (const target of extractionTargets) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
        for (const targetDir of ambiguousTargetDirs) {
          addDestructiveTrustRootReason(reasons, targetDir, currentCwd, repoRoot);
          pushShellPath(paths, targetDir, currentCwd, repoRoot, reasons);
        }
      } else if (name === "unzip") {
        const { targets, ambiguousTargetDirs } = unzipTargets(tokens, commandIdx + 1);
        for (const target of targets) pushShellPath(paths, target, currentCwd, repoRoot, reasons);
        for (const targetDir of ambiguousTargetDirs) {
          addDestructiveTrustRootReason(reasons, targetDir, currentCwd, repoRoot);
          pushShellPath(paths, targetDir, currentCwd, repoRoot, reasons);
        }
      } else if (["cp", "mv", "rm", "install", "ln", "mkdir", "touch", "truncate"].includes(name)) {
        const { operands, targetDirs } = shellCommandPathOperands(tokens, commandIdx + 1);
        if (name === "ln") {
          for (const source of (targetDirs.length > 0 ? operands : operands.slice(0, -1))) {
            addTrustRootLinkSourceReason(reasons, source, currentCwd, repoRoot);
          }
          for (const targetDir of targetDirs) pushTargetDirectoryPaths(paths, targetDir, operands, currentCwd, repoRoot, reasons);
          if (targetDirs.length === 0) pushCopyLikeTargetPaths(paths, operands, currentCwd, repoRoot, reasons);
        } else if (["cp", "install"].includes(name)) {
          for (const targetDir of targetDirs) pushTargetDirectoryPaths(paths, targetDir, operands, currentCwd, repoRoot, reasons);
          if (targetDirs.length === 0) pushCopyLikeTargetPaths(paths, operands, currentCwd, repoRoot, reasons);
        } else if (name === "mv") {
          for (const source of (targetDirs.length > 0 ? operands : operands.slice(0, -1))) {
            addDestructiveTrustRootReason(reasons, source, currentCwd, repoRoot);
            pushShellPath(paths, source, currentCwd, repoRoot);
          }
          for (const targetDir of targetDirs) pushTargetDirectoryPaths(paths, targetDir, operands, currentCwd, repoRoot, reasons);
          if (targetDirs.length === 0) pushCopyLikeTargetPaths(paths, operands, currentCwd, repoRoot, reasons);
        } else if (name === "rm") {
          for (const operand of operands) {
            addDestructiveTrustRootReason(reasons, operand, currentCwd, repoRoot);
            pushShellPath(paths, operand, currentCwd, repoRoot, reasons);
          }
        } else {
          for (const operand of operands) pushShellPath(paths, operand, currentCwd, repoRoot, reasons);
        }
      }
    }
    if (commandIdx !== null && shellCommandName(tokens[commandIdx]) === "cd") {
      currentCwd = shellCwdAfterCd(shellCdTarget(tokens, commandIdx + 1, segmentEnd), currentCwd, repoRoot);
    }
    segmentStart = segmentEnd;
  }
  return nestedShellWrite || localShellWrite;
}

function pushTargetDirectoryPaths(paths: Set<string>, targetDir: string, operands: string[], cwd: string, repoRoot: string, reasons: Reason[] | undefined): void {
  pushShellPath(paths, targetDir, cwd, repoRoot, reasons);
  for (const operand of operands) {
    const name = basename(operand.replace(/[\\/]+$/u, ""));
    if (name && name !== "." && name !== "..") pushShellPath(paths, `${targetDir.replace(/[\\/]+$/u, "")}/${name}`, cwd, repoRoot, reasons);
  }
}

function pushCopyLikeTargetPaths(paths: Set<string>, operands: string[], cwd: string, repoRoot: string, reasons: Reason[] | undefined): void {
  const target = operands.at(-1);
  if (!target) return;
  pushShellPath(paths, target, cwd, repoRoot, reasons);
  if (operands.length <= 1) return;
  pushTargetDirectoryPaths(paths, target, operands.slice(0, -1), cwd, repoRoot, reasons);
}

function extractPatchPaths(command: string, cwd: string, repoRoot: string, reasons: Reason[]): string[] {
  const paths = new Set<string>();
  for (const line of command.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const direct = trimmed.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+?)\s*$/u);
    if (direct) {
      pushPath(paths, direct[1], cwd, repoRoot, {}, reasons);
      continue;
    }
    const move = trimmed.match(/^\*\*\*\s+Move to:\s+(.+?)\s*$/u);
    if (move) {
      pushPath(paths, move[1], cwd, repoRoot, {}, reasons);
      continue;
    }
    const diff = trimmed.match(/^(?:---|\+\+\+)\s+([ab]\/.+?|\/dev\/null)\s*$/u);
    if (diff) pushPath(paths, diff[1], cwd, repoRoot, { stripDiffPrefix: true }, reasons);
  }
  return [...paths].sort();
}

function extractToolInputPaths(event: HookEvent, cwd: string, repoRoot: string, reasons: Reason[]): string[] {
  const toolInput = isObject(event.tool_input) ? event.tool_input : {};
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "filePath", "target", "target_path", "targetPath"]) {
    const value = toolInput[key];
    if (typeof value === "string") pushPath(paths, value, cwd, repoRoot, {}, reasons);
  }
  for (const key of ["paths", "files", "target_paths", "targetPaths"]) {
    const values = toolInput[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) if (typeof value === "string") pushPath(paths, value, cwd, repoRoot, {}, reasons);
  }
  return [...paths].sort();
}

function interpreterInlineWriteCommand(command: string): boolean {
  const tokens = shellTokens(command);
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx === null) {
      segmentStart = segmentEnd;
      continue;
    }
    const name = shellCommandName(tokens[commandIdx]);
    if (!["node", "python", "python3", "perl", "ruby"].includes(name)) {
      segmentStart = segmentEnd;
      continue;
    }
    const snippets: string[] = [];
    for (let argIdx = commandIdx + 1; argIdx < segmentEnd; argIdx += 1) {
      const token = tokens[argIdx];
      const redirect = redirectionTarget(tokens, argIdx);
      if (redirect) {
        argIdx += redirect.skip - 1;
        continue;
      }
      if (token === "-e" || token === "-c" || token === "--eval") {
        if (tokens[argIdx + 1]) snippets.push(tokens[argIdx + 1]);
        argIdx += 1;
        continue;
      }
      if (token.startsWith("--eval=")) snippets.push(token.slice("--eval=".length));
    }
    if (snippets.some((snippet) => /write(?:file)?|append(?:file)?|rmSync|unlink|mkdir|rmdir|rename|copyFile|openSync|createWriteStream|write_text|File\.write|IO\.write/u.test(snippet))) {
      return true;
    }
    segmentStart = segmentEnd;
  }
  return false;
}

function executableTextWriteCommand(text: string): boolean {
  return /write(?:file)?|append(?:file)?|write_text|rmSync|unlink|mkdir|rmdir|rename|copyFile|openSync|createWriteStream|File\.write|IO\.write/u.test(text)
    || /(?:^|[;&|]\s*)(?:find\b[^;&|]*\s-delete\b|rsync\b|curl\b[^;&|]*(?:\s-o\s|\s--output(?:=|\s)|\s-O\b|\s--remote-name\b|\s-D\s|\s--dump-header(?:=|\s)|\s-c\s|\s--cookie-jar(?:=|\s)|\s--trace(?:=|\s)|\s--trace-ascii(?:=|\s)|\s--stderr(?:=|\s)|\s--libcurl(?:=|\s)|\s--etag-save(?:=|\s))|wget\b[^;&|]*(?:\s-O\s|\s--output-document(?:=|\s)|\s-P\s|\s--directory-prefix(?:=|\s))|sed\s+[^;&|]*\s-i\b|tee\b|mv\b|cp\b|rm\b|install\b|ln\b|mkdir\b|touch\b|truncate\b|dd\b|tar\b|unzip\b)|(?:>|>>)\s*[^&\s]/u.test(text);
}

function executableTextValues(value: unknown, keyHint = ""): string[] {
  const textKeys = new Set(["command", "cmd", "code", "script", "source", "input", "expression", "args", "arguments"]);
  if (typeof value === "string") return textKeys.has(keyHint) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => (
    typeof item === "string" && textKeys.has(keyHint)
      ? [item]
      : executableTextValues(item, keyHint)
  ));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => executableTextValues(child, key));
}

function trustRootTextMatches(text: string): string[] {
  const lower = text.toLowerCase();
  const matches = new Set<string>();
  if (/(?:^|[^a-z0-9_.-])\.codex\/superspec(?:\/|(?=$|[^a-z0-9_.-]))/u.test(lower)) {
    matches.add(".codex/superspec");
  }
  if (/(?:^|[^a-z0-9_.-])\.superspec(?:\/|(?=$|[^a-z0-9_.-]))/u.test(lower)) {
    matches.add(".superspec");
  }
  if (/openspec\/changes\/[^'"\s;&|]+\/\.superspec(?:\/|(?=$|[^a-z0-9_.-]))/u.test(lower)) {
    matches.add("openspec/changes/*/.superspec");
  }
  if (/\b(?:rmsync|rmdirsync|unlinksync|rm|rmdir|unlink)\s*\(\s*['"]\.codex['"]/u.test(lower)) {
    matches.add(".codex");
  }
  if (/\b(?:rmsync|rmdirsync|unlinksync|rm|rmdir|unlink)\s*\(\s*['"]openspec\/changes(?:\/[^/'"]+)?['"]/u.test(lower)) {
    matches.add("openspec/changes");
  }
  return [...matches].sort();
}

function extractShellPaths(command: string, cwd: string, repoRoot: string, reasons: Reason[], depth = 0): { paths: string[]; shell_write_command: boolean } {
  const paths = new Set<string>();
  const tokens = shellTokens(command);
  const nestedShellWrite = pushShellCommandOperandPaths(command, paths, cwd, repoRoot, reasons, depth);
  let substitutionShellWrite = false;
  if (depth < 3) {
    for (const nestedCommand of commandSubstitutions(command)) {
      const nested = extractShellPaths(nestedCommand, cwd, repoRoot, reasons, depth + 1);
      for (const path of nested.paths) paths.add(path);
      substitutionShellWrite = substitutionShellWrite || nested.shell_write_command;
    }
  }
  const shellWrite = shellTokensIncludeWrite(tokens) || interpreterInlineWriteCommand(command) || nestedShellWrite || substitutionShellWrite;
  return { paths: [...paths].sort(), shell_write_command: shellWrite };
}

function taskCheckboxTransitions(command: string): { completions: string[]; reopens: string[] } {
  const removedUnchecked = new Set<string>();
  const removedChecked = new Set<string>();
  const addedUnchecked = new Set<string>();
  const addedChecked = new Set<string>();
  for (const line of command.split(/\r?\n/u)) {
    const sign = line.startsWith("-") ? "-" : line.startsWith("+") ? "+" : "";
    if (!sign) continue;
    const body = line.slice(1).trimStart();
    const match = body.match(/^(?:-\s+)?\[([ xX])\]\s+(\S+)/u);
    if (!match) continue;
    const checked = match[1].toLowerCase() === "x";
    const taskId = match[2];
    if (sign === "-" && checked) removedChecked.add(taskId);
    if (sign === "-" && !checked) removedUnchecked.add(taskId);
    if (sign === "+" && checked) addedChecked.add(taskId);
    if (sign === "+" && !checked) addedUnchecked.add(taskId);
  }
  return {
    completions: [...addedChecked].filter((taskId) => removedUnchecked.has(taskId)).sort(),
    reopens: [...addedUnchecked].filter((taskId) => removedChecked.has(taskId)).sort(),
  };
}

function commandLooksLikeArchive(command: string, depth = 0): boolean {
  const tokens = shellTokens(command);
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx === null) {
      segmentStart = segmentEnd;
      continue;
    }
    const name = shellCommandName(tokens[commandIdx]);
    if (name === "openspec") {
      const subcommand = firstShellArgument(tokens, commandIdx + 1, segmentEnd);
      if (subcommand === "archive") return true;
    }
    if (name === "mv") {
      const { operands } = shellCommandPathOperands(tokens, commandIdx + 1);
      if (operands.some((operand) => /^openspec\/changes\/[^/]+$/u.test(cleanRelPath(operand)))) return true;
    }
    segmentStart = segmentEnd;
  }
  if (depth >= 3) return false;
  return [...nestedShellCommands(tokens), ...commandSubstitutions(command)].some((nestedCommand) => commandLooksLikeArchive(nestedCommand, depth + 1));
}

function tokenAtSameCommand(tokens: string[], idx: number): string | null {
  if (idx < 0 || idx >= tokens.length || isShellSeparator(tokens[idx])) return null;
  return tokens[idx];
}

function isHookEntrypointName(name: string): boolean {
  return name === "superspec-check"
    || name === "superspec-check.js"
    || name === "superspec-guard"
    || name === "superspec-guard.js"
    || name === "superspec-hook"
    || name === "superspec-hook.js";
}

function isHookAdapterEntrypointName(name: string): boolean {
  return name === "superspec-hook" || name === "superspec-hook.js";
}

function nodeScriptHookEntrypoint(tokens: string[], commandIdx: number): { name: string; argStart: number } | null {
  const name = shellCommandName(tokens[commandIdx]);
  if (!["node", "nodejs"].includes(name)) return null;
  for (let idx = commandIdx + 1; idx < tokens.length && !isShellSeparator(tokens[idx]); idx += 1) {
    const token = tokens[idx];
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (["-r", "--require", "--loader", "--import"].includes(token) && tokens[idx + 1] && !isShellSeparator(tokens[idx + 1])) idx += 1;
      continue;
    }
    const scriptName = shellCommandName(token);
    return isHookEntrypointName(scriptName) ? { name: scriptName, argStart: idx + 1 } : null;
  }
  return null;
}

function commandLooksLikeInternalHookWriter(command: string, depth = 0): boolean {
  const tokens = shellTokens(command);
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx === null) {
      segmentStart = segmentEnd;
      continue;
    }
    const name = shellCommandName(tokens[commandIdx]);
    if (name === "superspec") {
      const next = tokenAtSameCommand(tokens, commandIdx + 1);
      const afterNext = tokenAtSameCommand(tokens, commandIdx + 2);
      if (next?.startsWith("hook-record-")) return true;
      if (next === "guard" && afterNext?.startsWith("hook-record-")) return true;
      if (next === "check" && afterNext?.startsWith("hook-record-")) return true;
    }
    if (name === "superspec-guard" && tokenAtSameCommand(tokens, commandIdx + 1)?.startsWith("hook-record-")) return true;
    if (name === "superspec-check" && tokenAtSameCommand(tokens, commandIdx + 1)?.startsWith("hook-record-")) return true;
    if (isHookAdapterEntrypointName(name)) return true;
    if (isHookEntrypointName(name) && tokenAtSameCommand(tokens, commandIdx + 1)?.startsWith("hook-record-")) return true;
    const nodeEntrypoint = nodeScriptHookEntrypoint(tokens, commandIdx);
    if (nodeEntrypoint && isHookAdapterEntrypointName(nodeEntrypoint.name)) return true;
    if (nodeEntrypoint && tokenAtSameCommand(tokens, nodeEntrypoint.argStart)?.startsWith("hook-record-")) return true;
    segmentStart = segmentEnd;
  }
  if (depth >= 3) return false;
  return [...nestedShellCommands(tokens), ...commandSubstitutions(command)].some((nestedCommand) => commandLooksLikeInternalHookWriter(nestedCommand, depth + 1));
}

function commandLooksLikeUnsafeLifecycleTermination(command: string, depth = 0): boolean {
  const tokens = shellTokens(command);
  const dangerousReason = (value: string | undefined): boolean => {
    const normalized = (value ?? "").replace(/^['"]|['"]$/gu, "");
    return normalized === "cancelled" || normalized === "abandoned";
  };
  const segmentHasDangerousReason = (start: number, end: number): boolean => {
    for (let i = start; i < end; i += 1) {
      const token = tokens[i];
      if (token === "--reason" && dangerousReason(tokens[i + 1])) return true;
      if (token.startsWith("--reason=") && dangerousReason(token.slice("--reason=".length))) return true;
    }
    return false;
  };
  for (let segmentStart = 0; segmentStart < tokens.length;) {
    if (isShellSeparator(tokens[segmentStart])) {
      segmentStart += 1;
      continue;
    }
    const segmentEnd = shellCommandEnd(tokens, segmentStart);
    const commandIdx = shellCommandIndexInSegment(tokens, segmentStart, segmentEnd);
    if (commandIdx === null) {
      segmentStart = segmentEnd;
      continue;
    }
    const token = shellCommandName(tokens[commandIdx]);
    if (token === "superspec" && tokens[commandIdx + 1] === "guard" && tokens[commandIdx + 2] === "hook-session-end") {
      if (segmentHasDangerousReason(commandIdx + 3, segmentEnd)) return true;
    }
    if (token === "superspec" && tokens[commandIdx + 1] === "check" && tokens[commandIdx + 2] === "hook-session-end") {
      if (segmentHasDangerousReason(commandIdx + 3, segmentEnd)) return true;
    }
    if (token === "superspec" && tokens[commandIdx + 1] === "hook-session-end") {
      if (segmentHasDangerousReason(commandIdx + 2, segmentEnd)) return true;
    }
    if (token === "superspec-guard" && tokens[commandIdx + 1] === "hook-session-end") {
      if (segmentHasDangerousReason(commandIdx + 2, segmentEnd)) return true;
    }
    if (isHookEntrypointName(token) && tokens[commandIdx + 1] === "hook-session-end") {
      if (segmentHasDangerousReason(commandIdx + 2, segmentEnd)) return true;
    }
    const nodeEntrypoint = nodeScriptHookEntrypoint(tokens, commandIdx);
    if (nodeEntrypoint && tokens[nodeEntrypoint.argStart] === "hook-session-end") {
      if (segmentHasDangerousReason(nodeEntrypoint.argStart + 1, segmentEnd)) return true;
    }
    if (depth < 3) {
      for (const nested of nestedExecutableCommandsAt(tokens, commandIdx, segmentEnd)) {
        if (commandLooksLikeUnsafeLifecycleTermination(nested.command, depth + 1)) return true;
      }
    }
    segmentStart = segmentEnd;
  }
  if (depth < 3 && commandSubstitutions(command).some((nestedCommand) => commandLooksLikeUnsafeLifecycleTermination(nestedCommand, depth + 1))) {
    return true;
  }
  return false;
}

function sameShellCommandArguments(tokens: string[], start: number, end: number): string[] {
  const args: string[] = [];
  for (let idx = start; idx < end; idx += 1) {
    const token = tokens[idx];
    if (token === "}") continue;
    const redirect = redirectionTarget(tokens, idx);
    if (redirect) {
      idx += redirect.skip - 1;
      continue;
    }
    args.push(token);
  }
  return args;
}

function npmLikeTestCommand(name: string, args: string[]): boolean {
  if (name === "npm") {
    if (args[0] === "test" || args[0] === "t") return true;
    return args[0] === "run" && /^(?:test(?::[A-Za-z0-9_.-]+)?|typecheck|build)$/u.test(args[1] ?? "");
  }
  if (["pnpm", "yarn", "bun"].includes(name)) {
    if (args[0] === "test") return true;
    return args[0] === "run" && /^(?:test(?::[A-Za-z0-9_.-]+)?|typecheck|build)$/u.test(args[1] ?? "");
  }
  return false;
}

export function commandLooksLikeTestValidation(command: string, depth = 0): boolean {
  const tokens = shellTokens(command);
  const last = lastShellCommandSegment(tokens);
  if (!last) return false;
  const name = shellCommandName(tokens[last.commandIdx]);
  const args = sameShellCommandArguments(tokens, last.commandIdx + 1, last.segmentEnd);
  if (name === "openspec" && args[0] === "validate") return true;
  if (name === "node" && args.includes("--test")) return true;
  if (npmLikeTestCommand(name, args)) return true;
  if (["pytest", "vitest", "jest", "mocha"].includes(name)) return true;
  if (name === "go" && args[0] === "test") return true;
  if (name === "cargo" && args[0] === "test") return true;
  if (name === "tsc" && args.includes("--noEmit")) return true;
  if (depth >= 3) return false;
  const nested = nestedShellCommandAt(tokens, last.commandIdx, last.segmentEnd)
    ?? envSplitCommandAt(tokens, last.commandIdx, last.segmentEnd)
    ?? evalCommandAt(tokens, last.commandIdx, last.segmentEnd);
  return nested ? commandLooksLikeTestValidation(nested, depth + 1) : false;
}

function addExecutableTextShellPaths(texts: string[], paths: Set<string>, cwd: string, repoRoot: string, reasons: Reason[]): boolean {
  let writes = false;
  for (const text of texts) {
    const shell = extractShellPaths(text, cwd, repoRoot, reasons);
    for (const path of shell.paths) paths.add(path);
    writes = writes || shell.shell_write_command;
  }
  return writes;
}

export function extractWriteIntent(event: HookEvent, repoRoot: string): WriteExtraction {
  const normalized = normalizeHookEvent(event);
  const toolInput = isObject(event.tool_input) ? event.tool_input : {};
  const executableTexts = [normalized.command, ...executableTextValues(toolInput)].filter(Boolean);
  const textWriteCommand = executableTexts.some((text) => executableTextWriteCommand(text));
  const trustTextMatches = [...new Set(executableTexts.flatMap((text) => trustRootTextMatches(text)))].sort();
  const paths = new Set<string>();
  const tool = normalized.tool_name;
  const command = normalized.command;
  const reasons: Reason[] = [];
  let shellWriteCommand = false;
  if (tool === "apply_patch" || tool === "Edit" || tool === "Write") {
    for (const path of extractPatchPaths(command, normalized.cwd, repoRoot, reasons)) paths.add(path);
    for (const path of extractToolInputPaths(event, normalized.cwd, repoRoot, reasons)) paths.add(path);
  } else if (tool === "Bash") {
    const shell = extractShellPaths(command, normalized.cwd, repoRoot, reasons);
    for (const path of shell.paths) paths.add(path);
    shellWriteCommand = shell.shell_write_command || textWriteCommand;
  } else if (tool.startsWith("mcp__")) {
    for (const path of extractToolInputPaths(event, normalized.cwd, repoRoot, reasons)) paths.add(path);
    const executableShellWrite = addExecutableTextShellPaths(executableTexts, paths, normalized.cwd, repoRoot, reasons);
    shellWriteCommand = paths.size > 0 || textWriteCommand || executableShellWrite;
    reasons.push(reason("unsupported_write_surface", `hook surface ${tool} has no strict write classifier`));
  } else if (tool) {
    const inputPaths = extractToolInputPaths(event, normalized.cwd, repoRoot, reasons);
    for (const path of inputPaths) paths.add(path);
    const executableShellWrite = addExecutableTextShellPaths(executableTexts, paths, normalized.cwd, repoRoot, reasons);
    shellWriteCommand = paths.size > 0 || textWriteCommand || executableShellWrite;
    reasons.push(reason("unsupported_write_surface", `hook surface ${tool} has no strict write classifier`));
  }
  if (paths.size === 0 && ["apply_patch", "Edit", "Write"].includes(tool)) {
    reasons.push(reason("unknown_patch_shape", `${tool} event did not expose concrete target paths`));
  }
  const transitions = taskCheckboxTransitions(command);
  return {
    target_paths: [...paths].sort(),
    trust_root_text_matches: trustTextMatches,
    archive_command: commandLooksLikeArchive(command),
    internal_hook_writer_command: commandLooksLikeInternalHookWriter(command),
    unsafe_lifecycle_termination_command: commandLooksLikeUnsafeLifecycleTermination(command),
    unsupported_write_surface: reasons.some((item) => item.code === "unsupported_write_surface"),
    task_checkbox_completions: transitions.completions,
    task_checkbox_reopens: transitions.reopens,
    shell_write_command: shellWriteCommand,
    reasons,
  };
}

export function eventContentHash(event: HookEvent): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(event), "utf8").digest("hex")}`;
}

export function nonce(): string {
  return randomUUID();
}

export function relFromChangeOrRepo(repoRoot: string, changeRoot: string, pathValue: string): { root: "repo" | "change"; path: string } | null {
  const abs = isAbsolute(pathValue) ? pathValue : resolve(repoRoot, pathValue);
  const changeRel = relative(changeRoot, abs);
  if (changeRel && !changeRel.startsWith("..") && !isAbsolute(changeRel)) return { root: "change", path: toPosix(changeRel) };
  const repoRel = relative(repoRoot, abs);
  if (repoRel && !repoRel.startsWith("..") && !isAbsolute(repoRel)) return { root: "repo", path: toPosix(repoRel) };
  return null;
}

export function pinnedFileRef(baseRoot: string, relPath: string): JsonMap | null {
  const target = safe_within(baseRoot, relPath);
  if (target === null || !existsSync(target) || !statSync(target).isFile()) return null;
  const data = readFileSync(target);
  return {
    path: toPosix(relPath),
    blob_sha: `sha256:${createHash("sha256").update(data).digest("hex")}`,
  };
}

export function renderReasons(reasons: Reason[]): string {
  return renderList(reasons.map((item) => item.code).sort());
}
