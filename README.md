# Neorion

Neorion answers Next.js App Router questions deterministically and offline. It shows which layouts and providers wrap a route, which pages render a component, and who calls a server action.

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

| Kind | Example question |
| --- | --- |
| `wrappers` | Which layouts and providers wrap `/dashboard`, outermost first? |
| `who_renders` | Which pages render `UserAvatar`, including through a layout? |
| `api_consumers` | Which files call the `/api/posts` route, or a server action? |
| `rename_impact` | Which files reference `buttonVariants`? |
| `search` | Which components, routes or declarations match `billing`? |

The CLI runs on Node.js 18 or later without native modules or Python. Queries refresh the graph automatically.

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

The impact and call path rows were rerun after adding the `impact`, `callees` and `path` queries (commit `a70c2a6`). The other Neorion rows come from 0.5.2. slugy was used while building those queries, so the held-out row leaves it out. Neorion ties Graphify on impact questions, still misses tRPC procedure questions in sharetab, and Graphify builds its index faster. Each cell is one run, and the questions lean toward Next.js features. Method, all categories and caveats: [benchmark/parity](benchmark/parity/README.md).

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
* It writes a short hint into `./AGENTS.md` in the current folder. The hint tells Codex to run `neorion query <kind> <target>` in the shell for architecture questions, using the `node` or `npx` form when needed. If `AGENTS.md` does not exist, it is created.
* It registers the Neorion MCP server with Codex, or prints the config if Codex is unavailable on PATH.

The hint sits between `<!-- neorion:start -->` and `<!-- neorion:end -->`. The rest of the file is left as it is. Running the command again replaces that block. It never adds a second copy. To remove the hint, delete the block. The VS Code extension’s **Connect AI tools** and **Disconnect AI tools** commands manage the same marked block in `AGENTS.md` and `CLAUDE.md`.

Pass `--no-hint` to skip updating `AGENTS.md`, which setup updates only in folders containing `tsconfig.json` or `package.json`.

## Claude Code

The marketplace install (`/plugin marketplace add jaminitachi/Neorion`, then `/plugin install neorion@neorion`) is not available yet. `/plugin install` fails because the marketplace entry points at `neorion@0.5.2` on npm, which is not published.

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
