import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { IndexedReference, QueryIndex } from './Index';

type PackedFacts = Pick<QueryIndex, 'graphReferences' | 'graphNames' | 'externalCalls' | 'externalModules' | 'fileSymbols' |
  'defaultSymbols' | 'exportSymbols' | 'runtimeExports' | 'moduleImports' | 'routeFiles' | 'layoutStyles' | 'unresolvedCalls' |
  'trpcFiles' | 'trpcModuleUses' | 'trpcUses' | 'trpcAliases' | 'trpcUnbound' | 'trpcIssues' |
  'flowCalls' | 'callGates' | 'flowIssues' | 'refEvidence' | 'renderLabels' | 'outgoingRenderIssues'> & {
  ends?: [number, number][];
  types?: number[];
  useSites?: [number, number?][];
  callOwners?: [number, number][];
  renderSites?: [offset: number, site: string][];
  routeDetails?: [number, Pick<QueryIndex['routes'][number], 'methods' | 'handlers'>][];
};

// Pack graph additions on large projects so existing query kinds can read
// the base index fields without inflating the graph data.
export function packGraph(index: QueryIndex, minimumBytes = 128 * 1024): QueryIndex {
  const { graphReferences, graphNames, externalCalls, externalModules, fileSymbols, defaultSymbols, exportSymbols, runtimeExports, moduleImports,
    routeFiles, layoutStyles, unresolvedCalls, trpcFiles, trpcModuleUses, trpcUses, trpcAliases, trpcUnbound, trpcIssues,
    flowCalls, callGates, flowIssues, refEvidence, renderLabels, outgoingRenderIssues, ...rest } = index;
  if (!graphReferences || !graphNames || !externalCalls || !externalModules) return index;
  const facts: PackedFacts = {
    graphReferences, graphNames, externalCalls, externalModules, fileSymbols, defaultSymbols, exportSymbols, runtimeExports, moduleImports,
    routeFiles, layoutStyles, unresolvedCalls, trpcFiles, trpcModuleUses, trpcUses, trpcAliases, trpcUnbound, trpcIssues,
    flowCalls, callGates, flowIssues, refEvidence, renderLabels, outgoingRenderIssues
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
  const fileOffsets = new Map(Object.keys(index.files).map((file, offset) => [file, offset]));
  const references = index.references.map((reference, offset): IndexedReference => {
    const [target, path, line, kind, detail, owner, graphOwner, possible] = reference;
    const file = typeof path === 'string' ? fileOffsets.get(path) ?? path : path;
    if (kind === 'jsx-use') {
      facts.useSites!.push([offset]);
      return [target, file, line, 'use'];
    }
    if (kind === 'use' && owner !== undefined) {
      facts.useSites!.push([offset, owner]);
      return [target, file, line, kind];
    }
    if (graphOwner === undefined || possible) {
      if (file === path) return reference;
      const [, , ...site] = reference;
      return [target, file, ...site];
    }
    facts.callOwners!.push([offset, graphOwner]);
    return owner === undefined ? [target, file, line, kind] : [target, file, line, kind, detail, owner];
  });
  const routes = index.routes.map(({ methods, handlers, ...route }) => {
    // API consumer queries read Pages method evidence without inflating the graph.
    const packedMethods = route.pages ? undefined : methods;
    if (packedMethods || handlers) facts.routeDetails!.push([route.id, { methods: packedMethods, handlers }]);
    return route.pages && methods ? { ...route, methods } : route;
  });
  facts.renderSites = [];
  const renderEdges = index.renderEdges.map((edge, offset) => {
    const site = edge[7];
    if (!site) return edge;
    facts.renderSites!.push([offset, site]);
    return edge.slice(0, edge[6] ? 7 : edge[5] ? 6 : edge[4] ? 5 : 4) as typeof edge;
  });
  return {
    ...rest, symbols, references, routes, renderEdges, hasFlowCalls: !!flowCalls?.length || undefined,
    packedGraph: deflateRawSync(JSON.stringify(facts), { level: 6 }).toString('base64')
  };
}

export function unpackGraph(index: QueryIndex): QueryIndex {
  if (typeof index.packedGraph !== 'string') return index;
  const bytes = inflateRawSync(Buffer.from(index.packedGraph, 'base64'), { maxOutputLength: 32 * 1024 * 1024 });
  const { ends, types, useSites, callOwners, routeDetails, renderSites, ...facts } = JSON.parse(bytes.toString('utf8')) as PackedFacts;
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
  const renderEdges = index.renderEdges.slice();
  for (const [offset, site] of renderSites ?? []) {
    const edge = renderEdges[offset].slice() as QueryIndex['renderEdges'][number];
    edge[7] = site;
    renderEdges[offset] = edge;
  }
  return { ...index, ...facts, references, routes, renderEdges, symbols };
}
