# SuperSpec 分发方案（安装 / 升级 / 卸载）

> 状态：设计稿（仅设计，不含实现）。本文件由分发讨论沉淀，guard 运行时与门禁语义以 `SPEC.md` / `superspec_guard.ts` 为准。

## 0. 目标与非目标

**目标**
- 让 SuperSpec 能以 **npm 包** 形态分发给「特定的人 / 团队」，无需发布到公共 registry。
- 提供对称的三命令：`superspec init`（装机）/ `superspec update`（升级）/ `superspec uninstall`（卸载）。
- 卸载/升级 **绝不误删**用户数据与用户自定义文件；payload 与运行时数据都 **没有 git 兜底**，所以必须清单驱动。
- guard 本体保持现状（零运行时依赖、从 `openspec status` 推仓库根），分发层只做「拷贝 + 接线 + 查环境」。

**非目标**
- 不重写 guard 门禁逻辑。
- 不改 OpenSpec 自身；SuperSpec 始终是其 **叠加层（overlay）**。
- 不强制公共 npm 发布（支持但非默认路径）。

## 1. 已验证约束（设计前提，均已实测）

1. **安装 footprint 由 guard 的 `check-init` 强制**（见 `superspec_guard.ts` 的 `REQUIRED_*` 常量），是装机清单的权威来源：
   - 前置：`openspec` CLI 在 PATH，且支持 `instructions/archive/validate/status --help`（`REQUIRED_OPENSPEC_CLI_SURFACES`）。
   - 前置：`.codex/skills/{openspec-explore,openspec-propose,openspec-apply-change,openspec-archive-change}/SKILL.md` 存在且 frontmatter `name` 正确 → 由 `openspec init --tools codex .` 产出。
   - SuperSpec payload：`.codex/agents/{architect,critic,test-engineer,code-reviewer,verifier}.toml`（`name` 必须匹配）+ `.codex/prompts/{同 5 名}.md`（非空）+ 5 个用户可见 skill：`.codex/skills/superspec-{explore,propose,apply,review,archive}/`。`init` 由 npm bin `superspec-init` / future `superspec init` 承担，`verify` 已合并进 `review`。
2. **命令入口约束**：
   - skills 默认调用 `${SUPERSPEC_GUARD:-./node_modules/.bin/superspec-guard}` / `${SUPERSPEC_INIT:-./node_modules/.bin/superspec-init}`；目标仓库以 devDependency 安装后由 npm shim 提供入口。
   - `scripts/superspec_guard` / `scripts/superspec_init` wrapper 仅是 Codex adapter 的 unix 便利壳或过渡入口，不是 workflow skill 的默认路径；避免把仓库相对布局写死进可分发 skill。
   - 环境假设：Node ≥ 24（原生 strip TS）、openspec 必须先 init。
3. **没有 git 安全网**：
   - `.codex/` 被 `.git/info/exclude` 忽略（本仓库实测）→ 安装的 payload 删错了 `git checkout` 救不回。
   - 每个 change 的 `.superspec/` sidecar（证据 / ledger / state / handoffs / reports）是 **untracked 本地数据**，删了即永久丢失。
   - 结论：升级/卸载必须 **manifest 驱动 + 归属判定 + 数据默认保留**。
4. guard 已具备的可移植性：从 `planningHome.root` 推仓库根、零运行时依赖、`SCHEMA_VERSION`/`GUARD_VERSION` 已存在（可供 manifest 与状态迁移引用）。

## 2. 分发形态决策：npm 本地 / 私有包

选 npm（与 OpenSpec 自身一致；guard 零依赖、打包近零成本；自带版本与升级路径）。**不依赖公共 registry** 的落地渠道：

| 渠道 | 命令 | 适用 |
|---|---|---|
| tarball（发文件） | `npm pack` 出 `superspec-x.y.z.tgz` → 对方 `npm i -D ./superspec-x.y.z.tgz` 后 `npx SuperSpec init` | 直接把东西给个人 |
| git 直装 | `npm i -D git+ssh://git@host/org/superspec.git#v1.0.0` | 团队有仓库权限 |
| 私有 registry | GitHub Packages / Verdaccio + `.npmrc` → `npm i -D @org/superspec` | 长期分发 + 自动 `update` |
| 本地路径 / link | `npm i -D /abs/path`；开发期 `npm link` | 本机 / 同机调试 |

**推荐主路径：目标仓库装为 devDependency（而非全局）** —— 版本随仓库锁定（`package-lock.json`）、CI 可复现、wrapper 解析 `node_modules/.bin/superspec-guard` 即可，仓库自包含。全局安装仅作便利项。

## 3. 当前包结构（`@irenshi/superspec`）

```
@irenshi/superspec/
├─ package.json            # bin / files / 仅 devDeps(typescript,@types/node)
├─ superspec_guard.ts      # guard bin（Node >=24 原生 strip TS）
├─ superspec_init.ts       # init/update/uninstall bin（manifest-driven）
├─ src/                    # guard + init + install engine runtime
├─ tests/                  # package / guard / workflow / installer regression tests
├─ templates/              # SuperSpec canonical workflow templates
│  ├─ workflow/
│  │  ├─ skills/superspec-*/SKILL.md     (5: explore/propose/apply/review/archive)
│  │  └─ prompts/*.md                  (5)
│  └─ sidecar/
│     ├─ config.yaml                    # 可选默认配置
│     ├─ discovery.md
│     ├─ business-invariants.md
│     ├─ test-contract.md
│     └─ archive-preservation.json
├─ adapters/
│  └─ codex/
│     ├─ agents/*.toml                 (5)
│     ├─ wrappers/superspec_guard
│     ├─ wrappers/superspec_init
│     └─ install-map.json              # workflow templates -> .codex/... target paths
└─ schemas/
   └─ install-manifest.schema.json
```

- `package.json` 关键字段：
  - `"bin": { "superspec-guard": "./superspec_guard.ts", "superspec-init": "./superspec_init.ts" }`
    - npm 自动生成跨平台 shim（Windows 也有 `.cmd`），**消除 workflow skill 的仓库相对路径耦合**。
  - `"files": ["README.md","superspec_guard.ts","superspec_init.ts","src","templates","adapters","schemas"]`，`"type":"module"`，`"engines": { "node": ">=24" }`。
- 后续可新增聚合 CLI `superspec init/update/uninstall`，但当前已落地入口是 `superspec-init [--update|--uninstall]`。

## 4. wrapper 解耦方案

`superspec init` 生成的 `scripts/superspec_guard` 只作为 unix 便利壳；skills 默认走 npm bin。wrapper 若安装，应解析已安装包的 guard：

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node "$(node -e "process.stdout.write(require.resolve('@org/superspec/runtime/superspec_guard.ts'))")" "$@"
```

skills 的 `$SUPERSPEC_GUARD` 默认指向 npm bin（`./node_modules/.bin/superspec-guard`），repo wrapper 仅作 unix 便利壳。**优先 npm bin**（跨平台、无路径耦合）。

## 5. install manifest（升级/卸载的唯一依据）

位置：`.codex/superspec/install-manifest.json`（与 change 目录下的 `.superspec/` 互不冲突）。

```json
{
  "superspecVersion": "1.0.0",
  "packageSpec": "@org/superspec@1.0.0",
  "installedAt": "2026-06-08T06:00:00Z",
  "guardSchemaVersion": 1,
  "guardWiring": "npm-bin",
  "files": [
    { "path": ".codex/skills/superspec-explore/SKILL.md", "sha256": "…", "managed": true,  "preexisting": false },
    { "path": ".codex/agents/architect.toml",        "sha256": "…", "managed": false, "preexisting": true  }
  ],
  "createdDirs": [".codex/skills/superspec-explore", ".codex/superspec"],
  "dataGlobs": ["**/.superspec"]
}
```

字段语义：
- `managed=true`：SuperSpec 创建、由它负责升级/卸载。
- `preexisting=true`（含 `managed=false`）：装机前已存在的同名文件 → **永不删、永不覆盖**（解决通用角色名碰撞）。
- `sha256`：卸载/升级时比对，**用户改过（不匹配）则跳过 + 警告**。
- `dataGlobs`：运行时数据，**默认绝不删**。

## 6. 命令面

### 6.1 两个互不等价的层级（必须文档化）
| 层级 | 命令 | 作用 |
|---|---|---|
| npm 层 | `npm rm -D @org/superspec`（或 `-g`） | 仅卸 CLI/包本体，**不清理任何项目** |
| 仓库层 | 在项目内 `npx SuperSpec uninstall` | 把脚手架从**这个仓库**移除 |

### 6.2 `superspec init`
1. **Preflight**：Node ≥ 24；`openspec` 在 PATH 且通过 `REQUIRED_OPENSPEC_CLI_SURFACES`；`.codex/skills/openspec-*` 存在（缺 → 提示或代跑 `openspec init --tools codex .`）。
2. **逐文件落地**：目标不存在 → 写入并记 `managed=true`；已存在且内容相同 → 记 `managed=true`；已存在且不同 → 记 `preexisting=true,managed=false` 并跳过（`--force` 才覆盖，且先备份 `*.bak`）。
3. **接线 wrapper**（npm-bin 解析）。
4. **写 manifest** + 打印安装摘要与下一步（建议跑 `superspec-guard check-init --change <c>` 自检）。
5. 幂等：重复 init = 补齐缺失 + 不动已存在。

### 6.3 `superspec update`
1. 读 manifest + Preflight。
2. 按 `sha256` 三态处理 managed 文件：
   - 未改 → 覆盖为新版；
   - 用户改过 → **保留用户版**，新版写到 `*.new` 并警告（dpkg 风格）；
   - 新版新增文件 → 添加；新版删除的旧 managed 文件 → 删除（仅当未被改）。
3. `preexisting` 文件 → 一律不动。
4. **保留全部 `.superspec/` 数据**；若 `guardSchemaVersion` 提升，执行（或提示）`.superspec/state.json` 状态迁移。
5. 重写 manifest。

### 6.4 `superspec uninstall`
1. 读 manifest（缺失则拒绝；`--force` 用内置模板清单尽力而为）。
2. managed 且未改 → 删除；managed 但用户改过 → 跳过 + 警告（`--force` 才删）；`preexisting` → 跳过。
3. 删空目录（仅 `createdDirs` 中、且现已为空者）；共享目录（`.codex/`、`.codex/skills/`）非空则保留。
4. **`openspec-*` 等非我方文件绝不碰。**
5. 数据：
   - 默认（停用）：保留所有 `.superspec/`；
   - `--purge`：先打包（复用 guard 的 archive-preservation bundle 思路）再删，需显式确认。
6. `--dry-run`：仅打印将删清单，不动文件。
7. 因 gitignore 无兜底 → 结束**打印移除审计摘要**。
8. **不**卸 npm 包本体（提示用户另行 `npm rm`）。

> 升级=「按 manifest 移除旧 managed（保数据/保用户改）+ 装新 + 重写 manifest」，与卸载 **共用同一 manifest 引擎**。

## 7. 跨平台
- 依赖 npm `bin`（`superspec` / `superspec-guard`）→ npm 在 Windows 自动生成 `.cmd`/`.ps1` shim，免手写。
- bash wrapper `scripts/superspec_guard` 仅 unix；Windows 走 `$SUPERSPEC_GUARD=node_modules/.bin/superspec-guard`。
- 安装器 `bin/superspec.mjs` 用 Node 内置（`fs`/`path`/`crypto`），不 shell out 拷文件，保证跨平台。

## 8. 边界与风险
1. **通用角色名碰撞**：guard 的 `REQUIRED_SUPERSPEC_AGENT_ROLES` 用裸名（architect/critic/…），与用户既有同名文件可能撞 → 靠 `preexisting` 检测 + checksum 兜住。**后续可考虑**让 guard 支持角色名前缀/配置化（属 guard 改动，Codex 负责，列为 follow-up）。
2. **数据丢失**：`.superspec/` 默认保留、`--purge` 才删且先打包 —— 最高优先级红线。
3. **monorepo / 多 openspec home**：init/uninstall 以「当前仓库根（openspec planningHome）」为作用域；多 home 需分别执行。
4. **CI 可复现**：推荐 devDep + lockfile；`superspec init --check` 可在 CI 校验脚手架完整（等价 `check-init`）。
5. **状态 schema 迁移**：`update` 跨 `SCHEMA_VERSION` 时必须处理 `.superspec/state.json`。

## 9. 与 guard 契约的依赖（single source of truth）
- 装机清单 = guard 的 `REQUIRED_OPENSPEC_CODEX_SKILLS` / `REQUIRED_SUPERSPEC_AGENT_ROLES` / `REQUIRED_SIDECAR_DIRS` / `REQUIRED_OPENSPEC_CLI_SURFACES`。
- **若 guard 改这些常量，templates 与 manifest 引擎需同步**；建议加一条「templates ↔ guard 常量」一致性测试，防漂移。

## 10. 待定决策（需拍板）
1. 包归属：单独 repo 还是本仓库 monorepo 子目录？包 scope 名（`@org/superspec`）？
2. guard 已迁至 standalone package root（`superspec_guard.ts` + `src/`）；是否再拆为 `runtime/` 子目录仅是包内整理问题，非产品化阻塞。
3. wrapper 默认形态：npm-bin shim vs repo bash wrapper（建议前者）。
4. 角色名是否前缀化（需 guard 配合）。

> **已拍板 2026-06-10（审计 H-3/D-2，D1/D3 裁决）**：`.superspec/` 运行时数据是否进使用方仓库的 git **由最终用户选择**，工具不强制。`init` 应提供选择项并按选择生成 .gitignore 片段（推荐预设：ledger + evidence JSON + archive manifest 入库，`reports/`/`raw/`/`handoffs/` ignore + sha 锚定）；风险声明见 SPEC §5.1。

## 11. 分阶段落地
- **P0**：拍板待定项；把 guard 从 proposal 迁到包 `runtime/`（Codex 停稳后）。
- **P1**：建包骨架（`package.json`/`bin`/`templates`/`exports`）+ manifest schema。
- **P2**：实现 `init`（含 preflight、preexisting 检测、wrapper 接线、写 manifest）。
- **P3**：实现 `uninstall`（三档范围、dry-run、审计摘要）+ `update`（共用引擎、状态迁移）。
- **P4**：tarball/git/私有三渠道冒烟 + Windows 冒烟 + 「templates ↔ guard 常量」一致性测试。

> **实施状态 2026-06-10（Phase 5 / D4；standalone 迁移后）**：manifest 引擎已在独立项目根布局落地——`src/install_engine.ts`（install/update/uninstall 共用一套 manifest 引擎，manifest 写 `.codex/superspec/install-manifest.json`），CLI 入口 `superspec-init` / 仓内 `superspec_init.ts [--update|--uninstall] [--dry-run] [--force]`，`project_init` 改为 manifest-driven 安装 SuperSpec 自身 surfaces，`check-init` 纳入 superspec-* skill 健康检查（`superspec_init_missing` / `superspec_skill_invalid`），并带「install-map ↔ guard 常量」一致性测试。未实施部分：聚合 CLI `superspec init/update/uninstall`、`--purge` 打包删除、跨渠道/Windows 冒烟、`guardSchemaVersion` 跨版本状态迁移。

## 12. 验收清单（DoD）
- [ ] `npx SuperSpec init` 后，`superspec-guard check-init --change <c>` 全绿（无 `*_missing`）。
- [ ] `init` 对已存在同名文件不覆盖（除非 `--force`），manifest 正确标 `preexisting`。
- [ ] `uninstall` 默认保留所有 `.superspec/` 数据；`--purge` 先打包后删并需确认；`--dry-run` 不动文件。
- [ ] `uninstall` 跳过用户改过的 managed 文件并警告；不触碰 `openspec-*` 与 `preexisting` 文件。
- [ ] `update` 保留用户改动（写 `*.new`）、迁移状态 schema、重写 manifest。
- [ ] tarball / git / 私有 registry 三渠道均可装；Windows 经 npm bin 可用。
- [ ] 包零运行时依赖；`engines.node>=24`。
