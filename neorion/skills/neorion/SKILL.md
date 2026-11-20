---
name: neorion
description: Query reference for Next.js and React TypeScript projects using Neorion.
disable-model-invocation: true
allowed-tools: mcp__plugin_neorion_neorion__neorion_query
---
Call `neorion_query` directly with `kind` and `target`. Use `who_renders` for a component, `wrappers` for a page route, `rename_impact` for a symbol, `api_consumers` for an API route, and `search` for a name or path.

Open returned `path:line` locations before editing. Check dynamic imports or computed URLs in source when results are partial. If the graph is still building, retry the tool.

Without MCP, use the installed `neorion query <kind> <target>` or `neorion graph` for the overview.
