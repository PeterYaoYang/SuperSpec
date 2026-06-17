// SuperSpec 流程引擎 — transition：提交协议 + propose-ready 处理器
// 所有状态校验在锁内完成（BLOCKER 1 修复）

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  ensureChangeLayout, readEvents, appendEvent, makeEvent,
  writeSnapshot, snapshotDigest, withLock, idempotencyKey, stagingDir,
  sha256File, sha256Text,
} from "./store.ts";
import { rebuildSnapshot } from "./sync.ts";
import type {
  Event, Snapshot, State, Job, JobRole, TransitionResult, Ref,
} from "./types.ts";

let transitionSeq = 0;
function newTransitionId(): string { return `T-${Date.now()}-${++transitionSeq}`; }
let jobSeq = 0;
function newJobId(change: string, role: string): string { return `JOB-${change.slice(0, 8)}-${role.slice(0, 4)}-${Date.now()}-${++jobSeq}`; }

const TRANSITION_REQUIREMENTS: Record<string, Record<string, JobRole[]>> = {
  "propose-ready": {
    minimal: [],
    normal:  ["proposal-auditor"],
    strict:  ["critic-review", "architect-review", "test-engineer-review"],
  },
};

/** 决策结果（由 decide 回调在锁内返回） */
interface Decision {
  fromState: State;
  toState: State;
  outcome: "advanced" | "job_created";
  newJobs?: Job[];
  reason: string;
}

/**
 * 统一 transition 提交协议——所有校验在锁内（BLOCKER 1 修复）。
 * decide 回调在锁内运行，看到的是最新 snapshot。
 */
export function commitTransition(
  projectRoot: string,
  change: string,
  changeRoot: string,
  opts: {
    name: string;
    decide: (snapshot: Snapshot) => Decision | { skip: true; message: string };
    idempotencyInputs?: Record<string, unknown>;
  }
): TransitionResult {
  const { name } = opts;

  return withLock(projectRoot, change, () => {
    // step 1-3: 锁内读 + 重建
    ensureChangeLayout(projectRoot, change);
    const snapshot = rebuildSnapshot(projectRoot, change, changeRoot);
    // HIGH 4 修复：用 snapshotDigest（世界状态）而非 eventsDigest
    const worldDigest = snapshotDigest(snapshot);

    // step 4: 幂等校验（锁内）
    const idemKey = idempotencyKey(name, opts.idempotencyInputs ?? {}, worldDigest);
    const events = readEvents(projectRoot, change);
    const existing = events.find(
      e => e.idempotency_key === idemKey && e.event_type === "transition_commit"
    );
    if (existing) {
      const p = existing.payload as { outcome: string; from_state: State; to_state: State; created_job_ids?: string[] };
      return {
        transition: name,
        outcome: p.outcome as "advanced" | "job_created",
        from_state: p.from_state, to_state: p.to_state,
        created_jobs: p.created_job_ids ?? [],
        message: "幂等返回", events_written: 0,
      };
    }

    // step 4b: 锁内决策（BLOCKER 1 修复：校验在锁内）
    const decision = opts.decide(snapshot);
    if ("skip" in decision) {
      return {
        transition: name, outcome: "advanced",
        from_state: snapshot.state, to_state: snapshot.state,
        created_jobs: [], message: decision.message, events_written: 0,
      };
    }

    const { fromState, toState, outcome, newJobs = [], reason } = decision;

    // 锁内校验 from_state（BLOCKER 1 修复）
    if (fromState !== snapshot.state) {
      return {
        transition: name, outcome: "advanced",
        from_state: snapshot.state, to_state: snapshot.state,
        created_jobs: [], message: `from_state 不匹配：期望 ${fromState}，实际 ${snapshot.state}`,
        events_written: 0,
      };
    }

    const transitionId = newTransitionId();

    // step 5: staging
    mkdirSync(stagingDir(projectRoot, change, transitionId), { recursive: true });
    writeFileSync(
      join(stagingDir(projectRoot, change, transitionId), "intent.json"),
      JSON.stringify({ name, fromState, toState, outcome, reason }, null, 2),
    );

    // step 7: transition_prepare
    appendEvent(projectRoot, change, makeEvent(change, "transition_prepare", {
      transition: name, transition_id: transitionId, from_state: fromState, to_state: toState, reason,
    }, { transitionId, idempotencyKey: idemKey, prevSnapshotDigest: worldDigest }));

    // step 9: transition_commit（HIGH 6 修复：job 数据放 commit payload 内，可 replay）
    const commitPayload = {
      transition: name, from_state: fromState, to_state: toState,
      outcome, created_job_ids: newJobs.map(j => j.job_id), new_jobs: newJobs, reason,
    };
    appendEvent(projectRoot, change, makeEvent(change, "transition_commit", commitPayload, {
      transitionId, idempotencyKey: idemKey, prevSnapshotDigest: worldDigest,
    }));

    // step 10: 重建 snapshot
    writeSnapshot(projectRoot, change, rebuildSnapshot(projectRoot, change, changeRoot));

    return {
      transition: name, outcome, from_state: fromState, to_state: toState,
      created_jobs: newJobs.map(j => j.job_id),
      message: outcome === "advanced"
        ? `状态推进：${fromState} → ${toState}`
        : `状态不变（${fromState}），创建了 ${newJobs.length} 个工作项`,
      events_written: 1,
    };
  });
}

/** propose-ready 处理器——所有逻辑通过 decide 回调在锁内执行 */
export function proposeReady(
  projectRoot: string, change: string, changeRoot: string,
  risk: "minimal" | "normal" | "strict" = "normal",
): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "propose-ready",
    idempotencyInputs: { risk },
    decide: (snapshot) => {
      // 校验 from_state（锁内）
      if (snapshot.state !== "propose") {
        return { skip: true, message: `当前状态 ${snapshot.state}，不能 propose-ready` };
      }

      // D1：tasks.md 存在且可解析
      const tasksPath = join(changeRoot, "tasks.md");
      if (!existsSync(tasksPath)) {
        return { skip: true, message: "tasks.md 不存在" };
      }
      const tasksContent = readFileSync(tasksPath, "utf8");
      if (!tasksContent.includes("# Tasks") && !tasksContent.includes("- [ ]")) {
        return { skip: true, message: "tasks.md 内容不像任务计划文档" };
      }

      // Phase 2：基础职责（normal+ 需要 discovery/bi/test-contract）
      if (risk !== "minimal") {
        const artifactsDir = join(changeRoot, ".superspec", "artifacts");
        for (const doc of ["discovery.md", "business-invariants.md", "test-contract.md"]) {
          if (!existsSync(join(artifactsDir, doc))) {
            return { skip: true, message: `基础职责缺失：${doc} 不存在（risk=${risk} 需要）` };
          }
        }
      }

      // BLOCKER 2 修复：检查 open_jobs（已有 requested 的不重复创建）
      const requiredRoles = TRANSITION_REQUIREMENTS["propose-ready"]?.[risk] ?? [];

      // 先看是否所有需求都有 fresh accepted job
      const staleRoles: { role: JobRole; reason: string }[] = [];
      for (const role of requiredRoles) {
        // BLOCKER 2 修复：如果有 open job（requested），不创建新的——直接 skip
        const openForRole = snapshot.open_jobs.find(j => j.role === role);
        if (openForRole) {
          return { skip: true, message: `工作项 ${role} 已存在（${openForRole.job_id}），请先完成它` };
        }

        const fresh = snapshot.accepted_jobs.find(j => j.role === role);
        if (!fresh) {
          staleRoles.push({ role, reason: `需求 ${role} 无已接受的工作项` });
        } else {
          for (const bf of fresh.boundFiles) {
            const currentSha = sha256File(join(changeRoot, bf.path));
            if (currentSha && currentSha !== bf.sha) {
              staleRoles.push({ role, reason: `${role} 绑定文件 ${bf.path} 已变化` });
              break;
            }
          }
        }
      }

      if (staleRoles.length > 0) {
        const newJobs: Job[] = staleRoles.map(({ role }) => {
          // BLOCKER 修复：所有基础职责文档都进 boundFiles，改任何一个都会让 accepted job 失效
          const docPaths = [
            "proposal.md", "tasks.md", "design.md",
            ".superspec/artifacts/discovery.md",
            ".superspec/artifacts/business-invariants.md",
            ".superspec/artifacts/test-contract.md",
          ];
          const boundFiles: Ref[] = docPaths
            .filter(p => existsSync(join(changeRoot, p)))
            .map(p => ({ path: p, sha: sha256File(join(changeRoot, p)) ?? "sha256:missing" }));
          return {
            job_id: newJobId(change, role), role, state: "requested" as const, boundFiles,
            packet_digest: sha256Text(JSON.stringify({ role, boundFiles })),
            created_from_transition: "propose-ready", created_at: new Date().toISOString(),
          };
        });
        return {
          fromState: "propose", toState: "propose", outcome: "job_created" as const, newJobs,
          reason: staleRoles.map(s => s.reason).join("; "),
        };
      }

      return {
        fromState: "propose", toState: "propose_ready", outcome: "advanced" as const,
        reason: `risk=${risk}，所有需求已满足`,
      };
    },
  });
}

/** init transition——走同一条锁内路径（BLOCKER 1 修复） */
export function transitionInit(projectRoot: string, change: string, changeRoot: string): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "init",
    idempotencyInputs: { phase: "init" },
    decide: (snapshot) => {
      const events = readEvents(projectRoot, change);
      if (events.length > 0) {
        return { skip: true, message: "change 已初始化" };
      }
      return {
        fromState: "init", toState: "init", outcome: "advanced" as const,
        reason: "引擎初始化",
      };
    },
  });
}

/** explore transition——init→explore 或 explore→propose（Phase 2：真实校验） */
export function transitionExplore(
  projectRoot: string, change: string, changeRoot: string,
): TransitionResult {
  return commitTransition(projectRoot, change, changeRoot, {
    name: "explore",
    idempotencyInputs: { phase: "explore" },
    decide: (snapshot) => {
      if (snapshot.state === "init") {
        // init → explore：直接进入
        return { fromState: "init", toState: "explore", outcome: "advanced" as const, reason: "进入探索阶段" };
      }

      if (snapshot.state === "explore") {
        // explore → propose：校验 discovery.md
        const discoveryPath = join(changeRoot, ".superspec", "artifacts", "discovery.md");
        if (!existsSync(discoveryPath)) {
          return { skip: true, message: "discovery.md 不存在，需先完成探索" };
        }
        const content = readFileSync(discoveryPath, "utf8");
        if (!content.trim()) {
          return { skip: true, message: "discovery.md 为空" };
        }
        // 检查待确认问题段（spec B1：有阻塞性歧义但无 ask_user → block）
        const openQuestions = content.match(/- \[ \]/g);
        if (openQuestions && openQuestions.length > 0) {
          return { skip: true, message: `discovery.md 有 ${openQuestions.length} 个未解决的待确认问题` };
        }
        return { fromState: "explore", toState: "propose", outcome: "advanced" as const, reason: "探索完成，进入计划阶段" };
      }

      return { skip: true, message: `当前状态 ${snapshot.state}，explore 不适用` };
    },
  });
}
