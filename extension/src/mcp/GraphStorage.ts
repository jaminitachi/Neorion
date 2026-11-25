import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { IndexedReference, QueryIndex } from './Index';

type PackedFacts = Pick<QueryIndex, 'graphReferences' | 'graphNames' | 'externalCalls' | 'externalModules' | 'fileSymbols' |
  'defaultSymbols' | 'exportSymbols' | 'moduleImports' | 'routeFiles' | 'layoutStyles' | 'unresolvedCalls' |
  'trpcFiles' | 'trpcModuleUses' | 'trpcUses' | 'trpcAliases' | 'trpcUnbound' | 'trpcIssues'> & {
  ends?: [number, number][];
  types?: number[];
  useSites?: [number, number?][];
  callOwners?: [number, number][];
  routeDetails?: [number, Pick<QueryIndex['routes'][number], 'methods' | 'handlers'>][];
};

// Pack graph additions on large projects so existing query kinds can read
// the base index fields without inflating the graph data.
export function packGraph(index: QueryIndex, minimumBytes = 128 * 1024): QueryIndex {
  const { graphReferences, graphNames, externalCalls, externalModules, fileSymbols, defaultSymbols, exportSymbols, moduleImports,
    routeFiles, layoutStyles, unresolvedCalls, trpcFiles, trpcModuleUses, trpcUses, trpcAliases, trpcUnbound, trpcIssues, ...rest } = index;
  if (!graphReferences || !graphNames || !externalCalls || !externalModules) return index;
  const facts: PackedFacts = {
    graphReferences, graphNames, externalCalls, externalModules, fileSymbols, defaultSymbols, exportSymbols, moduleImports,
    routeFiles, layoutStyles, unresolvedCalls, trpcFiles, trpcModuleUses, trpcUses, trpcAliases, trpcUnbound, trpcIssues
  };
  if (JSON.stringify(facts).length < minimumBytes) return index;

  facts.ends = [];
  facts.types = [];
  facts.useSites = [];
  facts.callOwners = [];
  facts.routeDetails = [];
  const symbols = index.symbols.map(({ end, typeOnly, ...symbol }) => {
    if (end !== undefined) facts.ends!.push([symbol.id, end - symbol.line]);
    if (typeOnly) facts.types!.push(symbol.id);
    return symbol;
  });
  const references = index.references.map((reference, offset): IndexedReference => {
    const [target, file, line, kind, detail, owner, graphOwner] = reference;
    if (kind === 'jsx-use') {
      facts.useSites!.push([offset]);
      return [target, file, line, 'use'];
    }
    if (kind === 'use' && owner !== undefined) {
      facts.useSites!.push([offset, owner]);
      return [target, file, line, kind];
    }
    if (graphOwner === undefined) return reference;
    facts.callOwners!.push([offset, graphOwner]);
    return owner === undefined ? [target, file, line, kind] : [target, file, line, kind, detail, owner];
  });
  const routes = index.routes.map(({ methods, handlers, ...route }) => {
    if (methods || handlers) facts.routeDetails!.push([route.id, { methods, handlers }]);
    return route;
  });
  return {
    ...rest, symbols, references, routes,
    packedGraph: deflateRawSync(JSON.stringify(facts), { level: 6 }).toString('base64')
  };
}

export function unpackGraph(index: QueryIndex): QueryIndex {
  if (typeof index.packedGraph !== 'string') return index;
  const bytes = inflateRawSync(Buffer.from(index.packedGraph, 'base64'), { maxOutputLength: 32 * 1024 * 1024 });
  const { ends, types, useSites, callOwners, routeDetails, ...facts } = JSON.parse(bytes.toString('utf8')) as PackedFacts;
  const ranges = new Map(ends);
  const typeIds = new Set(types);
  const symbols = index.symbols.map(symbol => {
    const span = ranges.get(symbol.id);
    const typeOnly = typeIds.has(symbol.id);
    return span !== undefined || typeOnly
      ? { ...symbol, end: span === undefined ? undefined : symbol.line + span, typeOnly: typeOnly || undefined }
      : symbol;
  });
  const references = index.references.slice();
  for (const [offset, owner] of useSites ?? []) {
    const [target, file, line] = references[offset];
    references[offset] = owner === undefined
      ? [target, file, line, 'jsx-use']
      : [target, file, line, 'use', undefined, owner];
  }
  for (const [offset, owner] of callOwners ?? []) {
    const reference = references[offset].slice() as IndexedReference;
    reference[6] = owner;
    references[offset] = reference;
  }
  const details = new Map(routeDetails);
  const routes = index.routes.map(route => ({ ...route, ...details.get(route.id) }));
  return { ...index, ...facts, references, routes, symbols };
}
