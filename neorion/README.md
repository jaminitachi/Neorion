# Neorion

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](https://raw.githubusercontent.com/jaminitachi/Neorion/master/docs/demo.gif)

Neorion maps Next.js projects written in TypeScript or JavaScript and answers architecture questions through a CLI or the `neorion_query` MCP tool. The CLI and MCP server store the graph in the local workspace cache. A query builds or refreshes the graph when needed.

## Install

Neorion 0.6.0 is not on npm. Install it from the GitHub Release. This installs the `neorion` command, which runs on Node.js 18 or later.

```sh
npm install -g https://github.com/jaminitachi/Neorion/releases/download/v0.6.0/neorion-0.6.0.tgz
```

From your project root, build the graph and ask a question.

```sh
neorion graph
neorion query wrappers /
```

`wrappers` includes third-party components on the page’s wrapper chain and labels
them with their package. Pass `--no-external` in the CLI or set `includeExternal: false`
in MCP to hide third-party non-provider wrappers. Providers stay visible.

Use `neorion query api_consumers signOut` to find a server action’s caller files
and lines. Use `path#Name` to qualify an action name shared by multiple files.

## Codex

To register the MCP server and install the skill for Codex, run the following command, then start a new Codex session in your project.

```sh
neorion setup codex
```

The Codex and Claude Code hints and skills cover `impact` for upstream callers and affected routes, `callees` for downstream dependencies, `path` for the shortest directed dependency chain, and `changes` for routes and wrappers affected by a Git diff.

Run `neorion setup codex --remove` from the project to clear its marked block and remove the user-wide skill and MCP registration that setup still owns. Setup recognizes older installations by their released skill and default MCP command. Rerun `--remove` in other projects to clear their blocks, or use `--remove --no-hint` to keep the current project's block.

## Claude Code

From your project root, run setup once and then start Claude Code as usual.

```sh
neorion setup claude
claude
```

Setup registers the Neorion MCP server at user scope, installs the skill in `~/.claude/skills/neorion/SKILL.md`, and updates the marked block in `CLAUDE.md`. If `CLAUDE_CONFIG_DIR` is set, the skill goes under `$CLAUDE_CONFIG_DIR/skills/neorion/`. If registration fails, setup prints a manual command for your shell (PowerShell on Windows).

Pass `--no-hint` to skip updating `CLAUDE.md`, which setup updates only in folders containing `tsconfig.json`, `jsconfig.json`, or `package.json`.

Ask “Which layouts or providers wrap the / route?” For headless use, allow the registered tool explicitly.

```sh
claude -p "Which layouts or providers wrap the / route?" --allowedTools mcp__neorion__neorion_query
```

Run `neorion setup claude --remove` from the project to clear its marked block. It also removes the skill and MCP registration that setup still owns, which unregisters those tools for every project. Blocks in other projects stay until you run `--remove` there. Pass `--remove --no-hint` to leave the current project's block in place.

For a plugin-only session, launch `claude --plugin-dir "$(npm root -g)/neorion"`. Combining plugin mode with persistent setup makes Claude load two copies of the tool and skill.

## Build from source

Build with Node.js 22 or later.

```sh
git clone https://github.com/jaminitachi/Neorion.git
cd Neorion
NEORION_DIR="$PWD"
npm --prefix extension ci
npm --prefix extension run build:cli
```

From your project root, run the CLI directly from the clone. Neorion looks for a `tsconfig.json` or
`jsconfig.json` first, then falls back to a `package.json` with `next` in `dependencies` or
`devDependencies`. When indexing JavaScript through `jsconfig.json` or a configless Next.js package,
Neorion uses `allowJs: true` and `checkJs: false`. With default file selection, it skips `node_modules`,
`vendor`, `dist`, `build`, `out`, `coverage`, and `public` at the project root.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" graph
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup codex --local
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup claude
claude
```

Direct setup from a clone records the clone's path when `neorion` is unavailable on `PATH`. Rerun setup from the new location after moving the clone.
