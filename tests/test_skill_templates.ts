import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function assertIncludesAll(label: string, content: string, needles: readonly string[]): void {
  for (const needle of needles) {
    assert.ok(content.includes(needle), `${label} should include ${needle}`);
  }
}

test("explore/propose skills default to strict review routing", () => {
  const explore = read("../templates/workflow/skills/superspec-explore/SKILL.md");
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");

  assertIncludesAll("explore skill", explore, [
    'superspec transition next --change "<change>"',
    "`critic`",
    "subagent",
    "只读深扫",
    "当前代码事实",
    "影响范围候选",
    "## 待确认问题",
  ]);
  assert.doesNotMatch(explore, /默认 `risk=normal`/);
  assert.doesNotMatch(explore, /--risk strict|risk strict|jobs packet|provenance/);

  assertIncludesAll("propose skill", propose, [
    'superspec transition next --change "<change>"',
    "`critic`",
    "`architect`",
    "`test-engineer`",
    "record job-submit",
    "record user-decision",
    "openspec/config.yaml",
    "context",
  ]);
  assert.doesNotMatch(propose, /`proposal-auditor`/);
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

test("workflow record guidance prefers stdin over temporary JSON files", () => {
  const skillFiles = [
    "../templates/workflow/skills/superspec-explore/SKILL.md",
    "../templates/workflow/skills/superspec-propose/SKILL.md",
    "../templates/workflow/skills/superspec-apply/SKILL.md",
    "../templates/workflow/skills/superspec-review/SKILL.md",
  ];
  const promptFiles = [
    "../templates/workflow/prompts/critic.md",
    "../templates/workflow/prompts/architect.md",
    "../templates/workflow/prompts/test-engineer.md",
  ];

  for (const file of [...skillFiles, ...promptFiles]) {
    const content = read(file);
    assert.doesNotMatch(content, /--input <FILE>|--report <FILE>|报告文件|写入 JSON 文件/, file);
  }

  assert.match(read("../templates/workflow/skills/superspec-explore/SKILL.md"), /--input -/);
  assert.match(read("../templates/workflow/skills/superspec-explore/SKILL.md"), /--report -/);
  assert.match(read("../templates/workflow/skills/superspec-propose/SKILL.md"), /--input -/);
  assert.match(read("../templates/workflow/skills/superspec-propose/SKILL.md"), /--report -/);
  assert.match(read("../templates/workflow/skills/superspec-apply/SKILL.md"), /--input -/);
  assert.match(read("../templates/workflow/skills/superspec-review/SKILL.md"), /--report -/);
});

test("review agent toml contracts require reviewer only for proposal review roles", () => {
  for (const agent of ["critic", "architect", "test-engineer"]) {
    const content = read(`../templates/workflow/agents/${agent}.toml`);
    assert.match(content, /reviewer:\{kind,id\}/, `${agent} should require reviewer provenance`);
  }

  const verifier = read("../templates/workflow/agents/verifier.toml");
  assert.doesNotMatch(verifier, /reviewer:\{kind,id\}|reviewer provenance|reviewer\.kind/);
});

test("review and archive skills require user confirmation before archive", () => {
  const review = read("../templates/workflow/skills/superspec-review/SKILL.md");
  const archive = read("../templates/workflow/skills/superspec-archive/SKILL.md");

  assertIncludesAll("review skill archive confirmation", review, [
    "推进到 accepted",
    "等待用户确认归档",
    "不要自动 archive",
  ]);
  assertIncludesAll("archive skill archive confirmation", archive, [
    "用户明确确认归档",
    "`archive_confirmation`",
    "不替用户确认归档",
  ]);
});

test("explore and critic prompts preserve discovery quality gates", () => {
  const explore = read("../templates/workflow/prompts/explore.md");
  const critic = read("../templates/workflow/prompts/critic.md");

  assertIncludesAll("explore prompt", explore, [
    "explore subagent",
    "不要输出实现方案",
    "不要替主流程做取舍",
    "path:line",
  ]);

  assertIncludesAll("critic discovery prompt", critic, [
    "Discovery 审查口径",
    "repo source anchors",
    "需求理解",
    "当前实现",
    'verdict:"fail"',
  ]);
});

test("input data source contract is consistent across producer and consumers", () => {
  const exploreSkill = read("../templates/workflow/skills/superspec-explore/SKILL.md");
  const explorePrompt = read("../templates/workflow/prompts/explore.md");
  const proposeSkill = read("../templates/workflow/skills/superspec-propose/SKILL.md");
  const critic = read("../templates/workflow/prompts/critic.md");
  const architect = read("../templates/workflow/prompts/architect.md");
  const testEngineer = read("../templates/workflow/prompts/test-engineer.md");
  const verifier = read("../templates/workflow/prompts/verifier.md");
  const executor = read("../templates/workflow/prompts/executor.md");

  const SECTION = "## 输入数据来源核查";

  // producer defines the full schema, default-on (not selective-trigger)
  assertIncludesAll("explore skill defines schema", exploreSkill, [
    SECTION, "默认必做",
    "核查ID", "消费位置", "必需输入", "数据来源", "区分依据", "状态/理由",
    "已证明", "未知阻塞", "未知非阻塞",
    "producer", "consumer", "最后一次变形",
  ]);
  // 区分依据 must carry negative examples (anti empty-talk)
  assertIncludesAll("explore skill 区分依据 anti-patterns", exploreSkill, ["代码审查", "见上"]);
  // explore subagent prompt aligned with skill (producer-internal consistency)
  assertIncludesAll("explore prompt aligned", explorePrompt, [
    SECTION, "默认必做", "区分依据", "未知阻塞", "producer", "consumer", "最后一次变形",
  ]);

  // propose threads IDC into Impact/design + 输入数据覆盖验证
  assertIncludesAll("propose threads IDC + coverage", proposeSkill, [
    "IDC-xxx", "## 输入数据覆盖验证", "输入链路声明", "producer",
  ]);

  // every consumer references the SAME section name (canonical term consistency)
  for (const c of [critic, architect, testEngineer, verifier]) {
    assert.ok(c.includes(SECTION), "consumer should reference ## 输入数据来源核查");
  }
  // gating consumers reference 未知阻塞; test-engineer references 未知非阻塞
  for (const c of [critic, architect, verifier]) {
    assert.ok(c.includes("未知阻塞"), "consumer should reference 未知阻塞");
  }
  assert.ok(testEngineer.includes("未知非阻塞"), "test-engineer should reference 未知非阻塞");

  // critic is default-on and enforces 区分依据 quality bar
  assertIncludesAll("critic default-on + 区分依据 bar", critic, ["必须含 `## 输入数据来源核查`", "代码审查"]);
  // verifier keeps don't-trust-GREEN; executor keeps producer-to-consumer stop-condition
  assert.ok(verifier.includes("不得只用 GREEN"), "verifier keeps don't-trust-GREEN");
  assert.ok(executor.includes("producer-to-consumer"), "executor keeps producer-to-consumer stop-condition");
  assertIncludesAll("coverage trigger stays tied to IDC or runtime dependency", testEngineer + verifier, [
    "存在 `IDC-xxx` 核查项",
    "producer-to-consumer 输入数据依赖",
    "无运行时数据依赖并给出具体原因",
  ]);

  // negative: the dropped 适用性 marker must not survive anywhere
  const all = [exploreSkill, explorePrompt, proposeSkill, critic, architect, testEngineer, verifier, executor].join("\n");
  assert.doesNotMatch(all, /适用性: required|适用性: not_required/);
});

test("proposal impact guidance stays lightweight and design stays decision-focused", () => {
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");
  const apply = read("../templates/workflow/skills/superspec-apply/SKILL.md");
  const architect = read("../templates/workflow/prompts/architect.md");
  const critic = read("../templates/workflow/prompts/critic.md");
  const testEngineer = read("../templates/workflow/prompts/test-engineer.md");
  const verifier = read("../templates/workflow/prompts/verifier.md");

  assertIncludesAll("propose proposal/design guidance", propose, [
    "OpenSpec proposal 原生结构",
    "## Impact",
    "Area | Reason",
    "路径白名单",
    "OpenSpec design 原生结构",
    "不复制 `proposal.md`",
  ]);
  assert.doesNotMatch(propose, /对应关系：|对应 OpenSpec/);
  assert.doesNotMatch(propose, /## Why|## What Changes|## Capabilities|### New Capabilities|### Modified Capabilities/);
  assert.doesNotMatch(propose, /## Context|## Goals \/ Non-Goals|## Decisions|## Risks \/ Trade-offs/);
  assert.doesNotMatch(propose, /## 背景与动机|## 变更内容|## 能力变化|## 背景与现状|## 目标 \/ 非目标|## 关键决策|## 风险 \/ 取舍/);

  assertIncludesAll("apply impact guardrails", apply, [
    "`proposal.md`",
    "## Impact",
    "路径白名单",
    "同一任务下的局部引用",
    "不要在 apply 阶段补改 `proposal.md`",
    "`task-complete`",
  ]);
  assertIncludesAll("apply protected docs", apply, [
    "`proposal.md`",
    "`design.md`",
    "`specs/**`",
    "`.superspec/**`",
  ]);

  assertIncludesAll("architect planning prompt", architect, [
    "计划 / 设计审查口径",
    "`proposal.md`",
    "## Impact",
    "Area",
    "Reason",
    "`design.md`",
    "`tasks.md`",
  ]);

  assertIncludesAll("critic planning prompt", critic, [
    "Propose 审查口径",
    "`proposal.md`",
    "## Impact",
    "Area",
    "Reason",
    "路径白名单",
  ]);

  assert.doesNotMatch(testEngineer, /相关代码说明|影响范围表|任务粒度审查口径/);

  assertIncludesAll("verifier planning prompt", verifier, [
    "计划 / 设计验证口径",
    "`proposal.md`",
    "## Impact",
    "`design.md`",
    "`tasks.md`",
    "record test-run",
  ]);

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

test("tasks grouping stays lightweight and RED GREEN evidence stays in apply", () => {
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");
  const apply = read("../templates/workflow/skills/superspec-apply/SKILL.md");
  const architect = read("../templates/workflow/prompts/architect.md");
  const critic = read("../templates/workflow/prompts/critic.md");
  const testEngineer = read("../templates/workflow/prompts/test-engineer.md");
  const verifier = read("../templates/workflow/prompts/verifier.md");

  assertIncludesAll("propose tasks guidance", propose, [
    "OpenSpec tasks",
    "顶格 checkbox",
    "<task_id>",
    "tdd_required:true",
    "tdd_required:false",
    "no_tdd_reason",
    "RED/GREEN",
    "record test-run",
  ]);
  assert.doesNotMatch(propose, /^ {2,}- \[ \]/m);
  assert.doesNotMatch(propose, /^##\s+(?:\d+(?:\.\d+)*|TASK-\d+)/m);

  assertIncludesAll("apply task and evidence guidance", apply, [
    "--task <task_id>",
    "Markdown 标题",
    "`tasks.md`",
    "RED/GREEN",
    "record test-run",
    "attempt_id",
    "semantic_status",
    "task_structure_digest",
    "目标测试身份",
  ]);
  assert.doesNotMatch(apply, /raw_log_ref/);

  assertIncludesAll("critic task review prompt", critic, [
    "`tasks.md`",
    "任务拆分",
    "task id",
    "RED/GREEN",
  ]);
  assertIncludesAll("architect task review prompt", architect, [
    "`tasks.md`",
    "Markdown 标题",
    "顶格 checkbox",
    "父子任务状态",
  ]);
  assertIncludesAll("test engineer task review prompt", testEngineer, [
    "`tasks.md`",
    "RED/GREEN",
    "record test-run",
    "tdd_required:false",
    "no_tdd_reason",
  ]);
  assertIncludesAll("verifier test evidence prompt", verifier, [
    "RED/GREEN",
    "record test-run",
    "attempt_id",
    "exit_code",
    "semantic_status",
    "raw_index",
    "raw_digest",
  ]);

  const combined = [propose, apply, architect, critic, testEngineer, verifier].join("\n");
  assert.doesNotMatch(combined, /父子任务状态机|父任务完成规则|子任务继承 RED\/GREEN|新增命令/);
});

test("workflow role templates avoid packet plumbing language", () => {
  const promptsDir = new URL("../templates/workflow/prompts/", import.meta.url);
  const promptBanned = /## SuperSpec Packet 规则|prompt_ref|review-packet|apply-[a-z-]*-packet|workflow-packet|required_output_kind|output_contract_fields|stop_conditions|\blane\b/;
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
