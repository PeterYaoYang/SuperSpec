// SuperSpec：next 给主流程的路径与转换效果必须可直接使用，不需要模型自行推断

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureChangeLayout, appendEvent, makeEvent } from "../src/store.ts";
import { next } from "../src/next.ts";
import { transitionExplore } from "../src/transition.ts";
import { exploreAnswerRegistrationPayload } from "../src/explore_round.ts";
import { prepareCurrentPhaseConfirmation } from "./phase_confirmation_support.ts";

function setupExplore(): { projectRoot: string; change: string; changeRoot: string; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "superspec-guidance-"));
  const change = "guidance-change";
  const changeRoot = join(projectRoot, "openspec", "changes", change);
  mkdirSync(join(changeRoot, ".superspec", "artifacts"), { recursive: true });
  ensureChangeLayout(projectRoot, change);
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "init", from_state: "init", to_state: "init",
    outcome: "advanced", created_job_ids: [], reason: "init",
  }, { transitionId: "T-init", idempotencyKey: "init-key" }));
  appendEvent(projectRoot, change, makeEvent(change, "transition_commit", {
    transition: "explore", from_state: "init", to_state: "explore",
    outcome: "advanced", created_job_ids: [], reason: "enter explore",
    ...exploreAnswerRegistrationPayload(null),
  }, { transitionId: "T-explore", idempotencyKey: "explore-key" }));
  return { projectRoot, change, changeRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

test("next 每次都给出当前 change 各材料相对项目根的位置", () => {
  const fx = setupExplore();
  try {
    const missing = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(missing.path, "artifact_required");
    if (missing.path !== "artifact_required") throw new Error("expected artifact_required");
    assert.equal(missing.material_paths.discovery, missing.artifact.path);
    assert.deepEqual(missing.material_paths, {
      change_root: `openspec/changes/${fx.change}`,
      discovery: `openspec/changes/${fx.change}/.superspec/artifacts/discovery.md`,
      proposal: `openspec/changes/${fx.change}/proposal.md`,
      specs: `openspec/changes/${fx.change}/specs/`,
      design: `openspec/changes/${fx.change}/design.md`,
      test_contract: `openspec/changes/${fx.change}/.superspec/artifacts/test-contract.md`,
      tasks: `openspec/changes/${fx.change}/tasks.md`,
    });
    for (const path of Object.values(missing.material_paths)) {
      assert.ok(!path.startsWith(".superspec/"), `材料路径不能落到项目根状态目录：${path}`);
    }
  } finally { fx.cleanup(); }
});

test("Explore 问题标成已确认却没有登记答复时，提示里的 discovery 位置可以直接使用", () => {
  const fx = setupExplore();
  try {
    writeFileSync(join(fx.changeRoot, ".superspec", "artifacts", "discovery.md"), [
      "# Discovery",
      "",
      "## 待确认问题",
      "- [x] Q-001 [范围] 是否纳入 A？影响：范围。选项：A 纳入 / B 不纳入。建议：A",
      "",
    ].join("\n"));
    const blocked = next(fx.projectRoot, fx.change, fx.changeRoot);
    assert.equal(blocked.path, "material_update_required");
    if (blocked.path !== "material_update_required") throw new Error("expected material_update_required");
    assert.ok(blocked.errors.some(error => error.includes(blocked.material_paths.discovery)), blocked.errors.join("\n"));
  } finally { fx.cleanup(); }
});

test("discovery 在审查通过后变化：next 标明执行转换只会创建审查，不会进入计划阶段", () => {
  const fx = setupExplore();
  try {
    const discoveryPath = join(fx.changeRoot, ".superspec", "artifacts", "discovery.md");
    writeFileSync(discoveryPath, "# Discovery\n\nFound stuff.\n");
    const confirmation = prepareCurrentPhaseConfirmation(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.match(confirmation.ask_user.scope, /^phase_confirmation:explore_to_propose:/);

    writeFileSync(discoveryPath, `${readFileSync(discoveryPath, "utf8")}\nMore evidence.\n`);
    const stale = next(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(stale.path, "next_command");
    if (stale.path !== "next_command") throw new Error("expected next_command");
    assert.deepEqual(stale.creates_review_jobs, ["critic"]);

    const transition = transitionExplore(fx.projectRoot, fx.change, fx.changeRoot, "normal");
    assert.equal(transition.outcome, "job_created");
    assert.equal(transition.to_state, "explore");
  } finally { fx.cleanup(); }
});
