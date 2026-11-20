---
name: neorion
description: Next.js/React TypeScript architecture lookups. Use for which pages render a component, which layouts/providers wrap a route, what breaks if a symbol is renamed, which files call an API route, or finding a component/hook/route by name. Prefer this over grep for those questions.
allowed-tools: mcp__plugin_neorion_neorion__neorion_query
---
Call `neorion_query` with `kind` and `target`:
- `who_renders` component → page routes that can render it (via layouts too)
- `wrappers` route URL or file → layouts/providers, outermost first
- `rename_impact` symbol or `path#Name` → files with checker-resolved references
- `api_consumers` route like `/api/users` → files that call it
- `search` text → matching declarations and routes

Results are `path:line`. Open those lines before editing. `partial` names what the static index cannot see (dynamic imports, computed URLs). Check those spots by hand.
The graph builds and refreshes itself. If the tool says it is building, ask again shortly.
Without MCP, run `npx neorion query <kind> <target>`. For the whole-project overview, run `npx neorion graph` and read the printed file.
