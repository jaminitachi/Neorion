export const kinds = ['who_renders', 'wrappers', 'rename_impact', 'api_consumers', 'search'] as const;
export type QueryKind = typeof kinds[number];
export const queryName = 'neorion_query';

export const tools = [{
  name: queryName,
  description: 'Find rendering pages, route wrappers, rename edits, API consumers, or symbols and routes.',
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
