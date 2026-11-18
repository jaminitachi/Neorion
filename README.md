# Neorion

Neorion is a VS Code extension that turns a Next.js App Router project into a local architecture map. The Markdown output covers routes, components, hooks, dependencies, and links between components. The interactive graph lets you open source files from their nodes.

## Build and install

```bash
cd extension
npm ci
npx vsce package
```

In VS Code, run **Extensions: Install from VSIX...** and select the generated `.vsix` file. See the [extension README](extension/README.md) for commands and local tests.
