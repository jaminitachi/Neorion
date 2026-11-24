# Neorion

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](docs/demo.gif)

Neorion turns a Next.js TypeScript project into a local architecture map. Use the CLI, the Claude Code plugin, or Codex to ask which pages render a component, which layouts wrap a route, or which files call an API. The VS Code extension also provides an interactive graph that opens source files from their nodes.

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

Run the following command from the root of your project, then start a new Codex session there.

```sh
neorion setup codex
```

It does three things.

* It installs the Neorion skill in `~/.agents/skills/neorion`.
* It writes a short hint into `./AGENTS.md` in the current folder. The hint tells Codex to query Neorion first for architecture questions and gives the CLI command as a fallback. Setup creates `AGENTS.md` if needed.
* It registers the Neorion MCP server with Codex, or prints the config if Codex is unavailable on PATH.

The hint sits between `<!-- neorion:start -->` and `<!-- neorion:end -->`. The rest of the file is left as it is. Running the command again replaces that block. It never adds a second copy. Run `neorion setup codex --remove` from the same project to remove its marked block and the skill and MCP entry installed by setup. The VS Code extension’s **Connect AI tools** and **Disconnect AI tools** commands manage the same marked block in `AGENTS.md` and `CLAUDE.md`.

Pass `--no-hint` to skip updating `AGENTS.md`, which setup updates only in folders containing `tsconfig.json` or `package.json`.

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

## VS Code extension

```sh
cd extension
npm ci
npx vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. See the [extension README](extension/README.md) for commands and local tests.
