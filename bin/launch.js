export const REQUIRED_NODE_VERSION = "20.19.0";
const REQUIRED_NODE_PARTS = REQUIRED_NODE_VERSION.split(".").map((part) => Number.parseInt(part, 10));

function compareNodeVersion(version) {
  const parts = String(version).split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < REQUIRED_NODE_PARTS.length; index += 1) {
    const actual = parts[index] ?? 0;
    const required = REQUIRED_NODE_PARTS[index] ?? 0;
    if (!Number.isFinite(actual)) return -1;
    if (actual > required) return 1;
    if (actual < required) return -1;
  }
  return 0;
}

export function nodeVersionError(version = process.versions.node) {
  if (compareNodeVersion(version) >= 0) return null;
  return `SuperSpec requires Node.js >=${REQUIRED_NODE_VERSION}. Current Node.js is ${version}. Upgrade Node.js, then rerun the command.`;
}

export function assertSupportedNode(version = process.versions.node) {
  const message = nodeVersionError(version);
  if (message === null) return;
  console.error(message);
  process.exit(1);
}

export async function runEntry(entryPath, exportName, argv = process.argv.slice(2)) {
  assertSupportedNode();
  const mod = await import(new URL(entryPath, import.meta.url).href);
  const main = mod[exportName];
  if (typeof main !== "function") {
    console.error(`SuperSpec internal error: ${entryPath} does not export ${exportName}`);
    process.exit(2);
  }
  process.exitCode = await main(argv);
}
