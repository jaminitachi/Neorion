---
name: neorion
description: Answers architecture questions in Next.js projects written in TypeScript or JavaScript from an index. Use it before renaming or moving a component, editing a layout or provider, or changing an API route, server action, or tRPC procedure. Ask it to find renderers, wrappers, callers, and symbol references, or for questions such as "what does X call?", "what's the path from /a to X?", and "what does my diff affect?".
allowed-tools: mcp__plugin_neorion_neorion__neorion_query, mcp__neorion__neorion_query, Bash(neorion query:*)
---
Call `neorion_query` with `kind` and the arguments for that query.
- `who_renders` with a component name: which pages and routes render it.
- `wrappers` with a route such as `/settings` lists layouts and providers on the page’s wrapper chain, including third-party wrappers by default. Use `includeExternal: false` in MCP or `--no-external` in the CLI to hide third-party non-provider wrappers.
- `api_consumers` lists caller files and lines for an API route, server action, or tRPC procedure. Pass a route URL, an action name like `signOut`, or a dotted procedure path like `post.create`. Use `path#Name` to disambiguate.
- `rename_impact` with a symbol: which files must change if it is renamed.
- `search` with a name or path: where it is defined or used.
- `impact` with a symbol or file identifies upstream callers and affected routes. Set `depth` or `--depth` to extend the trace, and `includeTests` or `--include-tests` to include test callers.
- `callees` with a symbol lists its calls, renders, fetches, and package calls. Set `depth` or `--depth` to follow up to three hops, and `uses` or `--uses` to include symbols used as values.
- `path` traces the shortest directed chain from a page URL/file or symbol to a symbol or API URL. Pass `target` and `to` in MCP or run `neorion query path <from> <to>`.
- `changes` maps the Git diff to changed symbols and affected routes and wrappers. Omit the target. Use MCP `scope` (`staged` or `unstaged`) or CLI `--staged` or `--unstaged` to narrow the diff. MCP `base` or CLI `--base <ref>` compares the worktree to the merge base of `HEAD` and that ref, including uncommitted edits to tracked files and excluding untracked files. Set `depth` or `--depth <n>` as with `impact` (default 3, maximum 6). Check the importer rows for uses of deleted files and removed exports.
- In a monorepo, select an app with the MCP `app` argument or CLI `--app <name>`. Combined answers use `App:` sections and `[app]` row prefixes. If Neorion only lists apps, rerun the query with a listed app name.

The last line describes the scope of the result.
- `# complete`: the result covers the indexed static matches in the stated scope.
- `# partial: <reason>`: the result may miss items. Fix the reason if you can (qualify an ambiguous target, raise `--limit`), then check the source for what the index cannot see, such as dynamic imports or computed URLs.

Without the MCP tool, run the matching CLI query in the shell. Use `neorion query <kind> <target>` for single-target queries, `neorion query path <from> <to>` to trace a path, or `neorion query changes` to inspect the Git diff.

With Claude Code 2.1.295 or later, `neorion setup claude` adds a project Grep and Glob hook that suggests the `neorion_query` MCP tool for likely component, route, or symbol names in indexed Next.js projects. Use `--no-hook` with older versions or to disable the advisory. In Cursor, `neorion setup cursor` adds the project MCP server and installs a project rule if the VS Code extension has not already installed an active Neorion rule. Run the corresponding setup command with `--remove` to undo its changes.
