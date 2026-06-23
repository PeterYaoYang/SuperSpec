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
  assert.match(explore, /涉及多个文件、模块、入口或文件类型时，使用 `explore` subagent 做只读深扫/);
  assert.match(explore, /当前代码事实/);
  assert.match(explore, /影响范围候选/);
  assert.match(explore, /只有 `## 待确认问题` 段落内的 `- \[ \]` 表示阻塞确认项/);
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

test("explore and critic prompts preserve discovery quality gates", () => {
  const explore = read("../templates/workflow/prompts/explore.md");
  const critic = read("../templates/workflow/prompts/critic.md");

  assert.match(explore, /explore subagent 深扫/);
  assert.match(explore, /不要输出实现方案/);
  assert.match(explore, /不要替主流程做取舍/);
  assert.match(explore, /path:line/);

  assert.match(critic, /Discovery 审查口径/);
  assert.match(critic, /代码影响型需求必须包含 repo source anchors/);
  assert.match(critic, /需求理解.*当前实现/s);
  assert.match(critic, /verdict:"fail"/);
});

test("proposal impact guidance stays lightweight and design stays decision-focused", () => {
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");
  const apply = read("../templates/workflow/skills/superspec-apply/SKILL.md");
  const architect = read("../templates/workflow/prompts/architect.md");
  const critic = read("../templates/workflow/prompts/critic.md");
  const testEngineer = read("../templates/workflow/prompts/test-engineer.md");
  const verifier = read("../templates/workflow/prompts/verifier.md");

  assert.match(propose, /使用 OpenSpec proposal 原生结构/);
  assert.match(propose, /## Impact/);
  assert.match(propose, /范围 \| 原因/);
  assert.match(propose, /为什么该范围受影响/);
  assert.match(propose, /不作为路径白名单/);
  assert.match(propose, /使用 OpenSpec design 原生结构/);
  assert.match(propose, /不复制 `proposal\.md` 的影响范围表/);
  assert.doesNotMatch(propose, /对应关系：|对应 OpenSpec/);
  assert.doesNotMatch(propose, /## Why|## What Changes|## Capabilities|### New Capabilities|### Modified Capabilities/);
  assert.doesNotMatch(propose, /## Context|## Goals \/ Non-Goals|## Decisions|## Risks \/ Trade-offs/);
  assert.doesNotMatch(propose, /## 背景与动机|## 变更内容|## 能力变化|## 背景与现状|## 目标 \/ 非目标|## 关键决策|## 风险 \/ 取舍/);

  assert.match(apply, /参考 `proposal\.md` 的 `## Impact`/);
  assert.match(apply, /不要把它当作路径白名单/);
  assert.match(apply, /同一任务下的局部引用/);
  assert.match(apply, /不要在 apply 阶段补改 `proposal\.md`/);
  assert.match(apply, /不修改 `proposal\.md`、`design\.md`、`specs\/\*\*` 或 `\.superspec\/\*\*`/);
  assert.match(apply, /`task-complete` 自动勾选目标 checkbox/);

  assert.match(architect, /计划 \/ 设计审查口径/);
  assert.match(architect, /`proposal\.md` 的 `## Impact` 应说明 `范围 \/ 原因`/);
  assert.match(architect, /`design\.md` 应聚焦关键决策/);

  assert.match(critic, /Propose 审查口径/);
  assert.match(critic, /缺少 `## Impact`/);
  assert.match(critic, /没有说明 `范围 \/ 原因`/);
  assert.match(critic, /路径白名单/);

  assert.doesNotMatch(testEngineer, /相关代码说明|影响范围表|任务粒度审查口径/);

  assert.match(verifier, /计划 \/ 设计验证口径/);
  assert.match(verifier, /`proposal\.md` 的 `## Impact`/);
  assert.match(verifier, /diff 或引用链直接解释/);
  assert.match(verifier, /同一任务下的局部引用/);
  assert.match(verifier, /新增能力、用户可见行为、明显新增影响范围/);

  const proposalDesignVerifier = verifier.slice(verifier.indexOf("## 计划 / 设计验证口径"));
  const combined = [propose, apply, architect, critic, testEngineer, proposalDesignVerifier].join("\n");
  assert.doesNotMatch(combined, /## 相关代码说明|相关代码区域|相关代码说明/);
  assert.doesNotMatch(combined, /## 代码影响地图|影响地图/);
  assert.doesNotMatch(combined, /task\/executor 完成报告|executor report/);
  assert.doesNotMatch(combined, /declared_task_write_scope/);
  assert.doesNotMatch(combined, /task-abandon|scope-reopen/);
  assert.doesNotMatch(combined, /record .*task.*report|task report|raw.*task/i);
  assert.doesNotMatch(combined, /parser|解析器|解析逻辑|状态机|state machine|snapshot|raw JSONL|raw archive/i);
  assert.doesNotMatch(combined, /superspec transition (?!next\b|task-start\b|task-complete\b)[a-z-]+/);
  assert.doesNotMatch(combined, /superspec record (?!test-run\b|user-decision\b|job-submit\b)[a-z-]+/);
  assert.doesNotMatch(apply, /每个任务[\s\S]{0,120}先读当前 task 和 `design\.md`|执行前阅读上下文/);
  assert.doesNotMatch(apply, /更新 `proposal\.md`|更新 `design\.md`|只能.*影响范围|路径白名单.*必须/);
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
