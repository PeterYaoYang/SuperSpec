import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageJson {
  version?: string;
}

function readPackageVersion(): string {
  const pkg = require("../package.json") as PackageJson;
  if (!pkg.version) throw new Error("package.json 缺少 version 字段");
  return pkg.version;
}

export const SUPERSPEC_VERSION = readPackageVersion();
