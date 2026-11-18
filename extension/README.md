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
server actions, and an area index. Numbered parts in `neorion/graph/` continue the
same area. The directory is visible to ordinary search tools. Regeneration moves
generated details out of the legacy hidden directory and preserves handwritten
files there.

Search the area details for full-path `rendered`, `wrap`, `rename`, and `fetch`
lines. Render reachability follows static JSX and known layouts. A component
reached by more than eight pages lists the count. Wrapper chains run from
outermost to innermost and can list several possible branches. Rename impact
follows TypeScript-resolved imports and barrel re-exports. API links resolve
local literal and template `fetch` paths, including calls through statically
resolved server-action helpers. Use source search to validate dynamic patterns
and any lists the overview marks as abbreviated.

The overview is capped at 25% of the tracked file-list token count, with a
1,500-token floor and a 6,000-token ceiling. Without Git, Neorion builds the
list from local files, skipping common generated directories. Individual
detail parts are capped at 3,000 tokens. For projects with at most 128 analyzed
files, new facts use available space within 4,500 area-detail tokens and 5,000
total detail tokens. All limits use `o200k_base`.

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
