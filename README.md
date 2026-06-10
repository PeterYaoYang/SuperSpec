# SuperSpec

SuperSpec is a workflow overlay for OpenSpec-driven delivery. This repository is
the standalone SuperSpec project: the package root, workflow templates, Codex
adapter payload, design docs, and CI live at the repository root.

The package follows the same runtime shape as OpenSpec: TypeScript is used for
development, `npm run build` emits `dist/*.js`, and the published npm bin
launchers execute the compiled JavaScript.

Runtime users need Node.js 20.19.0 or newer. Repository development currently
uses Node.js 24 because the test suite executes TypeScript files directly.

## Install

Install the CLI globally from the GitHub Release tarball:

```text
npm install -g https://github.com/PeterYaoYang/SuperSpec/releases/download/v0.1.0/superspec-0.1.0.tgz
```

The release tarball is produced by `npm pack`, so it contains the compiled
`dist/*.js` runtime. The Git repository itself does not need to commit `dist/`.

Then initialize SuperSpec surfaces:

```text
superspec init
```

The init command asks whether to install into the current project (`project`) or
the Codex user home (`user`). Pressing Enter selects `project`; non-interactive
runs also default to `project`. For scripts, pass the scope explicitly:

```text
superspec init --scope project
superspec init --scope user
```

When the package is published to npm later, the install command becomes:

```text
npm install -g superspec
```

Direct source installs such as `npm install -g github:PeterYaoYang/SuperSpec#main`
are not the recommended user path unless `dist/` is committed or the installer
build environment is controlled. Use the release tarball for normal users.
