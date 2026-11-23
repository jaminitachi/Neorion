# review-fixture architecture (mixed router)

Start here, then open relevant area links below or browse [all details](neorion/graph/). Detail headings name source areas. Numbered parts continue the same area.
Fact prefixes: rendered (including layout reachability), wrap (outermost first), rename, fetch (static fetch URLs, SWR keys and axios URLs). Conditional wrap lines show possible branches. Unmarked targets render and import. [render], [import] and [action] mark other relationships. UI/icon targets are counted.
Unmarked files use the server default. (c) marks a client boundary, (L) a layout wrapping pages below it, and [*] unknown Pages API methods.
Reverse usage for selected project symbols: [renders](<neorion/graph/+reverse-renders.md>), [hooks](<neorion/graph/+reverse-hooks.md>), [actions](<neorion/graph/+reverse-actions.md>).
Routes follow the tree. Drop App Router groups and slots, or the Pages filename extension and trailing index. A dot continues the parent route row. Explicit URL overrides follow →.

## Routes

~~~text
src
  app
    (account)  layout.tsx(L)=Layout  page.tsx=AccountPage
    help  page.tsx=HelpPage
  pages/api/auth  [...nextauth].ts[*]
~~~

## Server actions

~~~text
src/app/help/page.tsx > src/app/help/page.tsx#HelpPage.submit
src/app/help/page.tsx#HelpPage.submit
src/app/actions.ts#updateAccount
~~~

## Areas

- [src/app/(account)](<neorion/graph/src~app~(account).md>)
- [src/app](<neorion/graph/src~app.md>)
- [src/app/help](<neorion/graph/src~app~help.md>)
- [src/components](<neorion/graph/src~components.md>)
- [src/components/ui](<neorion/graph/src~components~ui.md>)
- [src/lib](<neorion/graph/src~lib.md>)
- [src/pages/api](<neorion/graph/src~pages~api.md>)
- [Dependencies](<neorion/graph/+dependencies.md>)

## Project hooks

~~~text
src/lib/store.ts: useCartStore
~~~
