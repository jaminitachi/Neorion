# Neorion

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](docs/demo.gif)

Neorion turns a Next.js TypeScript project into a local architecture map. Use the CLI, the Claude Code plugin, or Codex to ask which pages render a component, which layouts wrap a route, or which files call an API. The VS Code extension also provides an interactive graph that opens source files from their nodes.

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

Run the following command from the root of your project, then start a new Codex session there.

```sh
neorion setup codex
```

It does three things.

* It installs the Neorion skill in `~/.agents/skills/neorion`.
* It writes a short hint into `./AGENTS.md` in the current folder. The hint tells Codex to run `neorion query <kind> <target>` in the shell for architecture questions, using the `node` or `npx` form when needed. If `AGENTS.md` does not exist, it is created.
* It registers the Neorion MCP server with Codex, or prints the config if Codex is unavailable on PATH.

The hint sits between `<!-- neorion:start -->` and `<!-- neorion:end -->`. The rest of the file is left as it is. Running the command again replaces that block. It never adds a second copy. To remove the hint, delete the block. The VS Code extension’s **Connect AI tools** and **Disconnect AI tools** commands manage the same marked block in `AGENTS.md` and `CLAUDE.md`.

Pass `--no-hint` to skip updating `AGENTS.md`, which setup updates only in folders containing `tsconfig.json` or `package.json`.

## Claude Code

The marketplace install (`/plugin marketplace add jaminitachi/Neorion`, then `/plugin install neorion@neorion`) is not available yet. `/plugin install` fails because the marketplace entry points at `neorion@0.5.1` on npm, which is not published.

The installed package contains the plugin. The installed plugin passes `claude plugin validate`. From the root of your project, run:

```sh
neorion setup claude
```

It writes a short hint into `./CLAUDE.md` in the current folder. The hint tells Claude Code to use the Neorion tool first for architecture questions. If `CLAUDE.md` does not exist, it is created. The hint sits between `<!-- neorion:start -->` and `<!-- neorion:end -->`, and the rest of the file is left as it is. Running the command again replaces that block. It never adds a second copy.

The command then prints the launch command. Start Claude Code with the plugin from your project:

```sh
claude --plugin-dir "$(npm root -g)/neorion"
```

Ask a normal architecture question such as “Which layouts or providers wrap the / route?” Approve the Neorion MCP call if prompted. For headless use, allow the MCP tool explicitly. The prompt comes before `--allowedTools`.

```sh
claude -p --model haiku --plugin-dir "$(npm root -g)/neorion" "Which layouts or providers wrap the / route?" --allowedTools mcp__plugin_neorion_neorion__neorion_query
```

Pass `--no-hint` to skip updating `CLAUDE.md`, which setup updates only in folders containing `tsconfig.json` or `package.json`.

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
claude --plugin-dir "$NEORION_DIR/neorion"
```

## VS Code extension

```sh
cd extension
npm ci
npx vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. See the [extension README](extension/README.md) for commands and local tests.
