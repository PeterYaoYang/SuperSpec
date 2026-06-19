---
name: superspec-release
description: "发布 SuperSpec 新版本：升级版本、验证、提交、推送 GitHub、发布 npm、创建 GitHub Release 并上传 tarball。"
triggers:
  - release
  - publish
  - npm
  - github release
argument-hint: "<version>"
metadata:
  author: SuperSpec
  source: SuperSpec
---

# SuperSpec Release

## 语言规则 / Language

- 默认使用简体中文写人类可读内容；命令、路径、tag、版本号、包名保留原文。
- commit message、tag notes、GitHub Release notes 使用中文。
- 不把 npm/GitHub token、OTP、认证 URL 的敏感部分写入最终报告。

## 阶段职责

发布 `@peterxiaoyang/superspec` 的新版本，顺序固定为：

1. 版本升级与本地验证。
2. 提交并推送代码到 GitHub `main`。
3. 发布 npm 包。
4. npm 发布成功后，才创建并推送 git tag。
5. 创建 GitHub Release 并上传同一份 tarball。

不要在 npm 发布失败时创建 tag 或 GitHub Release。

## 发布前检查

先确认当前状态、版本、远端、tag、认证能力：

```text
git status --short
git branch --show-current
git remote -v
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(JSON.stringify({name:p.name,version:p.version,lockVersion:l.version,rootLockVersion:l.packages?.['']?.version},null,2))"
git tag --list 'v*' | sort -V | tail -20
gh auth status
npm whoami
npm view @peterxiaoyang/superspec version
```

如果 `npm whoami` 失败或 npm session 过期，使用 web 登录/认证：

```text
npm login --auth-type=web --registry=https://registry.npmjs.org
```

不要先执行不带 `--auth-type=web` 的 `npm publish` 再等它失败。发布包时默认直接使用 web auth，避免重复认证：

```text
npm publish <tarball> --access public --auth-type=web
```

如果 npm/GitHub CLI 输出浏览器认证 URL，或自动打开浏览器确认页：

- 优先使用 Chrome / Computer Use 插件完成可见的网页确认、Authorize、Approve、Passkey/WebAuthn 点击流程，不把普通点击交还给用户。
- 不在报告中暴露认证 URL 的 token、OTP、passkey challenge 或其它敏感部分。
- 只有需要用户输入密码、OTP、硬件安全钥匙触摸、生物认证，或当前浏览器未登录且无法代操时，才简短说明卡在哪一步并等待用户完成。

## 版本升级

按用户要求选择版本号。未指定时默认 patch bump，例如 `0.1.4 -> 0.1.5`。

同步修改 `package.json`、`package-lock.json` 根对象、`package-lock.json` 的 `packages[""]` 中的 `version`。不要手动改 npm 生成的 tarball 或旧 release 附件。

```text
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(JSON.stringify({version:p.version,lockVersion:l.version,rootLockVersion:l.packages?.['']?.version},null,2))"
```

## 验证

版本升级后必须重新跑：

```text
npm test
npm run typecheck
git diff --check
npm pack --dry-run
```

验收口径：

- `npm test` 必须 0 fail；真实 OpenSpec smoke 如果是 opt-in skip，需要在报告中说明。
- `npm pack --dry-run` 必须显示目标版本，并包含新增 `dist/src/*`、templates、adapters、schemas 等发布文件。
- `git diff --check` 必须通过；提交前再跑一次 `git diff --cached --check`。

本地配置与发布产物边界：

- 不要把本地存在的工作区配置误判为发布产物。`.codex/hooks.json` 可能是 Codex/OMX 本地运行配置；只有当它被 Git 跟踪或出现在 npm packlist 中时，才算发布残留。
- 检查旧 v1 hook / custom schema 时使用 `git ls-files .codex/hooks.json openspec/schemas/superspec` 和 `npm pack --dry-run` 的 packlist。
- 如果 `no v1 hook or custom schema artifacts exist` 失败，先判断失败来源：`git ls-files` 有输出才说明旧产物仍被仓库跟踪；仅文件系统存在但未被跟踪、未进入 packlist 时，不应作为发布阻断。

## 暂存与提交

只暂存本次发布相关文件。明确排除：

- 无关 `openspec/changes/**` 探索目录。
- 旧版本 `.tgz`。
- 本次 tarball，除非用户明确要求把 tarball 提交进仓库。

检查暂存区：

```text
git diff --cached --name-status
git diff --cached --check
git status -sb
```

commit message 必须遵循 Lore 协议，中文 intent line 放第一行：

```text
git commit -m "<为什么发布此变更>" \
  -m "<约束和方案简述>" \
  -m "Constraint: <外部约束>" \
  -m "Rejected: <拒绝方案> | <原因>" \
  -m "Confidence: high" \
  -m "Scope-risk: <narrow|moderate|broad>" \
  -m "Directive: <后续维护提醒>" \
  -m "Tested: npm test; npm run typecheck; npm pack --dry-run; git diff --cached --check" \
  -m "Not-tested: <已知未测项>"
```

## 推送代码

提交后先推送 `main`：

```text
git push origin main
```

确认远端状态：

```text
git status -sb
git log -1 --oneline
```

## npm 发布

生成实际 tarball：

```text
npm pack
```

发布 tarball：

```text
npm publish peterxiaoyang-superspec-<version>.tgz --access public --auth-type=web
```

如果返回 `ENEEDAUTH` 或 session 过期，先登录再用同一条 web auth publish 命令重试：

```text
npm login --auth-type=web --registry=https://registry.npmjs.org
npm publish peterxiaoyang-superspec-<version>.tgz --access public --auth-type=web
```

如果返回 `EOTP` 或浏览器要求 2FA / passkey / WebAuthn，优先使用 Chrome / Computer Use 插件完成确认页，再继续等待原 publish 命令返回；不要改用一次不带 web auth 的 publish：

```text
npm publish peterxiaoyang-superspec-<version>.tgz --access public --auth-type=web
```

发布成功后验证 registry：

```text
npm view @peterxiaoyang/superspec@<version> version dist-tags.latest dist.tarball --json
```

只有确认 npm registry 已显示目标版本后，才进入 tag / GitHub Release。

## Git tag

创建 annotated tag：

```text
git tag -a v<version> -m "v<version>" -m "发布 <中文摘要>。"
git push origin v<version>
```

确认 tag 指向当前提交：

```text
git rev-parse v<version>^{}
git rev-parse HEAD
```

## GitHub Release

创建 release 并上传同一份 tarball。不要传短 SHA 给 `--target`；已有 tag 时可以省略 target。

```text
gh release create v<version> peterxiaoyang-superspec-<version>.tgz \
  --repo PeterYaoYang/SuperSpec \
  --title "v<version>" \
  --notes "<中文 release notes>"
```

发布后验证：

```text
gh release view v<version> --repo PeterYaoYang/SuperSpec --json tagName,url,isDraft,isPrerelease,assets
```

## 最终报告

最终报告必须包含：

- commit SHA。
- npm 包名和版本。
- npm registry 验证结果。
- git tag。
- GitHub Release URL。
- tarball 附件名。
- 验证命令与结果。
- 未纳入发布的无关工作区项，例如 `openspec/`。

如果任一步失败，报告：

- 已完成到哪一步。
- 失败命令与错误类型。
- 是否已创建 npm 包、tag、release。
- 下一步需要用户补充什么权限或认证。
