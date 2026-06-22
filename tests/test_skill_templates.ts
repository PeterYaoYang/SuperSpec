import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("explore/propose skills default to strict review routing", () => {
  const explore = read("../templates/workflow/skills/superspec-explore/SKILL.md");
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");

  assert.match(explore, /superspec transition next --change "<change>"/);
  assert.match(explore, /创建 `critic` 工作项/);
  assert.doesNotMatch(explore, /默认 `risk=normal`/);
  assert.doesNotMatch(explore, /--risk strict|risk strict|jobs packet|provenance/);

  assert.match(propose, /superspec transition next --change "<change>"/);
  assert.doesNotMatch(propose, /`proposal-auditor`/);
  assert.match(propose, /`critic`/);
  assert.match(propose, /`architect`/);
  assert.match(propose, /`test-engineer`/);
  assert.match(propose, /完整审查路径/);
  assert.match(propose, /待用户确认/);
  assert.match(propose, /record user-decision/);
  assert.match(propose, /openspec\/config\.yaml/);
  assert.match(propose, /context/);
  assert.match(propose, /自定义 `language` 字段/);
  assert.doesNotMatch(propose, /^\s*language\s*:/m);
  assert.doesNotMatch(explore, /\b(?:clarification|critic)-review\b/);
  assert.doesNotMatch(propose, /\b(?:architect|critic|clarification|test-engineer)-review\b/);
  assert.doesNotMatch(propose, /--risk strict|risk strict|jobs packet|provenance/);
});

test("workflow skill templates have valid frontmatter fences", () => {
  const skillsDir = new URL("../templates/workflow/skills/", import.meta.url);
  for (const skill of readdirSync(skillsDir)) {
    const content = read(`../templates/workflow/skills/${skill}/SKILL.md`);
    assert.match(content, /^---\n[\s\S]*?\n---\n/, `${skill} should have YAML frontmatter`);
  }
});

test("review agent toml contracts require reviewer only for proposal review roles", () => {
  for (const agent of ["critic", "architect", "test-engineer"]) {
    const content = read(`../templates/workflow/agents/${agent}.toml`);
    assert.match(content, /reviewer:\{kind,id\}/, `${agent} should require reviewer provenance`);
  }

  const verifier = read("../templates/workflow/agents/verifier.toml");
  assert.doesNotMatch(verifier, /reviewer:\{kind,id\}|reviewer provenance|reviewer\.kind/);
});

test("workflow role templates avoid packet plumbing language", () => {
  const promptsDir = new URL("../templates/workflow/prompts/", import.meta.url);
  const promptBanned = /## SuperSpec Packet 规则|prompt_ref|review-packet|apply-[a-z-]*-packet|workflow-packet|required_output_kind|output_contract_fields|stop_conditions/;
  for (const file of readdirSync(promptsDir)) {
    if (!file.endsWith(".md")) continue;
    const content = read(`../templates/workflow/prompts/${file}`);
    assert.doesNotMatch(content, promptBanned, `${file} should use task-instructions wording`);
    assert.doesNotMatch(content.replace(/origin_packet_fingerprint/g, ""), /\bpacket\b/i, `${file} should not expose packet terminology`);
  }

  const agentsDir = new URL("../templates/workflow/agents/", import.meta.url);
  const agentBanned = /Prompt binding|prompt_ref|review-packet|apply-[a-z-]*-packet|workflow-packet|packet overrides static prompt memory|required_output_kind|output_contract_fields|stop_conditions/;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".toml")) continue;
    const content = read(`../templates/workflow/agents/${file}`);
    assert.doesNotMatch(content, agentBanned, `${file} should use task-instructions wording`);
    assert.doesNotMatch(content.replace(/origin_packet_fingerprint/g, ""), /\bpacket\b/i, `${file} should not expose packet terminology`);
  }
});

test("workflow templates no longer publish removed auditor roles", () => {
  const promptsDir = new URL("../templates/workflow/prompts/", import.meta.url);
  const agentsDir = new URL("../templates/workflow/agents/", import.meta.url);

  assert.equal(readdirSync(promptsDir).includes("proposal-auditor.md"), false);
  assert.equal(readdirSync(agentsDir).includes("proposal-auditor.toml"), false);
  assert.equal(readdirSync(promptsDir).includes("final-audit.md"), false);
  assert.equal(readdirSync(agentsDir).includes("final-audit.toml"), false);
});
