# Neorion

Neorion maps Next.js projects written in TypeScript or JavaScript and answers App Router questions deterministically and offline. It shows which layouts and providers wrap a route, which pages render a component, and who calls a server action.

![Neorion demo: install, graph and query on shadcn-ui/taxonomy](docs/demo.gif)

## Real output

Neorion 0.5.2 on [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy), copied from the terminal:

```text
$ neorion query wrappers /dashboard
Project: taxonomy
# wrappers /dashboard : 3 files, 1 page (index 2026-11-24T13:42Z, fresh)
# not wrappers: rendered inside the page
# providers (outermost first): ThemeProvider, NextThemesProvider (external: next-themes)
1 app/layout.tsx:74 RootLayout
2 components/theme-provider.tsx:7 ThemeProvider providers: NextThemesProvider (external: next-themes)
3 app/(dashboard)/dashboard/layout.tsx:14 DashboardLayout
page app/(dashboard)/dashboard/page.tsx:16
# complete: indexed wrapper chains

$ neorion query who_renders UserAvatar
Project: taxonomy
# who_renders components/user-avatar.tsx#UserAvatar : 3 routes (index 2026-11-24T13:42Z, fresh)
/dashboard  app/(dashboard)/dashboard/page.tsx:16  depth 2 via UserAccountNav [via layout] [cond]
/dashboard/billing  app/(dashboard)/dashboard/billing/page.tsx:25  depth 2 via UserAccountNav [via layout] [cond]
/dashboard/settings  app/(dashboard)/dashboard/settings/page.tsx:14  depth 2 via UserAccountNav [via layout] [cond]
# complete: indexed JSX paths
```

The last line says whether the answer is complete. When it is not, it reads `# partial: <reason>`.

## What you can ask

| Kind | Question |
| --- | --- |
| `wrappers` | Which layouts and providers wrap `/dashboard`, outermost first? |
| `who_renders` | Which pages render `UserAvatar`, including through a layout? |
| `api_consumers` | Which files call the `/api/posts` route, or a server action? |
| `rename_impact` | Which files reference `buttonVariants`? |
| `search` | Which components, routes or declarations match `billing`? |
| `impact` | Which routes, server actions, and upstream symbols depend on a symbol or file? |
| `callees` | What does a symbol call, render, or fetch? |
| `path` | What is the shortest directed dependency chain from a page or symbol to a symbol or API route? |
| `changes` | Which symbols, routes, and wrappers are affected by a Git diff? |

Use `--depth <n>` to set the traversal depth for `impact` or `callees`. Use `--include-tests` with `impact` to include test files and `--uses` with `callees` to include symbols used as values. Give `path` a source and a destination. For `changes`, use `--staged` or `--unstaged` to narrow the diff, or `--base <ref>` to compare against the merge base of `HEAD` and that ref.

The CLI runs on Node.js 18 or later without native modules or Python. CLI queries refresh the graph when needed.

Use it from the CLI, Claude Code, Codex, or the VS Code extension, which also draws an interactive graph that opens source files from their nodes.

## How it compares

We asked 30 questions about 3 lesser-known Next.js App Router apps, using only each tool's built-in commands with no LLM.

| | Neorion | Graphify 0.9.115 | GitNexus 1.6.12 |
| --- | ---: | ---: | ---: |
| Total | 25/30 | 17.5/30 | 14/30 |
| Held-out apps only (rep-deck, sharetab) | 16/20 | 11/20 | 8.5/20 |
| Wrappers (layouts and providers of a route) | 6/6 | 0/6 | 0/6 |
| Transitive impact | 5/6 | 5/6 | 4/6 |
| Call paths and callees | 4/6 | 3.5/6 | 3/6 |
| Index build, sum of 3 apps | 26.164 s (0.5.2) | 15.919 s | 56.632 s |

The impact and call path rows were rerun after adding the `impact`, `callees` and `path` queries (commit `a70c2a6`). The total and held-out rows combine those rerun scores with the 0.5.2 wrapper, renderer and caller scores. The wrappers and index build rows come from 0.5.2. slugy was used while building those queries, so the held-out row leaves it out. Neorion ties Graphify on impact questions, still misses tRPC procedure questions in sharetab, and Graphify builds its index faster. Each cell is one run, and the questions lean toward Next.js features. Method, all categories and caveats: [benchmark/parity](benchmark/parity/README.md).

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

Run the following command from the root of your project, then start a new Codex session there.

```sh
neorion setup codex
```

It does three things.

* It installs the Neorion skill in `~/.agents/skills/neorion`.
* It writes a short hint into `./AGENTS.md` in the current folder. The hint tells Codex to query Neorion first for architecture questions and gives the CLI command as a fallback. Setup creates `AGENTS.md` if needed.
* It registers the Neorion MCP server with Codex, or prints the config if Codex is unavailable on PATH.

The Codex and Claude Code hints and skills cover `impact` for upstream callers and affected routes, `callees` for downstream dependencies, `path` for the shortest directed dependency chain, and `changes` for routes and wrappers affected by a Git diff.

The hint sits between `<!-- neorion:start -->` and `<!-- neorion:end -->`. Running the command again replaces that block. Run `neorion setup codex --remove` from the project to clear its block and remove the user-wide skill and MCP registration that setup still owns. Setup recognizes older installations by their released skill and default MCP command. Rerun `--remove` in other projects to clear their blocks, or use `--remove --no-hint` to keep the current project's block. The VS Code extension’s **Connect AI tools** and **Disconnect AI tools** commands manage the same marked block in `AGENTS.md` and `CLAUDE.md`.

Pass `--no-hint` to skip updating `AGENTS.md`, which setup updates only in folders containing `tsconfig.json`, `jsconfig.json`, or `package.json`.

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

From your project root, run the CLI directly from the clone. A package with `next` in `dependencies`
or `devDependencies` and an `app`, `pages`, `src/app`, or `src/pages` directory takes priority over
standalone configs. When a Next.js app is found, Neorion skips project roots inside `cypress`, `e2e`,
`playwright`, `scripts`, and `tests`. When indexing JavaScript through `jsconfig.json` or a configless Next.js package,
Neorion uses `allowJs: true` and `checkJs: false`. With default file selection, it skips `node_modules`,
`vendor`, `dist`, `build`, `out`, `coverage`, and `public` at the project root.

```sh
node "$NEORION_DIR/neorion/dist/neorion.cjs" graph
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup codex --local
node "$NEORION_DIR/neorion/dist/neorion.cjs" setup claude
claude
```

Direct setup from a clone records the clone's path when `neorion` is unavailable on `PATH`. Rerun setup from the new location after moving the clone.

## VS Code extension

![Taxonomy in Routes view with the layouts that wrap /login highlighted](docs/graph-view/after-taxonomy-routes.png)

```sh
cd extension
npm ci
npx vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. See the [extension README](extension/README.md) for commands and local tests.

## License

[MIT](LICENSE) © 2026 Tachi Lim (jaminitachi)
