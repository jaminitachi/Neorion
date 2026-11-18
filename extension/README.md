# Neorion

Neorion generates a local architecture map for Next.js projects written in TypeScript.

## Use in VS Code

1. Open the project folder containing `tsconfig.json`.
2. Run **Neorion: Generate Architecture Map** from the Command Palette to write `codebase_graph.md` and area details under `.neorion/graph/` in the project root.
3. Run **Neorion: Show Architecture Graph (Beta)** to explore routes, components, and server action callers and open their source files.

After running either Neorion command once in the current editor session, saving a TypeScript file or `package.json` regenerates the map and refreshes the graph if its panel is open. You can share the generated Markdown with your coding assistant as a starting point for navigating the source.

Give your coding assistant `codebase_graph.md` first. It contains the route tree,
server actions, and a directory index. Follow a relevant area link for props,
hooks, and file-level adjacency lists. If the overview abbreviates the area
index, browse `.neorion/graph/` for the remaining details. UI primitive and icon
targets are counted in the detail rows. The reverse usage links collect caller
files for the most used project components, hooks, and actions that fit in
each index. Hook definitions are prioritized by the number of caller files
when the overview is abbreviated.

The overview is capped at 25% of the tracked file-list token count, with a
1,500-token floor and a 6,000-token ceiling. Without Git, Neorion builds the
list from local files, skipping common generated directories. Individual
detail parts are capped at 3,000 tokens. Both limits use `o200k_base`.

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
