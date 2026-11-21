# Neorion

Neorion generates a local architecture map for Next.js projects written in TypeScript.

## Use in VS Code

1. Open the project folder containing `tsconfig.json`.
2. Run **Neorion: Generate Architecture Map** from the Command Palette to write `codebase_graph.md` and area details under `neorion/graph/` in the local workspace cache, along with the query index, and open the overview.
3. Run **Neorion: Show Architecture Graph (Beta)** to explore routes, components, and server action callers and open their source files.

After running either Neorion command once in the current editor session, saving a TypeScript file or `package.json` regenerates the map and refreshes the graph if its panel is open. You can share the generated Markdown with your coding assistant as a starting point for navigating the source.

After the first map is generated, choose **Yes** to connect AI tools, then select
the instruction files to update. Existing `AGENTS.md`, `CLAUDE.md`, and
`.cursor/rules/neorion.mdc` files are preselected. **Neorion: Connect AI tools**
opens the same picker. **Neorion: Disconnect AI tools** removes the managed
blocks, restores any Cursor setting changed by Neorion, and removes MCP entries it added.

### Query tools (MCP)

In **Connect AI tools**, select **Register Neorion query tools (MCP)** to opt in.
Choose Claude Code, Cursor, or VS Code (Copilot agent). **Use bundled server**
is the default. It stores the server in the local workspace cache and works
offline with Node.js 18 or later. The project config locates the bundle at
launch using the current workspace and local cache settings. Claude Code uses
the project working directory, and Cursor and VS Code expand
`${workspaceFolder}`. Run **Connect AI tools** to populate the cache for a new
checkout or after moving a project. The optional pinned npm mode requires
`neorion-mcp@0.4.0` to be published before it can run. Claude Code asks for
approval before first using a project MCP server.
**Other tools: copy configuration snippet** uses absolute paths to the
installed bundle and the project. Paste it into the global configuration for
Codex CLI, Windsurf, or Gemini CLI. Copy a fresh snippet if the extension
installation moves.

Call `neorion_query` with `kind` and `target` (a name, `path#Name`, route URL/file, or search text).

| Kind | Answers |
| --- | --- |
| `who_renders` | Which page routes can render a component, including via a layout? |
| `wrappers` | Which layouts and providers wrap a page, in outermost-first order? |
| `rename_impact` | Which files contain checker-resolved references to a declaration? |
| `api_consumers` | Which files contain API route literals or call a function that uses them? |
| `search` | Which declarations or routes match a name or path fragment? |

The server returns project-relative `path:line` locations. Results have a
6,000-byte cap and default to 40 rows (20 for search). `complete` describes the
indexed static matches in the query’s scope. `partial` gives the reason for
uncertainty or missing results. Run **Generate Architecture Map** to refresh
the snapshot after source changes. Reconnect a managed bundled registration to
refresh its launcher and instruction block.

### Markdown architecture map

The overview opens from a per-project directory in the local user cache.
Follow its area links to read the details. Numbered parts in `neorion/graph/`
continue the same area. Regeneration removes recognized legacy generated
files from the project and preserves handwritten files.

Search the area details for lines starting with `rendered`, `wrap`, `rename`,
or `fetch`. Render reachability follows static JSX and marks pages reached only
through their layout or custom App. A component reached by more than eight
pages lists the count. Wrapper chains run from outermost to innermost, and
conditional chains indicate possible branches. When routes share a chain, each
route references the same ID. Search for `wrap @ID` to find its definition.
Rename impact follows
TypeScript-resolved imports and named re-exports, skips UI and icon primitives,
and shows a count when more than eight files reference a symbol. Fetch lines
link recognized local `fetch` URLs, SWR keys, and axios method URLs to routes
when statically matched. Fetch calls can also be traced through statically
resolved server-action helpers. Check source for dynamic patterns and lists the
overview marks as abbreviated.

Neorion estimates Claude tokens as **2 × the `o200k_base` count**. The path-heavy
Formbricks overview measured about 1.85× before the client added line numbers.
The overview is capped at 25% of estimated file-list tokens, with an estimated
3,000-token floor and a 6,000-token ceiling. Without Git, Neorion builds the
list from local files, skipping common generated directories. Individual area
details are capped at 3,000 estimated tokens. The separate reverse-usage
summaries are capped at 6,000 estimated tokens. In projects with at most 128
analyzed files, architecture facts use available space within 9,000 estimated
area tokens and 10,000 estimated detail tokens overall. For larger projects,
the additional architecture-fact budget is `max(24,000, 2 × estimated file-list
tokens)`, including any extra detail headings and shards. Fact kinds take turns. Each queue ranks subjects by chain
depth plus the base-2 logarithm of fan-out (affected pages, importer files, or
endpoints). Page-driven render facts weight depth fourfold and take two
transitive entries per direct entry while both are available. Layout-only
renders take a separate turn. Ties among fetch facts favor page entry points.

## Build and install locally

From this directory, run `npm ci` and `npx vsce package`. Run `npm run pack:mcp` to build the standalone `neorion-mcp` tarball under `out/`. In VS Code, use **Extensions: Install from VSIX...** and select the resulting file.

Neorion is MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.txt).

## Test locally

Run `npm run compile` and `npm test` to use the fixtures included in the repository.

For the upstream integration tests, run `node test/fetch-fixtures.cjs` followed by
`NEORION_FIXTURES=test/.fixtures npm test`. The fetch uses pinned upstream revisions
and skips installing the fixture projects' dependencies.

Set `NEORION_BENCH_REPOS` to the directory containing the ai-chatbot, Papermark,
and Formbricks checkouts to include their integration tests. Set
`NEORION_MCP_SMOKE=1` to print the five Formbricks stdio responses and byte counts.
