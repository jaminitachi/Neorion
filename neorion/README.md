# Neorion

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](https://raw.githubusercontent.com/jaminitachi/Neorion/master/docs/demo.gif)

Neorion maps Next.js and React TypeScript projects and answers architecture questions through a CLI or the `neorion_query` MCP tool. The CLI and MCP server store the graph in the local workspace cache. A query builds or refreshes the graph when needed.

## Install

Neorion 0.5.2 is not on npm. Install it from the GitHub Release. This installs the `neorion` command, which runs on Node.js 18 or later.

```sh
npm install -g https://github.com/jaminitachi/Neorion/releases/download/v0.5.2/neorion-0.5.2.tgz
```

From your TypeScript project, build the graph and ask a question.

```sh
neorion graph
neorion query wrappers /
```

`wrappers` includes third-party components on the page’s wrapper chain and labels
them with their package. Pass `--no-external` to hide third-party non-provider wrappers, or set
`includeExternal: false` in the MCP tool.

Use `neorion query api_consumers signOut` to find a server action’s caller files
and lines. Use `path#Name` to qualify an action name shared by multiple files.

## Codex

To register the MCP server and install the skill for Codex, run the following command, then start a new Codex session in your project.

```sh
neorion setup codex
```

Run `neorion setup codex --remove` from the same project to remove its marked block and the skill and MCP entry installed by setup.

## Claude Code

From your project root, run setup once and then start Claude Code as usual.

```sh
neorion setup claude
claude
```

Setup registers the Neorion MCP server at user scope, installs the skill in `~/.claude/skills/neorion/SKILL.md`, and updates the marked block in `CLAUDE.md` in folders with `tsconfig.json` or `package.json`. Use `--no-hint` to skip that update. If Claude cannot register the server, setup prints the exact registration command.

Ask “Which layouts or providers wrap the / route?” For headless use, allow the registered tool explicitly.

```sh
claude -p "Which layouts or providers wrap the / route?" --allowedTools mcp__neorion__neorion_query
```

Run `neorion setup claude --remove` from the same project to remove its marked block and the skill and MCP entry installed by setup. As a per-session alternative, launch with `claude --plugin-dir "$(npm root -g)/neorion"`.

## Build from source

Build with Node.js 22 or later.

```sh
git clone https://github.com/jaminitachi/Neorion.git
cd Neorion
NEORION_DIR="$PWD"
npm --prefix extension ci
npm --prefix extension run build:cli
```

From your TypeScript project, run the CLI directly from the clone.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" graph
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup codex --local
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup claude
claude
```
