export const kinds = ['who_renders', 'wrappers', 'rename_impact', 'api_consumers', 'search', 'impact', 'callees'] as const;
export type QueryKind = typeof kinds[number];
export const queryName = 'neorion_query';

export const tools = [{
  name: queryName,
  description: 'Use this tool first, before searching source files, for Next.js architecture questions in TypeScript or JavaScript projects. Use who_renders to find which pages render a component, wrappers to find layouts and providers on a page’s wrapper chain (including external wrappers by default), rename_impact to find references to a symbol, api_consumers to find callers of an API route or a server action (name or path#Name), and search to find a component, hook, or route by name. Use impact to find which routes and upstream code depend on a symbol or file, and callees to find what a symbol calls, renders, and fetches. The graph builds and refreshes automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { enum: kinds },
      target: { type: 'string', description: 'Name, path#Name, route URL/file, or search text' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      direct: { type: 'boolean' },
      includeExternal: { type: 'boolean', default: true, description: 'For wrappers, include third-party components on the page’s wrapper chain. Set false to hide only third-party non-providers.' },
      includeTests: { type: 'boolean' },
      depth: { type: 'integer', minimum: 1, maximum: 6, description: 'Impact depth (default 3) or callees depth (default 1, maximum 3).' },
      uses: { type: 'boolean', description: 'For callees, include symbols used as values.' },
      callers: { type: 'integer', minimum: 0, maximum: 2, description: 'Caller depth for API route targets. Server action targets list direct use sites.' },
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

export function legacyKind(name: string): keyof typeof legacyTargets | undefined {
  return (Object.keys(legacyTargets) as (keyof typeof legacyTargets)[]).find(kind => name === 'neorion_' + kind);
}
