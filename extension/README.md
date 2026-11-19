# Neorion

Neorion generates a local architecture map for Next.js projects written in TypeScript.

## Use in VS Code

1. Open the project folder containing `tsconfig.json`.
2. Run **Neorion: Generate Architecture Map** from the Command Palette to write `codebase_graph.md` and area details under `neorion/graph/` in the project root.
3. Run **Neorion: Show Architecture Graph (Beta)** to explore routes, components, and server action callers and open their source files.

After running either Neorion command once in the current editor session, saving a TypeScript file or `package.json` regenerates the map and refreshes the graph if its panel is open. You can share the generated Markdown with your coding assistant as a starting point for navigating the source.

After the first map is generated, choose **Yes** to connect AI tools, then select
the instruction files to update. Existing `AGENTS.md`, `CLAUDE.md`, and
`.cursor/rules/neorion.mdc` files are preselected. **Neorion: Connect AI tools**
opens the same picker. **Neorion: Disconnect AI tools** removes the managed
blocks and restores any Cursor setting changed by Neorion.

Give your coding assistant `codebase_graph.md` first. It contains the route tree,
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
conditional chains indicate possible branches. Rename impact follows
TypeScript-resolved imports and named re-exports, skips UI and icon primitives,
and shows a count when more than eight files reference a symbol. Fetch lines
link recognized local `fetch` URLs, SWR keys, and axios method URLs to routes
when statically matched. Fetch calls can also be traced through statically
resolved server-action helpers. Check source for dynamic patterns and lists the
overview marks as abbreviated.

The overview is capped at 25% of the tracked file-list token count, with a
1,500-token floor and a 6,000-token ceiling. Without Git, Neorion builds the
list from local files, skipping common generated directories. Individual
detail parts are capped at 3,000 tokens. For projects with at most 128 analyzed
files, new facts use available space within 4,500 area-detail tokens and 5,000
total detail tokens. Larger projects allow up to 5,000 additional tokens for
architecture facts. All limits use `o200k_base`.

## Build and install locally

From this directory, run `npm ci` and `npx vsce package`. In VS Code, use **Extensions: Install from VSIX...** and select the resulting file.

Neorion is MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.txt).

## Test locally

Run `npm run compile` and `npm test` to use the fixtures included in the repository.

For the upstream integration tests, run `node test/fetch-fixtures.cjs` followed by
`NEORION_FIXTURES=test/.fixtures npm test`. The fetch uses pinned upstream revisions
and skips installing the fixture projects' dependencies.

Set `NEORION_BENCH_REPOS` to the directory with the two pinned benchmark
checkouts to include their link, token budget, and Pages API regression tests.
