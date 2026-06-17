# SuperSpec 流程引擎规范（轻量版·实施依据）

## 状态

- 日期：2026-06-17
- **ready_for_implementation**
- 基于原轻量事实同步 plan + 3 句关键补丁（经多轮审查验证为真问题、修法 1-liner）
- 取代所有先前版本（旧 plan + adjudication 归档为审查记录）

---

## 1. 问题

工作流状态没有在引擎内部流动；智能体手工桥接过多协议状态。

目标：**只有引擎能提交工作流状态流转。** 智能体只做：`next` → 执行 → `record` → `next`。

---

## 2. 核心原则

1. **文档=输入，引擎=权威。** 分歧→`ask_user`，不静默阻断。
2. **committed 不可变；失效前向 only，不回滚。**
3. **轻量**：不建数据库式事件溯源；不建字段级影响矩阵。

---

## 3. 状态模型

```
init → explore → propose → propose_ready → apply → apply_done → review → accepted → archive
                                                                                      
任意未归档非终态 → reopen 到合法目标
任意未归档 → abandoned（终态，不可 reopen）
```

---

## 4. 命令

**只读**（不推进状态、不 emit 事件）：
```
superspec status --change X
superspec transition sync --change X        # 重建 snapshot 缓存
superspec transition next --change X         # 返回可执行路径
superspec jobs list --change X
superspec jobs packet --change X --job JOB
```

**写**（唯一推进状态）：
```
superspec transition init          --change X
superspec transition explore       --change X          # init→explore 或 explore→propose
superspec transition propose-ready --change X [--risk minimal|normal|strict]
superspec transition start-apply   --change X
superspec transition task-start    --change X --task TASK
superspec transition task-complete --change X --task TASK --test-run REF
superspec transition review-ready  --change X
superspec transition accept        --change X
superspec transition archive       --change X
superspec transition reopen        --change X --to STATE --reason TEXT
superspec transition abandon       --change X --reason TEXT
```

**登记**（写 evidence/记录，不推进状态）：
```
superspec record user-decision  --change X --input FILE
superspec record job-submit     --change X --job JOB --report FILE
superspec record test-run       --change X --input FILE
superspec record task-activation --change X --task TASK
superspec record artifact       --change X --kind KIND --path FILE
```

record 在锁内 append events.jsonl，可 emit 输入类事件（job_accepted/job_rejected 等），**不推进流程状态**。

---

## 5. 轻量事实同步

1. **当前文档是事实输入**。可解析时引擎承认当前内容。
2. **历史不可被文档删除**。events.jsonl 保存发生过什么。
3. **粗粒度失效**（文件级）：
   - discovery/bi/test-contract/proposal/specs/design 变 → 计划相关确认失效
   - tasks.md 结构变 → 执行尝试、工作项失效
   - tasks.md 仅复选框变 → 算进度，不整体失效
4. **过期结果不放过**：transition 用一个工作项的结果时，**现场检查这个工作项当时绑定的文件有没有被改过**。改过 → 阻断，让 agent 重做。**不能放行**（不能当作没事继续走——否则等于拿过期的审查结果放行）。next 也做同样的检查，发现绑定文件变了就返回"重做该工作项"的命令。

> **补丁 A2**：工作项绑定文件变了 → **阻断**（拦住），**不放行**（不当作没事）。

---

## 6. 事件与缓存

`events.jsonl` = 流程日志（非唯一事实依据）。`snapshot.json` = 状态缓存（删后可由 sync 从文档+日志重建）。

事件基础字段：`event_id, event_type, change_id, transition_id, idempotency_key, created_at, actor, prev_snapshot_digest, input_refs, output_refs, payload, event_digest`。

> **补丁 F3**：`idempotency_key` 从 transition 输入 + **当前世界状态**（`prev_snapshot_digest`）确定性派生。strip `generated_at`/`created_at`/`event_id`。**保留**所有安全前提 digest（task_structure_digest 等）。含世界状态是为了让"job 被 reject 后重试同命令"不被错误去重。

---

## 7. transition 提交协议

```
1. 获取 per-change 锁（PID + staleness 回收）
2. 读 OpenSpec status、文档、events.jsonl、snapshot.json
3. 内存重建 snapshot
4. 校验 from_state、输入 schema、策略、idempotency_key
   → 用工作项结果时现场查绑定文件有没有变（变了 → 状态不推进，创建新 job）
5. 暂存写入 staging/<transition_id>/
6. 对 tasks.md 等修改：生成补丁，应用前重新检查全指纹集
7. 追加 transition_prepare 事件
8. 临时文件+重命名应用
9. 追加 transition_commit 事件
10. 重建写入 snapshot.json
11. 释放锁
```

恢复：有 prepare 无 commit → 不推进；commit 存在但 snapshot 写失败 → 下次 sync 重建；同 idempotency_key → 返回旧结果。

**需求缺失时 transition 的行为**：step 4 发现需求缺 fresh accepted job → **走完 prepare→commit，成功创建 job_requested 事件，生命周期状态保持不变**。这不是"失败"或"阻断"——transition 成功完成了它的职责（创建必需工作项）。snapshot 重建后反映新 job。agent 看到"状态不变但有新 job"→ 跑该 job → 重试 transition → 这次有 fresh job → 推进。

---

## 8. 工作项协议

```
requested → accepted | rejected
```

- `record job-submit` → 引擎检查（工作项存在 + 角色匹配 + 绑定文件仍匹配当前 + 报告格式有效）→ 标记接受或拒绝。
- transition 只用**已接受且绑定文件没变**的工作项结果。
- 工作项做完后文件被改 → transition 用它时现场查到不匹配 → **transition 自己创建一个新 job（commit 内，状态不变但 job 创建成功）**，返回"有新 job 需要做"。旧 job 留在历史里，新 job 是全新 request。不追 replacement。
- **next 不建 job**：发现需求缺 fresh job 时，next 只返回**原 transition 命令**（如 `superspec transition propose-ready --change X`）。由 transition 创建 job。
- **record job-submit 幂等**：同 `(job_id, report_digest)` 重复提交 → 返回旧结果。job 已终态（accepted/rejected）后提交不同 report → 拒绝，要求新 job。

> **补丁 F2-lite（Phase 2）**：next 检测**同一需求**（如 proposal-auditor）跨不同 job_id 被 rejected ≥3 次 → 返回 `ask_user` path。Phase 1 不实现。

工作项类型：`clarification-review` / `proposal-auditor` / `critic-review` / `architect-review` / `test-engineer-review` / `executor` / `test-run` / `final-audit`。

---

## 9. 任务执行

### task_attempt

同一任务同时只有一个 active attempt。reopen → 旧 attempt 转 abandoned。执行工作项必须引用 attempt。

task_attempt 绑定：task_id、task_structure_digest、declared_write_scope、pre_edit_source_fingerprint、pre_edit RED/characterization ref、executor result ref、post-edit GREEN/alt-verification ref。

### RED/GREEN

```
tdd_required=true:  需编辑前 RED + 编辑后 GREEN
tdd_required=false: 需 no_tdd_reason + 替代验证记录
```

### 复选框安全

`task-complete` 是唯一允许更新 tasks.md 复选框的命令。补丁前算结构指纹（复选框归一化）→ 生成精确单复选框补丁 → 重读验证 → 应用 → 验证只有目标变了。

> **补丁 D1**：`propose-ready` 要求"OpenSpec tasks 文档就绪" = **tasks.md 作为计划文档已生成且可解析**，不是复选框全完成。

### 越界写入检测

task-complete 校验：diff 工作区 vs declared_write_scope（移植 dirty_worktree_paths）。越界 → 拒绝。

---

## 10. 归档

```
1. 要求 accepted
2. 建保全包
3. 存到 openspec/changes/<change>/.superspec/superspec-preservation/（committed，不受 .gitignore 影响）
4. 验证保全包
5. openspec validate → openspec archive -y
6. 定位已归档变更 + 验证保全
7. 提交 archived 事件
8. 验证成功后清理 projectRoot/.superspec/changes/<change>/（runtime）
```

幂等可重入。

---

## 11. 文件布局

```
<projectRoot>/.superspec/                    # gitignored
  .gitignore
  changes/<change>/
    events.jsonl
    snapshot.json
    lock
    jobs/
    raw/
    staging/
    archive/

openspec/changes/<change>/                   # committed
  proposal.md / specs/ / design.md / tasks.md
  .superspec/
    config.yaml
    artifacts/
      discovery.md
      business-invariants.md
      test-contract.md
    superspec-preservation/                  # 归档保全包
```

---

## 12. 实施阶段

### Phase 1：控制面

**只实现 4 个状态**：`init → explore → propose → propose_ready`。其余（apply/review/archive/abandoned/reopen）文档化但不编码。

- CLI 骨架 + OpenSpec 探测 + 文件布局
- events/snapshot/lock/idempotency
- sync / status / next
- `propose-ready --risk minimal` 全链路
- 一个工作项流程（请求→packet→submit→accept/reject）
- `record job-submit`
- agent 循环（next→执行→record→next）
- 回放用例：工作说明失效 / 缺少引用 / 报告失效 / 文档中途修改
- **可达性**：用 **fixture seed** 直接把 change 置入 `propose` 状态（OpenSpec 文档已写好），测 propose-ready 全链路。Phase 2 才实现真正的 explore/propose 流程。

退出条件：snapshot 可重建 + 删后 sync 一致 + 文档变化使旧确认失效且 transition 创建新 job + next 返回重做 + 回放无重复阻断。

### Phase 2-4

- Phase 2：explore + propose + 基础职责
- Phase 3：apply + RED/GREEN
- Phase 4：review + archive

### Go/No-Go

Phase1 绿 → Phase2-4。Phase3/4 真实失败（session A/B replay）未消 → 弃 greenfield 回退融合。

---

## 13. 验证

- 单测证安全（代码正确）
- 会话回放证有效（真实失败消除）——fixture 是代表性模型，真实不复发靠 live 观察
- 回放测引擎响应，测不到 agent 决策保真（transition engine 必要非充分）
- 所有"移植"=移植设计+改造（路径根已变），需"移植后等价"测试
- 吞吐：每次 transition 含锁+读+写，多任务 apply 约 15-20 次流转，承认成本
- 版本漂移：OpenSpec 中途变 → 阻塞
- 旧/新共存：per-change 标记 legacy/new，混调阻塞

---

## 三个补丁（已融入正文，此处汇总）

| 补丁 | 位置 | 内容 |
|---|---|---|
| **F3** | §6 | idempotency_key 从输入确定性派生，strip generated_at/created_at，保留安全前提 digest |
| **A2** | §5 | 工作项绑定文件变了 → 阻断（拦住），不放行（不当作没事） |
| **F2-lite** | §8（Phase 2） | next 检测同一需求跨 job_id rejected ≥3 次 → ask_user |
| **D1** | §9 | tasks 文档就绪 = 计划文档已生成可解析，不是复选框全完成 |
| **E1** | §10/§11 | 归档路径统一 |
| **BLOCKER1** | §8 | stale job 重做：transition 发现绑定文件变了 → 创建新 job（状态不变但 job 创建成功），不追 replacement |
| **BLOCKER2** | §6 | 事件基础字段含 idempotency_key |
| **§7 语义** | §7 | 需求缺失时不是"blocked"——是"成功创建 job、状态不变"（正常路径，非失败）|
| **idempotency+世界状态** | §6 | idempotency_key 含 prev_snapshot_digest，防重试被错误去重 |
| **record 幂等** | §8 | record job-submit 按 (job_id, report_digest) 去重 |
| **next 不建 job** | §8 | next 只返原 transition 命令，由 transition 创建 job |
| **Phase1 scope** | §12 | Phase 1 只实现 4 状态（init→explore→propose→propose_ready）+ fixture seed |

---

## 中英对照（spec 大白话 → TS 代码命名）

实施时 TS 代码用英文，命名须**清楚直观**（不用 target_ref / gate / reconcile 这类黑话）：

| spec 大白话 | TS 命名 | 说明 |
|---|---|---|
| 绑定文件 | `boundFiles: { path: string; sha: string }[]` | 工作项当时检查的文件+指纹 |
| 阻断 | `block` / `Blocked` | 拦住不让过 |
| 放行 | `pass` / `Passed` | 当作没事继续走（仅用于纯新鲜度指纹） |
| 工作项 | `Job` | 审查/测试/执行任务 |
| 状态流转 | `Transition` | 推进到下一状态 |
| 登记 | `record()` | 写入证据/记录 |
| 防重复键 | `idempotencyKey` | 同一操作不执行两次 |
| 暂存 | `staging/` | transition 写入前的临时区 |
| 状态缓存 | `Snapshot` | 可删可重建的派生状态 |
| 流程日志 | `events.jsonl` | 发生过什么的追加日志 |
| 文件变了 | `fileChanged` / `stale` | 绑定文件的当前指纹 ≠ 记录时的指纹 |
| 重做 | `redo` | 重新执行一个绑定文件已变的工作项 |
