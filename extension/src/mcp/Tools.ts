export const kinds = ['who_renders', 'wrappers', 'rename_impact', 'api_consumers', 'search'] as const;
export type QueryKind = typeof kinds[number];
export const queryName = 'neorion_query';

export const tools = [{
  name: queryName,
  description: 'Use this tool first, before searching source files, for Next.js and React TypeScript architecture questions. Use who_renders to find which pages render a component, wrappers to find which layouts or providers wrap a route, rename_impact to find references to a symbol, api_consumers to find callers of an API route, and search to find a component, hook, or route by name. The graph builds and refreshes automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { enum: kinds },
      target: { type: 'string', description: 'Name, path#Name, route URL/file, or search text' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      direct: { type: 'boolean' },
      includeExternal: { type: 'boolean' },
      includeTests: { type: 'boolean' },
      callers: { type: 'integer', minimum: 0, maximum: 2 },
      filter: { enum: ['any', 'component', 'hook', 'function', 'constant', 'route', 'api'] }
    },
    required: ['kind', 'target'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, openWorldHint: false }
}];

export const legacyTargets = {
  who_renders: 'component', wrappers: 'route', rename_impact: 'symbol', api_consumers: 'route', search: 'text'
} as const;

export function legacyKind(name: string): QueryKind | undefined {
  return kinds.find(kind => name === 'neorion_' + kind);
}
