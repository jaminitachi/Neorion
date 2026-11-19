# Neorion

Neorion is a VS Code extension that turns a Next.js project using the App Router, the Pages Router, or both into a local architecture map. Open the cached overview to browse components, hooks, dependencies, and file relationships. Use the `neorion_query` MCP tool for structural queries. The interactive graph lets you open source files from their nodes.

## Build and install

```bash
cd extension
npm ci
npx vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. See the [extension README](extension/README.md) for commands and local tests.
