import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("explore/propose skills default to strict review routing", () => {
  const explore = read("../templates/workflow/skills/superspec-explore/SKILL.md");
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");

  assert.match(explore, /superspec transition next --change "<change>" --risk strict/);
  assert.match(explore, /创建 `critic` 工作项/);
  assert.doesNotMatch(explore, /默认 `risk=normal`/);

  assert.match(propose, /superspec transition next --change "<change>" --risk strict/);
  assert.match(propose, /`proposal-auditor`/);
  assert.match(propose, /`critic`/);
  assert.match(propose, /`architect`/);
  assert.match(propose, /`test-engineer`/);
  assert.doesNotMatch(explore, /\b(?:clarification|critic)-review\b/);
  assert.doesNotMatch(propose, /\b(?:architect|critic|clarification|test-engineer)-review\b/);
  assert.match(propose, /`job_report_json`/);
});
