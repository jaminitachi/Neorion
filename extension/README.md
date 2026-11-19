# Neorion

Neorion generates a local architecture map for Next.js projects written in TypeScript.

## Use in VS Code

1. Open the project folder containing `tsconfig.json`.
2. Run **Neorion: Generate Architecture Map** from the Command Palette to write `codebase_graph.md` and area details under `neorion/graph/` in the project root, along with `.neorion/index.v1.json`.
3. Run **Neorion: Show Architecture Graph (Beta)** to explore routes, components, and server action callers and open their source files.

After running either Neorion command once in the current editor session, saving a TypeScript file or `package.json` regenerates the map and refreshes the graph if its panel is open. You can share the generated Markdown with your coding assistant as a starting point for navigating the source.

After the first map is generated, choose **Yes** to connect AI tools, then select
the instruction files to update. Existing `AGENTS.md`, `CLAUDE.md`, and
`.cursor/rules/neorion.mdc` files are preselected. **Neorion: Connect AI tools**
opens the same picker. **Neorion: Disconnect AI tools** removes the managed
blocks, restores any Cursor setting changed by Neorion, and removes MCP entries it added.

### Query tools (MCP)

In **Connect AI tools**, select **Register Neorion query tools (MCP)** to opt in.
Choose Claude Code, Cursor, or VS Code (Copilot agent), then choose the pinned
`neorion-mcp@0.4.0` npm package or **Use bundled server**. The bundled option
copies the server into `.neorion/mcp/server.cjs` and works offline with Node.js
18 or later. Claude Code asks for approval before first using a project MCP
server. **Other tools: copy configuration snippet** supports Codex CLI,
Windsurf, and Gemini CLI. Paste the snippet into your client’s global config.

| Tool | Answers |
| --- | --- |
| `neorion_who_renders` | Which page routes can render a component, including via a layout? |
| `neorion_wrappers` | Which layouts and providers wrap a page, in outermost-first order? |
| `neorion_rename_impact` | Which files contain checker-resolved references to a declaration? |
| `neorion_api_consumers` | Which files send requests to an API route or call its sending function? |
| `neorion_search` | Which declarations or routes match a name or path fragment? |

The server reads the local, unbudgeted index and returns app-relative
`path:line` locations. Results have a 6,000-byte cap and default to 40 rows
(20 for search). When a result is marked stale, regenerate the architecture map.
Keep `.neorion/` local if you do not want to commit the index, bundled server,
or connection state.

### Markdown architecture map

For tools without MCP registration, give your coding assistant `codebase_graph.md` first. It contains the route tree,
server actions, and links to each area's first part. If the links outgrow the
overview, follow its Area index link. Numbered parts in `neorion/graph/`
continue the same area. Regeneration moves generated details out of the legacy
hidden directory and preserves handwritten files there.

Commit `neorion/graph/` to share the generated details, or add it to `.gitignore`
to keep them local. Ripgrep skips ignored details by default. To keep the map
searchable while filtering it out of a source-only query, use
`rg --glob '!neorion/graph/**' --glob '!codebase_graph.md' PATTERN` from the
project root.

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
