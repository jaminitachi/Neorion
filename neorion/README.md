# Neorion

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](https://raw.githubusercontent.com/jaminitachi/Neorion/master/docs/demo.gif)

Neorion maps Next.js projects written in TypeScript or JavaScript and answers architecture questions through a CLI or the `neorion_query` MCP tool. The CLI and MCP server store the graph in the local workspace cache. A query builds or refreshes the graph when needed.

[Measured comparisons](https://github.com/jaminitachi/Neorion#how-it-compares) cover direct CLI queries, agent answers, and index build time and memory. They include source builds made after the release below.

## Install

Neorion 0.6.0 is not on npm. Install it from the GitHub Release. This installs the `neorion` command, which runs on Node.js 18 or later.

```sh
npm install -g https://github.com/jaminitachi/Neorion/releases/download/v0.6.0/neorion-0.6.0.tgz
command -v neorion
```

If the command is missing and you use a custom npm prefix, add its bin directory to your PATH. In a Unix shell, run `export PATH="$(npm prefix -g)/bin:$PATH"`.
When you use the release above, start Claude Code and Codex with `neorion` on PATH.

From your project root, build the graph and ask a question.

```sh
neorion graph
neorion query wrappers /
```

If your app has no `/` route, search for part of a route name with a command such as `neorion query search login`.
In the Pages Router, `wrappers` shows the custom `_app` when present. For dynamic routes, quote
the indexed pattern, such as `'/blog/[slug]'`. Add `--limit <n>` to ask for more rows. Graph rows have a 6,000-byte budget. Query output is capped at 8,000 bytes and can include up to 2,000 bytes of site evidence.

`wrappers` includes third-party components on the page’s wrapper chain and labels
them with their package. Pass `--no-external` in the CLI or set `includeExternal: false`
in MCP to hide third-party non-provider wrappers. Providers stay visible.

`api_consumers --depth <n>` traces up to six caller levels for API routes (default one).
`api_consumers` lists caller files and lines for API routes, server actions, and
tRPC procedures. Pass a route URL, `signOut`, or a dotted procedure path such as
`post.create`. Replace examples such as `signOut` with names from your app.
In source builds, `[mention]` marks a reference such as a route literal and
`[possible URL override]` marks a transport whose request URL may change at runtime.
Use `path#Name` to disambiguate a name. tRPC routers must be in the
indexed project. Routers from other workspace packages may be unresolved.

## Codex

To register the MCP server and install the skill for Codex, run the following command, then start a new Codex session in your project.

```sh
neorion setup codex
```

The Codex and Claude Code hints and skills cover `impact` for upstream callers and affected routes, `callees` for downstream dependencies, `path` for the shortest directed dependency chain, and `changes` for routes and wrappers affected by a Git diff.

`neorion query changes --depth <n>` uses the same depth range as `impact` (default 3, maximum 6). Use `--base <ref>` to compare the worktree to the merge base of `HEAD` and that ref, including uncommitted edits to tracked files and excluding untracked files.

Run `neorion setup codex --remove` from the project to clear its marked block and remove the user-wide skill and MCP registration that setup still owns. Setup recognizes older installations by their released skill and default MCP command. Rerun `--remove` in other projects to clear their blocks, or use `--remove --no-hint` to keep the current project's block.

Codex may leave an empty `config.toml` after removal.

## Claude Code

From your project root, run setup once and then start Claude Code as usual.

```sh
neorion setup claude
claude
```

Setup registers the Neorion MCP server at user scope, installs the skill in `~/.claude/skills/neorion/SKILL.md`, and updates the marked block in `CLAUDE.md`. If `CLAUDE_CONFIG_DIR` is set, the skill goes under `$CLAUDE_CONFIG_DIR/skills/neorion/`. If registration fails, setup prints a manual command for your shell (PowerShell on Windows).

Pass `--no-hint` to skip updating `CLAUDE.md`, which setup updates only in folders containing `tsconfig.json`, `jsconfig.json`, or `package.json`.

With Claude Code 2.1.295 or later, setup can add an advisory `PreToolUse` hook for Grep and Glob in the project's `.claude/settings.json`. The hook uses Claude Code's exec-form command arguments and `onFailure` setting. In an indexed Next.js project, it suggests the `neorion_query` MCP tool for likely component, route, or symbol searches, once per target in each session. The search proceeds through Claude's normal permission flow. Use `--no-hook` with older Claude Code versions or to disable the advisory while keeping the other setup features. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#pretooluse)

Ask “Which layouts or providers wrap the / route?” For headless use, allow the registered tool explicitly.

```sh
claude -p "Which layouts or providers wrap the / route?" --allowedTools mcp__neorion__neorion_query
```

Run `neorion setup claude --remove` from the project to remove the Neorion hook and clear its marked block. It also removes the skill and MCP registration that setup still owns, which unregisters those tools for every project. Run `--remove` in each project to clear its hook and block. Pass `--remove --no-hint` to leave the current project's block in place.

Claude Code may leave its settings file and backups after removal.

For a plugin-only session, launch `claude --plugin-dir "$(npm root -g)/neorion"`. Combining plugin mode with persistent setup makes Claude load two copies of the tool and skill.

## Cursor

From the project root, run `neorion setup cursor`. It configures `.cursor/mcp.json` to launch a pinned Neorion release from GitHub using `npx`, or reuses an existing Neorion MCP entry. If the VS Code extension has already installed an active Neorion rule, Cursor uses that rule. Otherwise, setup writes the same query guidance as the Claude block to `.cursor/rules/neorion-query.mdc`. Cursor applies the rule to every chat in the project. [Cursor MCP configuration](https://cursor.com/docs/mcp#configuration-locations) · [Cursor project rules](https://cursor.com/docs/rules#project-rules)

Run `neorion setup cursor --remove` from the same project to remove the rule block and the MCP entry owned by setup.

## Build from source

Build with Node.js 22 or later.

```sh
git clone https://github.com/jaminitachi/Neorion.git
cd Neorion
NEORION_DIR="$PWD"
npm --prefix extension ci
npm --prefix extension run build:cli
```

From your project root, run the CLI directly from the clone. Neorion uses the requested directory
when it has a Next config or declares Next and has its own routes. Otherwise, it searches for nested
Next apps before falling back to a TypeScript or JavaScript project config. When indexing JavaScript
through `jsconfig.json` or a configless Next.js package,
Neorion uses `allowJs: true` and `checkJs: false`. With default file selection, it skips `node_modules`,
`vendor`, `dist`, `build`, `out`, `coverage`, and `public` at the project root.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" graph
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup codex --local
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup claude
claude
```

These source-build commands list indexed pages, narrow a component search, trace downstream calls and query an indexed route pattern. Replace `ChatShell` and `/blog/[slug]` with a symbol and pattern from your project.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" query search / --kind route
node "$NEORION_DIR/neorion/dist/neorion.cjs" query search chat --kind component --limit 50
node "$NEORION_DIR/neorion/dist/neorion.cjs" query callees ChatShell --depth 2 --limit 84
node "$NEORION_DIR/neorion/dist/neorion.cjs" query wrappers '/blog/[slug]'
```

Run a query from another directory with `--root /path/to/project`. Neorion discovers apps when this
points to a workspace outside the candidate list. To confirm a guessed root from that directory, use
`--root .`. `NEORION_ROOT` follows the same rule. The `Project:` line shows the full path of the
indexed directory. The Claude plugin uses `mcp --workspace <dir>` so guesses remain visible in its
query results. Query suggestions keep the project and CLI invocation. Symbol suggestions show an
accepted `path#Name` target and its declaration line.
Add `--mcp-config` to `graph` to print an MCP launcher snippet.
If setup registered absolute paths to Node.js and the CLI, rerun setup when either path changes. This applies to source and packaged builds that use absolute paths.
