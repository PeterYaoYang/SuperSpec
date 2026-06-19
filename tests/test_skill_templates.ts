import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("skill templates: current branch surfaces are transition/record/jobs, not unavailable guard commands", () => {
  const explore = read("../templates/workflow/skills/superspec-explore/SKILL.md");
  const propose = read("../templates/workflow/skills/superspec-propose/SKILL.md");
  const apply = read("../templates/workflow/skills/superspec-apply/SKILL.md");
  const archive = read("../templates/workflow/skills/superspec-archive/SKILL.md");

  assert.match(explore, /superspec transition next --change "<change>"/);
  assert.match(explore, /superspec transition explore --change "<change>"/);
  assert.match(explore, /superspec record user-decision --change "<change>" --input <decision\.json>/);
  assert.match(explore, /openspec list --json/);
  assert.match(explore, /openspec status --change "<change>" --json/);
  assert.match(explore, /不要把 `superspec status` 的 job 计数当成权威事实/);
  assert.match(explore, /把对应未决项从 `- \[ \]` 改成 `- \[x\]`/);
  assert.match(explore, /只留档、不回写 `discovery\.md`，阶段还是过不去/);
  assert.match(explore, /不要伪造当前分支没有的 `superspec check`/);
  assert.doesNotMatch(explore, /```bash\nsuperspec check/);

  assert.match(propose, /openspec status --change "<change>" --json/);
  assert.match(propose, /openspec instructions <artifact> --change "<change>" --json/);
  assert.match(propose, /superspec transition propose-ready --change "<change>" --risk strict/);
  assert.match(propose, /minimal/);
  assert.match(propose, /normal/);
  assert.match(propose, /strict/);
  assert.match(propose, /proposal-auditor/);
  assert.match(propose, /critic-review/);
  assert.match(propose, /architect-review/);
  assert.match(propose, /test-engineer-review/);
  assert.match(propose, /不要把 `superspec status` 的 job 计数当 propose 审查真相/);
  assert.match(propose, /`boundFiles` 不包含 `specs\/\*\*\/\*\.md`/);
  assert.match(propose, /`tdd_required:false` 和 `no_tdd_reason` 必须写在同一条 `TASK-\*` 任务行里/);
  assert.doesNotMatch(propose, /任务行或紧邻说明/);
  assert.match(propose, /superspec jobs packet --change "<change>" --job "<job-id>"/);
  assert.match(propose, /superspec record job-submit --change "<change>" --job "<job-id>" --report <report\.json>/);
  assert.match(propose, /不要绕过 `openspec instructions` 徒手另造一套 OpenSpec artifact 写法/);
  assert.doesNotMatch(propose, /```bash\nsuperspec check/);

  assert.match(apply, /openspec instructions apply --change "<change>" --json/);
  assert.match(apply, /superspec transition start-apply --change "<change>"/);
  assert.match(apply, /superspec transition task-start --change "<change>" --task "<TASK-ID>"/);
  assert.match(apply, /task_structure_digest/);
  assert.match(apply, /snapshot\.json/);
  assert.match(apply, /tdd_required:false/);
  assert.match(apply, /no_tdd_reason/);
  assert.match(apply, /不要同时保留多个 active attempt/);
  assert.match(apply, /不按 `task_id` 或 `attempt_id` 绑定/);
  assert.match(apply, /流程纪律，不是引擎校验项/);
  assert.match(apply, /当前 CLI 没有 return-to-propose \/ reopen surface/);
  assert.match(apply, /不要假装存在回退到 propose 的命令/);
  assert.match(apply, /superspec record test-run --change "<change>" --input <red\.json>/);
  assert.match(apply, /superspec transition task-complete --change "<change>" --task "<TASK-ID>"/);
  assert.match(apply, /不要发明当前分支没有的 `superspec check` \/ `apply_worker_chain` \/ `apply_isolation`/);
  assert.doesNotMatch(apply, /```bash\nsuperspec check/);

  assert.match(archive, /superspec transition archive --change "<change>"/);
  assert.match(archive, /artifact_recorded/);
  assert.match(archive, /events\.jsonl/);
  assert.match(archive, /没有执行物理 OpenSpec archive/);
  assert.match(archive, /`sha256:missing`/);
  assert.match(archive, /archive rollback \/ retry surface/);
  assert.doesNotMatch(archive, /```bash\nopenspec archive -y/);
  assert.doesNotMatch(archive, /```bash\nsuperspec check check-archive-ready/);
  assert.doesNotMatch(archive, /```bash\nsuperspec check check-archived/);
});

test("skill templates: review is explicit about final-audit surface and current engine limitations", () => {
  const review = read("../templates/workflow/skills/superspec-review/SKILL.md");
  const all = [
    read("../templates/workflow/skills/superspec-explore/SKILL.md"),
    read("../templates/workflow/skills/superspec-propose/SKILL.md"),
    read("../templates/workflow/skills/superspec-apply/SKILL.md"),
    review,
    read("../templates/workflow/skills/superspec-archive/SKILL.md"),
  ].join("\n");

  assert.match(review, /final-audit/);
  assert.match(review, /superspec transition review-ready --change "<change>"/);
  assert.match(review, /superspec jobs packet --change "<change>" --job "<job-id>"/);
  assert.match(review, /superspec record job-submit --change "<change>" --job "<job-id>" --report <final-audit\.json>/);
  assert.match(review, /superspec transition accept --change "<change>"/);
  assert.match(review, /code-reviewer/);
  assert.match(review, /critic/);
  assert.match(review, /architect/);
  assert.match(review, /verifier/);
  assert.match(review, /openspec validate <change>/);
  assert.match(review, /当前分支没有 `verify_failure_handling` record surface/);
  assert.match(review, /当前分支没有 review -> apply 的返回 transition/);
  assert.match(review, /不要对已经终态的旧 job 反复提交新 report/);
  assert.match(review, /open job 还在时它不会发新 job/);
  assert.match(review, /旧 job 才会因为 `boundFiles` 失配被拒绝终态化/);
  assert.match(review, /不要指望 report 内容本身能帮你回退/);
  assert.match(review, /不绑定源码文件或测试文件/);
  assert.match(review, /不是源码 \/ 测试 freshness 证明/);
  assert.match(review, /如果这次修复只改了源码或测试，而没改任何 `boundFiles`，当前 engine 没有自动 invalidation 路径/);
  assert.match(review, /源码 \/ 测试-only 修复不能靠旧 job 的 `boundFiles` 失配来解锁/);
  assert.match(review, /如果旧 `final-audit` job 已经因为 `boundFiles` 失配或 report 拒绝而进入终态/);
  assert.match(review, /不要发明当前分支没有的 `source_guidance` \/ `verification_review` \/ `main_adjudication` \/ `superspec check`/);
  assert.doesNotMatch(review, /```bash\nsuperspec check/);
  assert.doesNotMatch(review, /kind:"main_adjudication"/);
  assert.doesNotMatch(review, /kind:"verification_review"/);
  assert.doesNotMatch(all, /\.codex\/skills\/openspec-/);
  assert.doesNotMatch(all, /你不再携带工作流协议/);
  assert.doesNotMatch(review, /当前用户已明确要求/);
});
