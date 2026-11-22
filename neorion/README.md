# Neorion

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](https://raw.githubusercontent.com/jaminitachi/Neorion/master/docs/demo.gif)

Neorion maps Next.js and React TypeScript projects and answers architecture questions through a CLI or the `neorion_query` MCP tool. The CLI and MCP server store the graph in the local workspace cache. A query builds or refreshes the graph when needed.

## Install

Neorion 0.5.1 is not on npm. Install it from the GitHub Release. This installs the `neorion` command, which runs on Node.js 18 or later.

```sh
npm install -g https://github.com/jaminitachi/Neorion/releases/download/v0.5.1/neorion-0.5.1.tgz
```

From your TypeScript project, build the graph and ask a question.

```sh
neorion graph
neorion query wrappers /
```

## Codex

To register the MCP server and install the skill for Codex, run the following command, then start a new Codex session in your project.

```sh
neorion setup codex
```

## Claude Code

The marketplace install (`/plugin marketplace add jaminitachi/Neorion`, then `/plugin install neorion@neorion`) is not available yet. `/plugin install` fails because the marketplace entry points at `neorion@0.5.1` on npm, which is not published.

The installed package contains the plugin. After the global install, start Claude Code with it from your project. The installed plugin passes `claude plugin validate`. Launching it and making an MCP query from Claude Code are not tested yet.

```sh
claude --plugin-dir "$(npm root -g)/neorion"
```

Ask a normal architecture question such as “Which layouts or providers wrap the / route?” Approve the Neorion MCP call if prompted. For headless use, allow the MCP tool explicitly. The prompt comes before `--allowedTools`.

```sh
claude -p --model haiku --plugin-dir "$(npm root -g)/neorion" "Which layouts or providers wrap the / route?" --allowedTools mcp__plugin_neorion_neorion__neorion_query
```

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
claude --plugin-dir "$NEORION_DIR/neorion"
```
