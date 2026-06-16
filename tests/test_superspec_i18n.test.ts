import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { reason_zh } from "../src/i18n.ts";

const REPO = resolve(import.meta.dirname, "..");

// 提取 src/ 里所有字面 reason("code") 调用的 code（动态模板拼接的 code 由 auto_reason_zh
// 模式合成覆盖，不在静态提取范围内）。对每个 code 调真实 reason_zh，断言不是通用兜底
// "未通过原因"——即必须有显式 REASON_ZH 翻译或能被 auto_reason_zh 合成模式命中。
test("every emitted reason code has a non-fallback Chinese translation", () => {
  const grep = execSync(`grep -rohE 'reason\\("[a-z_]+"' ${REPO}/src/`, { encoding: "utf8" });
  const codes = [...new Set(
    grep.split(/\r?\n/u)
      .map((line) => line.replace(/^reason\("/u, "").replace(/"$/u, ""))
      .filter(Boolean),
  )];
  assert.ok(codes.length > 100, `should extract many reason codes, got ${codes.length}`);

  const FALLBACK = "未通过原因";
  const fallback = codes.filter((code) => reason_zh(code).label_zh === FALLBACK);
  assert.deepEqual(
    fallback,
    [],
    `reason codes landing on generic fallback "${FALLBACK}" need an explicit REASON_ZH entry or an auto_reason_zh pattern: ${fallback.join(", ")}`,
  );
});
