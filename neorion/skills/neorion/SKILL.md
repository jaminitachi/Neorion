---
name: neorion
description: Answers architecture questions in Next.js projects written in TypeScript or JavaScript from a prebuilt index. Use it for questions like "which pages render X", "what layouts or providers wrap this route", "who calls this API route or server action", "what breaks if I rename X", or "where is X used", before searching or reading files.
allowed-tools: mcp__plugin_neorion_neorion__neorion_query, mcp__neorion__neorion_query, Bash(neorion query:*)
---
Call `neorion_query` with `kind` and `target`:
- `who_renders` with a component name: which pages and routes render it.
- `wrappers` with a route such as `/settings` lists layouts and providers on the page’s wrapper chain, including third-party wrappers by default. Use `includeExternal: false` in MCP or `--no-external` in the CLI to hide third-party non-provider wrappers.
- `api_consumers` lists caller files and lines for an API route or server action. Pass an action name such as `signOut` or a qualified target such as `app/actions.ts#signOut`.
- `rename_impact` with a symbol: which files must change if it is renamed.
- `search` with a name or path: where it is defined or used.
- `impact` with a symbol or file identifies upstream callers and affected routes. Set `depth` or `--depth` to extend the trace, and `includeTests` or `--include-tests` to include test callers.
- `callees` with a symbol lists its calls, renders, fetches, and package calls. Set `depth` or `--depth` to follow up to three hops, and `uses` or `--uses` to include symbols used as values.
- `path` traces the shortest directed chain from a page URL/file or symbol to a symbol or API URL. Pass `target` and `to` in MCP or run `neorion query path <from> <to>`.

The last line tells you how far to trust the result.
- `# complete`: answer from the result. Open a file only to confirm a specific detail.
- `# partial: <reason>`: the result may miss items. Fix the reason if you can (qualify an ambiguous target, raise `--limit`), then check the source for what the index cannot see, such as dynamic imports or computed URLs.

Without the MCP tool, run `neorion query <kind> <target>` in the shell. It prints the same result.
