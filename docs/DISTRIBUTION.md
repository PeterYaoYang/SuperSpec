# SuperSpec 分发方案（安装 / 升级 / 卸载）

> 状态：设计稿（仅设计，不含实现）。本文件由分发讨论沉淀，guard 运行时与门禁语义以 `SPEC.md` / `superspec_guard.ts` 为准；npm 发布运行时以编译产物 `dist/*.js` 为准。

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
   - 前置：PATH 上的 `openspec` 必须满足 SuperSpec 对官方 OpenSpec CLI 的兼容要求：版本 `>= 1.4.1`，且支持 `list/instructions/archive/validate/status --help`（`REQUIRED_OPENSPEC_CLI_SURFACES`）。检测到 `openspec-chinese` 标识、低版本或兼容不完整变体时不能满足此前置；`init` 会自动尝试安装 / 升级官方包，遇到全局 bin 冲突会用覆盖模式重试。
   - OpenSpec bridge 不再依赖 `.codex/skills/openspec-*`；project init 只安装/修复 SuperSpec 自身的 workflow skills、prompts 和 agents。
   - SuperSpec payload：5 个用户可见 skill（explore/propose/apply/review/archive）+ 7 个 role agent/prompt（test-runner 负责 apply 测试执行；executor 负责 apply 实现写入；architect/critic/test-engineer/code-reviewer/verifier 负责审查/验证）。project scope 时安装到 `.codex/agents/{architect,critic,executor,test-runner,test-engineer,code-reviewer,verifier}.toml` + `.codex/prompts/{同 7 名}.md` + `.codex/skills/superspec-{explore,propose,apply,review,archive}/`；user scope 时安装到 Codex user home 的 `agents/`、`prompts/` 和 `skills/`。`init` 由全局 npm bin `superspec init` 承担，`verify` 已合并进 `review`。
2. **命令入口约束**：
  - 包本体通过 GitHub Release tarball 或 npm registry 全局安装；当前内测主路径是 `npm install -g https://github.com/PeterYaoYang/SuperSpec/releases/download/v0.1.0/superspec-0.1.0.tgz`，正式 npm 发布后是 `npm install -g @peterxiaoyang/superspec`。workflow skills 直接调用 `superspec check ... --format agent` / `superspec init --scope project --format agent`，不依赖目标仓库的 `node_modules/.bin` 或 POSIX shell 环境变量展开。
   - 不安装 project-local wrapper script；正式入口只依赖 npm 生成的跨平台 bin（Unix shim + Windows `.cmd`/PowerShell shim）。
   - 环境假设：Node ≥ 20.19.0（运行编译后的 ESM JavaScript）、官方 OpenSpec CLI ≥ 1.4.1，openspec 必须先 init。
3. **没有 git 安全网**：
   - `.codex/` 被 `.git/info/exclude` 忽略（本仓库实测）→ 安装的 payload 删错了 `git checkout` 救不回。
   - 每个 change 的 `.superspec/` sidecar（证据 / ledger / state / handoffs / reports）是 **untracked 本地数据**，删了即永久丢失。
   - 结论：升级/卸载必须 **manifest 驱动 + 归属判定 + 数据默认保留**。
4. guard 已具备的可移植性：从 `planningHome.root` 推仓库根、零运行时依赖、`SCHEMA_VERSION`/`GUARD_VERSION` 已存在（可供 manifest 与状态迁移引用）。

## 2. 分发形态决策：npm 本地 / 私有包

选 npm（与 OpenSpec 自身一致；guard 零依赖、打包近零成本；自带版本与升级路径）。**不依赖公共 registry** 的落地渠道：

| 渠道 | 命令 | 适用 |
|---|---|---|
| GitHub Release tarball | `npm i -g https://github.com/PeterYaoYang/SuperSpec/releases/download/v0.1.0/superspec-0.1.0.tgz` 后 `superspec init` | 当前推荐；公开 GitHub，不发 npm registry，安装已构建包 |
| tarball（发文件） | `npm pack` 出 `superspec-x.y.z.tgz` → 对方 `npm i -g ./superspec-x.y.z.tgz` 后 `superspec init` | 直接把东西给个人或上传到 Release |
| git 直装（SSH/私有） | `npm i -g git+ssh://git@host/org/superspec.git#v1.0.0` | 私有仓库或团队内测 |
| npm registry / 私有 registry | GitHub Packages / Verdaccio / npmjs → `npm i -g @peterxiaoyang/superspec` | 长期分发 + 自动 `update` |
| 本地路径 / link | `npm i -g /abs/path`；开发期 `npm link` | 本机 / 同机调试 |

**当前推荐主路径：公开 GitHub + Release tarball，全局安装 CLI，`superspec init` 交互选择 scope** —— 默认 `project`，写入当前项目 `.codex/`，适合随仓库协作；`user` 写入 Codex user home，适合个人默认 workflow。两者都由 manifest 记录归属，支持 update/uninstall。`dist/` 不提交到 git，Release tarball 由维护者运行 `npm pack` 生成并上传。

## 3. 当前包结构（`superspec`）

```
superspec/
├─ package.json            # bin / files / build / 仅 devDeps(typescript,@types/node)
├─ bin/                    # npm bin JS launchers（先校验 Node >=20.19.0，再加载 dist runtime）
├─ dist/                   # npm 发布 runtime：由 TS 编译出的 JS + d.ts
├─ superspec.ts            # 开发源码：聚合 CLI runtime
├─ superspec_guard.ts      # 开发源码：guard runtime
├─ superspec_init.ts       # 开发源码：init/update/uninstall runtime
├─ src/                    # 开发源码：guard + init + install engine runtime
├─ tests/                  # package / guard / workflow / installer regression tests（不进 npm 包）
├─ templates/              # SuperSpec canonical workflow templates
│  ├─ workflow/
│  │  ├─ skills/superspec-*/SKILL.md     (5: explore/propose/apply/review/archive)
│  │  └─ prompts/*.md                    (7)
│  └─ sidecar/
│     ├─ config.yaml                    # 可选默认配置
│     ├─ discovery.md
│     ├─ business-invariants.md
│     ├─ test-contract.md
│     └─ archive-preservation.json
├─ adapters/
│  └─ codex/
│     ├─ agents/*.toml                 (7)
│     └─ install-map.json              # workflow templates -> .codex/... target paths
└─ schemas/
   └─ install-manifest.schema.json
```

- `package.json` 关键字段：
  - `"bin": { "superspec": "./bin/superspec.js", "superspec-check": "./bin/superspec-check.js", "superspec-hook": "./bin/superspec-hook.js", "superspec-init": "./bin/superspec-init.js" }`
    - npm 自动生成跨平台 shim（Windows 也有 `.cmd`/PowerShell shim），**消除 workflow skill 的仓库相对路径耦合**。
    - JS launcher 在加载 `dist/*.js` runtime 前先校验 Node ≥ 20.19.0，避免旧 Node 直接报不可读的 ESM/syntax 错误。
  - `"files": ["README.md","bin","dist","templates","adapters","schemas"]`，`"type":"module"`，`"engines": { "node": ">=20.19.0" }`。
  - workflow skill 的唯一包内来源是 `templates/workflow/skills/`；不维护根目录 `skills/` 副本，也不依赖 `.codex-plugin/plugin.json`；每个 SuperSpec skill 在 frontmatter `metadata.author/source` 中声明短来源 `SuperSpec`。
  - `"build": "node build.js"`，`prepack` / `prepublishOnly` 自动 build；TS 源码和 `tests/` 用于开发/CI，不随 npm 包发布。运行用户需要 Node ≥ 20.19.0；仓库开发/CI 仍使用 Node 24，因为测试直接执行 `.ts` 文件。
- 聚合 CLI：`superspec init/update/uninstall/check/doctor`（`guard` 仍作为 `check` 的兼容命令别名），并支持 `superspec --version` / `superspec -v` / `superspec version`；`superspec-init` 保留为兼容入口，`superspec-guard` 二进制已更名为 `superspec-check`。

## 4. CLI 接线方案

`superspec init --scope project` 不生成 `scripts/superspec_guard` / `scripts/superspec_init`。skills 默认走全局 `superspec`，命令示例保持 shell-neutral：

```text
superspec check check-init --change "<change>" --format agent
superspec init --scope project --format agent
superspec doctor
```

输出格式分三层：默认 `json` 保持完整诊断字段，供自动化和排障使用；普通 workflow skill 必须使用 `--format agent` 读取白名单视图，避免把 reason code、evidence kind、内部字段名或函数形状喂给模型；`--format user` 输出面向人的中文文本。i18n 只负责固定术语和标签，不承担安全过滤职责；需要排查 evidence/schema/guard 内部时才显式使用 `--format json`。

依赖 npm `bin` 生成跨平台入口：Unix 下是 shim，Windows 下是 `.cmd`/PowerShell shim。入口是 JS launcher，先校验 Node 版本，再加载 `dist` 中的编译后 JS runtime。skill 模板不得使用 `${VAR:-default}`、`test -f`、`mkdir`/`mv` 等 shell-specific 片段来调用 SuperSpec 自身。
Windows PowerShell 可能优先解析 npm 生成的 `.ps1` shim 并受执行策略阻断；workflow skill 必须提示 PowerShell 用户显式运行 `superspec.cmd ...` / `openspec.cmd ...`。

## 5. install manifest（升级/卸载的唯一依据）

位置：project scope 写 `.codex/superspec/install-manifest.json`；user scope 写 Codex user home 下的 `superspec/install-manifest.json`。两者都与 change 目录下的 `.superspec/` 互不冲突。

```json
{
  "superspecVersion": "1.0.0",
  "packageSpec": "@peterxiaoyang/superspec@1.0.0",
  "installedAt": "2026-06-08T06:00:00Z",
  "guardSchemaVersion": 1,
  "guardWiring": "global-bin",
  "installScope": "project",
  "files": [
    { "path": ".codex/skills/superspec-explore/SKILL.md", "sha256": "…", "managed": true,  "preexisting": false },
    { "path": ".codex/agents/architect.toml",        "sha256": "…", "managed": false, "preexisting": true  }
  ],
  "createdDirs": [".codex/skills/superspec-explore", ".codex/superspec"],
  "dataGlobs": ["**/.superspec"],
  "configPatch": { "path": ".codex/config.toml", "retainedOnUninstall": true, "managed": false }
}
```

字段语义：
- `managed=true`：SuperSpec 创建、由它负责升级/卸载。
- `preexisting=true`（含 `managed=false`）：装机前已存在的同名文件 → **永不删、永不覆盖**（解决通用角色名碰撞）。
- `sha256`：卸载/升级时比对，**用户改过（不匹配）则跳过 + 警告**。
- `dataGlobs`：运行时数据，**默认绝不删**。
- `configPatch`：记录 SuperSpec 对 Codex config 的 merge patch 位置；它不是 `files[]` 删除授权，`uninstall` 默认保留该 config，避免误删用户配置。

## 6. 命令面

### 6.1 两个互不等价的层级（必须文档化）
| 层级 | 命令 | 作用 |
|---|---|---|
| npm 层 | `npm rm -g @peterxiaoyang/superspec` | 仅卸 CLI/包本体，**不清理任何 project/user Codex surfaces** |
| init scope 层 | `superspec uninstall --scope project` / `superspec uninstall --scope user` | 移除对应 scope 的 manifest-managed surfaces |

### 6.2 `superspec init`
0. 裸 `superspec init` 在 TTY 中先询问 scope：`project`（当前项目 `.codex/`）或 `user`（Codex user home），直接回车默认 `project`。脚本/CI 未传 `--scope` 时也默认 `project`；使用 `--scope project` 或 `--scope user` 可显式跳过交互。
1. **Preflight**：任意 install scope 下都要求 Node ≥ 20.19.0，且 `openspec` 必须满足官方 OpenSpec CLI 兼容要求：版本 ≥ 1.4.1，并通过 `REQUIRED_OPENSPEC_CLI_SURFACES`（`list/instructions/archive/validate/status --help`）；若缺失、低版本、检测到 `openspec-chinese` 标识或不兼容变体，`init` 会自动尝试安装 / 升级官方包，必要时覆盖冲突的全局 bin。project scope 不再回补 `.codex/skills/openspec-*`，只校验 CLI surface 并安装 SuperSpec Codex surfaces。user scope 只安装 SuperSpec Codex surfaces，不要求当前目录是 OpenSpec 项目。
2. **逐文件落地**：目标不存在 → 写入并记 `managed=true`；已存在且内容相同 → 记 `managed=true`；已存在且不同 → 记 `preexisting=true,managed=false` 并跳过（`--force` 才覆盖，且先备份 `*.bak`）。
3. **接线 CLI**：不写 project wrapper；project/user scope 都依赖全局 `superspec` npm bin。
4. **写 manifest** + 打印安装摘要与下一步；manifest 同时记录 `configPatch`，但 config 不进入 `files[]` 删除集合（project scope 的 workflow 自检使用 `superspec check check-init --change <c> --format agent`；诊断脚本可继续用默认 JSON）。
5. 幂等：重复 init = 补齐缺失 + 不动已存在。

### 6.3 `superspec update`
0. 默认先执行 `npm install -g @peterxiaoyang/superspec@latest` 自更新全局 CLI；若 npm 报 `superspec` 全局 bin 冲突，自动用 `--force` 重试一次；安装成功后重新执行新版 `superspec update --skip-self-update ...`。`--local-only` 跳过 npm 自更新，只用当前已安装包更新 manifest-managed surfaces。
1. 读 manifest 并执行 update-scope 自检（manifest/schema/managed surface 计划）；不会重新触发 OpenSpec CLI 自动安装 / 升级 preflight，避免 update/uninstall 意外改动全局 OpenSpec。
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
5. `configPatch.path` 记录的 Codex config 默认保留，不随 manifest-managed surfaces 删除。
5. 数据：
   - 默认（停用）：保留所有 `.superspec/`；
   - `--purge`：先打包（复用 guard 的 archive-preservation bundle 思路）再删，需显式确认。
6. `--dry-run`：仅打印将删清单，不动文件。
7. 因 gitignore 无兜底 → 结束**打印移除审计摘要**。
8. **不**卸 npm 包本体（提示用户另行 `npm rm`）。

> 升级=「按 manifest 移除旧 managed（保数据/保用户改）+ 装新 + 重写 manifest」，与卸载 **共用同一 manifest 引擎**。

## 7. 跨平台
- 依赖 npm `bin`（`superspec` / `superspec-check`）→ npm 在 Windows 自动生成 `.cmd`/`.ps1` shim，免手写。
- 不发布/安装 bash wrapper；Windows、Ubuntu、macOS 都直接走全局 npm bin `superspec`。
- 安装器用 Node 内置（`fs`/`path`/`crypto`），不 shell out 拷文件，保证跨平台。

## 8. 边界与风险
1. **通用角色名碰撞**：guard 的 `REQUIRED_SUPERSPEC_AGENT_ROLES` 用裸名（architect/critic/…），与用户既有同名文件可能撞 → 靠 `preexisting` 检测 + checksum 兜住。**后续可考虑**让 guard 支持角色名前缀/配置化（属 guard 改动，Codex 负责，列为 follow-up）。
2. **数据丢失**：`.superspec/` 默认保留、`--purge` 才删且先打包 —— 最高优先级红线。
3. **monorepo / 多 openspec home**：init/uninstall 以「当前仓库根（openspec planningHome）」为作用域；多 home 需分别执行。
4. **CI 可复现**：CI 可 `npm i -g @peterxiaoyang/superspec` 后执行 `superspec init --scope project` 与 `superspec check check-init` 校验脚手架完整。
5. **状态 schema 迁移**：`update` 跨 `SCHEMA_VERSION` 时必须处理 `.superspec/state.json`。

## 9. 与 guard 契约的依赖（single source of truth）
- 装机清单 = guard 的 `REQUIRED_SUPERSPEC_WORKFLOW_SKILLS` / `REQUIRED_SUPERSPEC_AGENT_ROLES` / `REQUIRED_SIDECAR_DIRS` / `REQUIRED_OPENSPEC_CLI_SURFACES`；`REQUIRED_OPENSPEC_CODEX_SKILLS` 仅保留为空兼容导出，不再是安装或健康面。
- **若 guard 改这些常量，templates 与 manifest 引擎需同步**；建议加一条「templates ↔ guard 常量」一致性测试，防漂移。

## 10. 待定决策（需拍板）
1. 包归属：单独 repo 还是本仓库 monorepo 子目录？包 scope 名（`@org/superspec`）？
2. guard 已迁至 standalone package root（`superspec_guard.ts` + `src/`）；是否再拆为 `runtime/` 子目录仅是包内整理问题，非产品化阻塞。
3. wrapper 默认形态：已取消 project wrapper，统一 npm bin。
4. 角色名是否前缀化（需 guard 配合）。

> **已拍板 2026-06-10（审计 H-3/D-2，D1/D3 决定）**：`.superspec/` 运行时数据是否进使用方仓库的 git **由最终用户选择**，工具不强制。`init` 应提供选择项并按选择生成 .gitignore 片段（推荐预设：ledger + evidence JSON + archive manifest 入库，`reports/`/`raw/`/`handoffs/` ignore + sha 锚定）；风险声明见 SPEC §5.1。

## 11. 分阶段落地
- **P0**：拍板待定项；把 guard 从 proposal 迁到包 `runtime/`（Codex 停稳后）。
- **P1**：建包骨架（`package.json`/`bin`/`templates`/`exports`）+ manifest schema。
- **P2**：实现 `init`（含 preflight、preexisting 检测、wrapper 接线、写 manifest）。
- **P3**：实现 `uninstall`（三档范围、dry-run、审计摘要）+ `update`（共用引擎、状态迁移）。
- **P4**：tarball/git/私有三渠道冒烟 + Windows 冒烟 + 「templates ↔ guard 常量」一致性测试。

> **实施状态 2026-06-10（Phase 5 / D4；standalone 迁移后）**：manifest 引擎已在独立项目根布局落地——`src/install_engine.ts`（install/update/uninstall 共用一套 manifest 引擎，project manifest 写 `.codex/superspec/install-manifest.json`，user manifest 写 Codex home `superspec/install-manifest.json`），CLI 入口 `superspec init/update/uninstall/check`（`guard` 兼容别名）+ 兼容入口 `superspec-init` / `superspec-check`，`superspec init` 在 TTY 中交互选择 project/user scope 且默认 project；分发链路已改为 TS 开发源码经 `tsconfig.build.json` 编译到 `dist/*.js`，GitHub Release tarball 由 `npm pack`/`prepack` build，未来 npm 发布由 `prepublishOnly` build，bin launcher 运行编译后 JS；`project_init` 改为 manifest-driven 安装 SuperSpec 自身 surfaces，`check-init` 纳入 superspec-* skill 健康检查（`superspec_init_missing` / `superspec_skill_invalid`），并带「install-map ↔ guard 常量」一致性测试。未实施部分：`--purge` 打包删除、真实 Windows 冒烟、`guardSchemaVersion` 跨版本状态迁移。

## 12. 验收清单（DoD）
- [ ] `npm i -g https://github.com/PeterYaoYang/SuperSpec/releases/download/v0.1.1/superspec-0.1.1.tgz` 后，`superspec init` 可交互选择 project/user；project scope 下 `superspec check check-init --change <c>` 全绿（无 `*_missing`）。
- [ ] `init` 对已存在同名文件不覆盖（除非 `--force`），manifest 正确标 `preexisting`。
- [ ] `uninstall` 默认保留所有 `.superspec/` 数据；`--purge` 先打包后删并需确认；`--dry-run` 不动文件。
- [ ] `uninstall` 跳过用户改过的 managed 文件并警告；不触碰 `openspec-*` 与 `preexisting` 文件。
- [ ] `update` 保留用户改动（写 `*.new`）、迁移状态 schema、重写 manifest。
- [ ] tarball / git / 私有 registry 三渠道均可装；Windows 经 npm bin 可用。
- [ ] 包零运行时依赖；`engines.node>=20.19.0`。
