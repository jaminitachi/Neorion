import type { RenderEvidence } from '../core/analyzers/RenderEvidence';
import type { NextUrlConfig } from '../core/analyzers/NextRouteMatch';

export const WRAPPER_INDEX_REVISION = 5;
export const QUERY_INDEX_REVISION = 9;
export const GRAPH_INDEX_REVISION = 12;
export const INDEX_SCHEMA = 2;
export const INDEX_PATH = '.neorion/index.v2.json';
export const LEGACY_INDEX_PATH = '.neorion/index.v1.json';
export const AI_SDK_TRANSPORT = 'AI SDK transport';
export const AI_SDK_URL_OVERRIDE = 'possible AI SDK transport URL override';
export { version as VERSION } from '../../../neorion/package.json';

export const isTestFile = (file: string) =>
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|playwright)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(file);
export const isMiddlewareFile = (file: string) => /^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]sx?$/.test(file);

export interface SymbolEntry {
  id: number;
  file: string;
  name: string;
  kind: 'component' | 'hook' | 'function' | 'constant' | 'procedure';
  line: number;
  end?: number;
  exported?: boolean;
  aliasOf?: string | null;
  localUses?: number[];
  typeOnly?: boolean;
  synthetic?: true;
}

export interface Wrapper {
  file: string;
  symbol: string;
  line: number;
  conditional: boolean;
  possible?: boolean;
  external?: string;
  provider?: boolean;
  providerTag?: boolean;
  definitionFile?: string;
  site?: { file: string; line: number };
  phase?: 'document' | 'application';
  evidence?: string;
  guards?: string[];
  guardIssue?: string;
}

export type FlowGate = { scope: number; sites: string[]; partial?: boolean; uncertainSites?: string[]; unscoped?: true };
export type FlowCall = [from: number, to: number, file: string, line: number, detail: string, gates?: FlowGate[]];

export interface FetchEntry {
  file: string;
  line: number;
  fn: string | null;
  evidence?: string;
  method: string;
  url: string;
  via: string;
  route: number;
  owner?: number;
  graphOwner?: number;
  lifecyclePossible?: true;
  partial?: boolean;
  dynamic?: boolean;
  propUrlUnknown?: true;
  uncertainty?: string;
  binding?: { file: string; line: number; name: string; supplier?: number; site: string };
  gates?: FlowGate[];
}

type ReferenceSite = [line: number, kind: string, detail?: string, caller?: number, graphOwner?: number, possible?: true];
export type Reference = [symbol: number, file: string, ...site: ReferenceSite];
// Null reuses the symbol's defining file. Packed indexes intern other paths
// by their position in the ordered file table.
export type IndexedReference = [symbol: number, file: string | null | number, ...site: ReferenceSite];
export type ExternalCall = [owner: number, line: number, module: number, name: number, count?: number];
export const enum GraphReferenceKind { Use, MemberCall, DynamicImport, Render }
export type TrpcUse = [procedure: number, line: number, operation: string, owner?: number, args?: string, transport?: string, transportIssue?: string];
export type GraphReference = [symbol: number, line: number, kind: GraphReferenceKind, owner?: number, detail?: number];
export type NamespaceUse = [line: number, member?: string, owner?: number];
export type ModuleImport = [target: number, line: number, kind: 'import' | 'effect' | 'export' | 'type',
  bindings?: [imported: string, exported?: string][], namespaceUses?: NamespaceUse[]];
export type RuntimeExportState = 'value' | 'type' | 'unknown';
export type RuntimeExports = { names: Record<string, RuntimeExportState>; unknownStar?: true };

export interface ServerAction {
  file: string;
  name: string;
  aliases?: string[];
  line: number;
  symbol?: number;
  callers: [file: string, line: number, owner?: number][];
}

export type PageRenderCondition = 'excluded' | 'possible';
export const renderSiteKey = (from: number, to: number, line: number) => `${from}:${to}:${line}`;

export interface PagesEdge {
  from: number;
  to?: number;
  route?: number;
  kind: 'data' | 'wrap' | 'middleware' | 'navigate' | 'redirect' | 'rewrite';
  file: string;
  line: number;
  detail?: string;
  possible?: boolean;
  matcher?: { source: string; conditional?: boolean };
}

export interface QueryIndex {
  schema: 1 | typeof INDEX_SCHEMA;
  coverage?: 1 | 2;
  generator?: string;
  generatedAt: string;
  projectSnapshot?: string;
  root: '.';
  files: Record<string, { size: number; mtimeMs: number; sha1: string }>;
  symbols: SymbolEntry[];
  routes: {
    id: number; url: string; file: string; kind: string; line?: number;
    component?: number; fileSymbol?: number; layouts?: number[];
    pages?: boolean;
    methods?: string[];
    methodBasis?: 'enforced' | 'observed';
    observedMethods?: string[]; handlers?: Record<string, number>;
  }[];
  renderEdges: [from: number, to: number, line: number, conditional: number, layout?: true, possible?: true, detail?: string, site?: string][];
  wrapperRevision?: number;
  queryRevision?: number;
  wrapChains: Record<string, Wrapper[]>;
  routeWrap: Record<string, string>;
  branches?: Record<string, string[]>;
  references: IndexedReference[];
  fetches: FetchEntry[];
  uncertainChatTransports?: [file: string, owner: number, unbounded?: boolean][];
  serverActions?: ServerAction[];
  mentions?: Record<string, [file: string, line: number][]>;
  graphRevision?: number;
  packedGraph?: string;
  graphReferences?: Record<number, GraphReference[]>;
  graphNames?: string[];
  externalCalls?: ExternalCall[];
  externalModules?: string[];
  flowCalls?: FlowCall[];
  hasFlowCalls?: boolean;
  callGates?: Record<string, FlowGate[]>;
  flowIssues?: Record<number, { reason: string; gates: FlowGate[] }[]>;
  callIssues?: Record<string, string>;
  refEvidence?: Record<string, string>;
  callLiterals?: Record<string, string>;
  unresolvedCallLiterals?: Record<number, [line: number, callee: string, args: string][]>;
  literalReturns?: Record<number, [line: number, value: string][]>;
  renderLabels?: Record<string, string>;
  renderEvidence?: Record<string, RenderEvidence>;
  uncertainPropRequests?: { file: string; owner: number; method?: string; gates?: FlowGate[] }[];
  unresolvedCalls?: Record<number, number>;
  fileSymbols?: number[]; // In the same order as the keys of files.
  defaultSymbols?: Record<number, number>;
  exportSymbols?: Record<number, Record<string, number[]>>;
  runtimeExports?: Record<number, RuntimeExports>;
  moduleImports?: Record<number, ModuleImport[]>;
  routeFiles?: Record<string, [kind: string, url: string, matcher?: string, component?: number, matchers?: string[]]>;
  layoutStyles?: Record<string, string[]>;
  trpcUses?: Record<number, TrpcUse[]>;
  trpcAliases?: Record<number, number[]>;
  trpcUnbound?: number[];
  trpcIssues?: Record<number, [file: number, line: number][]>;
  trpcFiles?: string[];
  pagesWorkspaceInputs?: { offset: string; files: string[]; hash?: string };
  pagesUrlConfig?: NextUrlConfig;
  pagesEdges?: PagesEdge[];
  pagesIssues?: Record<number, string[]>;
  pagesWrapSites?: Record<number, Record<string, [position: number, evidence: string][]>>;
  pagesRenderConditions?: Record<number, Record<string, PageRenderCondition>>;
  pagesWrapperIssues?: Record<number, string[]>;
  pagesApiIssues?: Record<number, string[]>;
  pagesObservedCalls?: Record<number, [file: string, line: number, expression: string][]>;
  pagesOwnerIssues?: Record<number, string[]>;
  trpcModuleUses?: Record<number, [target: number, line: number][]>;
}
