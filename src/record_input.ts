// SuperSpec 流程引擎 — record JSON 输入的无损解码

import { readFileSync } from "node:fs";

/**
 * JSON record 输入只接受 UTF-8（可带 BOM）或带 BOM 的 UTF-16LE。
 * 不猜测系统 ANSI/GBK 等编码，避免把损坏文本静默归档为 UTF-8 JSONL。
 */
export class RecordInputDecodingError extends Error {
  constructor(message: string = "JSON 输入编码无效：仅支持 UTF-8（可带 BOM）或带 BOM 的 UTF-16LE") {
    super(message);
    this.name = "RecordInputDecodingError";
  }
}

function decode(bytes: Buffer, encoding: "utf-8" | "utf-16le"): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new RecordInputDecodingError();
  }
}

export function decodeRecordInput(bytes: Buffer): string {
  // UTF-8 BOM.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decode(bytes.subarray(3), "utf-8");
  }
  // Windows PowerShell 5.1 files and redirected output commonly use this form.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decode(bytes.subarray(2), "utf-16le");
  }
  return decode(bytes, "utf-8");
}

export function readRecordInputFile(path: string): string {
  return decodeRecordInput(readFileSync(path));
}
