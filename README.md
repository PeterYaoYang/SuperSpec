# SuperSpec

SuperSpec 是基于 OpenSpec 的 agent 工作流叠加层。本仓库是独立的
SuperSpec 项目，包根目录、工作流模板、Codex 适配文件、设计文档和
CI 配置都放在仓库根目录。

本包开发时使用 TypeScript；执行 `npm run build` 后生成 `dist/*.js`。
发布包里的命令行入口会运行编译后的 JavaScript。

使用者需要 Node.js 20.19.0 或更高版本。仓库开发和测试当前使用
Node.js 24，因为测试会直接执行 `.ts` 文件。

## 安装

从 GitHub 发布附件全局安装命令行工具：

```text
npm install -g https://github.com/PeterYaoYang/SuperSpec/releases/download/v0.1.0/superspec-0.1.0.tgz
```

这个发布包由 `npm pack` 生成，里面包含已经编译好的 `dist/*.js`。
源码仓库本身不提交 `dist/`。

安装完成后初始化 SuperSpec：

```text
superspec init
```

`init` 会询问安装范围：当前项目（`project`）或 Codex 用户目录
（`user`）。直接回车默认选择 `project`；非交互运行时也默认选择
`project`。脚本里建议显式传入范围：

```text
superspec init --scope project
superspec init --scope user
```

以后发布到 npm 公共仓库后，安装命令会变成：

```text
npm install -g superspec
```

不推荐普通使用者直接通过源码地址安装，例如
`npm install -g github:PeterYaoYang/SuperSpec#main`。除非仓库提交了
`dist/`，或者安装时的构建环境完全可控，否则应使用 GitHub 发布附件。
