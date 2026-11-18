# Neorion

Neorion generates a local architecture map for Next.js projects written in TypeScript.

## Use in VS Code

1. Open the project folder containing `tsconfig.json`.
2. Run **Neorion: Generate Architecture Map** from the Command Palette to write `codebase_graph.md` in the project root.
3. Run **Neorion: Show Architecture Graph (Beta)** to explore routes and components and open their source files.

After running either Neorion command once in the current editor session, saving a TypeScript file or `package.json` regenerates the map and refreshes the graph if its panel is open. You can share the generated Markdown with your coding assistant as a starting point for navigating the source.

In the Markdown, UI groups list members as `file.tsx#Name(prop1,prop2)`.
Edges reference a member using the group's `memberPrefix` plus its component
name. If a name is shared within the group, the edge uses the file and name.

## Build and install locally

From this directory, run `npm ci` and `npx vsce package`. In VS Code, use **Extensions: Install from VSIX...** and select the resulting file.

Neorion is MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.txt).

## Test locally

Run `npm run compile` and `npm test` to use the fixtures included in the repository.

For the upstream integration tests, run `node test/fetch-fixtures.cjs` followed by
`NEORION_FIXTURES=test/.fixtures npm test`. The fetch uses pinned upstream revisions
and skips installing the fixture projects' dependencies.
