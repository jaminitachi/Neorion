# Neorion

Neorion maps Next.js and React TypeScript projects and answers architecture questions through a CLI or the `neorion_query` MCP tool. The CLI and MCP server store the graph in the local workspace cache. A query builds or refreshes the graph when needed.

## Install before release

Build the PR branch with Node.js 22 or later. The built CLI runs on Node.js 18 or later. Keep the clone at a stable path for Claude Code and Codex.

```sh
git clone --branch feat/cli-and-skill https://github.com/jaminitachi/Neorion.git
cd Neorion
NEORION_DIR="$PWD"
npm --prefix extension ci
npm --prefix extension run build:cli
```

From your TypeScript project, run the CLI directly from the clone.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" graph
node "$NEORION_DIR/neorion/dist/neorion.cjs" query wrappers /
```

To install the CLI from a tarball, run `npm --prefix "$NEORION_DIR/extension" run pack:cli`, then `npm install -g "$NEORION_DIR/extension/neorion-0.5.0.tgz"`. The installed command is `neorion`.

Start Claude Code with the local plugin from your TypeScript project.

```sh
claude --plugin-dir "$NEORION_DIR/neorion"
```

Ask a normal architecture question such as “Which layouts or providers wrap the / route?” Approve the Neorion MCP call if prompted. For headless use, allow the MCP tool explicitly. The prompt comes before `--allowedTools`.

```sh
claude -p --model haiku --plugin-dir "$NEORION_DIR/neorion" "Which layouts or providers wrap the / route?" --allowedTools mcp__plugin_neorion_neorion__neorion_query
```

To register the local MCP server and install the skill for Codex, run the following command, then start a new Codex session in your project.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup codex --local
```

## After release only

These commands depend on the npm release and, for Claude Code, the marketplace manifest on the GitHub default branch.

```sh
npx -y neorion@0.5.0 graph
claude plugin marketplace add jaminitachi/Neorion && claude plugin install neorion@neorion
npx -y neorion@0.5.0 setup codex
```

For headless Claude Code with the installed marketplace plugin, use the same `--allowedTools mcp__plugin_neorion_neorion__neorion_query` flag and omit `--plugin-dir`.
