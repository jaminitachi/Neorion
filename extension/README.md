# Neorion

Neorion generates a local architecture map for Next.js App Router projects written in TypeScript.

## Use in VS Code

1. Open the project folder containing `tsconfig.json`.
2. Run **Neorion: Generate Architecture Map** from the Command Palette to write `codebase_graph.md` in the project root.
3. Run **Neorion: Show Architecture Graph (Beta)** to explore routes and components and open their source files.

The extension refreshes the map after saving TypeScript files or `package.json`. You can share the generated Markdown with your coding assistant as a starting point for navigating the source.

## Build and install locally

From this directory, run `npm ci` and `npx vsce package`. In VS Code, use **Extensions: Install from VSIX...** and select the resulting file.

Neorion is MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.txt).
