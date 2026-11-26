import type { RenderEvidence } from '../core/analyzers/RenderEvidence';
import type { RouterPattern } from '../core/frameworks/RouterMatch';
import type { WorkspaceSources } from '../core/ProjectSnapshot';
import type { NextUrlConfig } from '../core/analyzers/NextRouteMatch';

export const WRAPPER_INDEX_REVISION = 11;
export const TRANSPORT_QUERY_REVISION = 9;
export const CALLBACK_QUERY_REVISION = 17;
export const QUERY_INDEX_REVISION = 19;
export const GRAPH_INDEX_REVISION = 25;
export const ROUTER_INDEX_REVISION = 2;
export const INDEX_SCHEMA = 2;
export const INDEX_PATH = '.neorion/index.v2.json';
export const LEGACY_INDEX_PATH = '.neorion/index.v1.json';
export const AI_SDK_TRANSPORT = 'AI SDK transport';
export const AI_SDK_URL_OVERRIDE = 'possible AI SDK transport URL override';
export const CALLABLE_WRITE_ISSUE = 'callable binding or member written';
export const RENDER_LOOKUP_ISSUE = 'component lookup key untraced';
export const DYNAMIC_RENDER_ISSUE = 'rendered through a dynamic reference';
export const isLazyRender = (detail: string | undefined) => !!detail &&
  (detail.startsWith('imported via ') || detail.startsWith('loaded via '));
export const renderIssue = (detail: string) => detail.startsWith(RENDER_LOOKUP_ISSUE) ? RENDER_LOOKUP_ISSUE :
  isLazyRender(detail) ? DYNAMIC_RENDER_ISSUE : 'JSX prop render untraced';
export const AI_SDK_URL_UNCERTAIN = 'uncertain AI SDK URL matches';

export function transportIssue(override?: boolean) {
  return override ? AI_SDK_URL_OVERRIDE : AI_SDK_URL_UNCERTAIN;
}
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
  renderName?: string;
  localUses?: number[];
  typeOnly?: boolean;
  synthetic?: true;
  selectorAliases?: string[];
}

export interface Wrapper {
  file: string;
  symbol: string;
  line: number;
  conditional: boolean;
  possible?: boolean;
  external?: string;
  workspacePackage?: string;
  unresolvedWorkspace?: string;
  provider?: boolean;
  providerTag?: boolean;
  definitionFile?: string;
  site?: { file: string; line: number };
  phase?: 'document' | 'application';
  evidence?: string;
  guard?: RenderEvidence;
  guardFile?: string;
}

export type FlowGate = { scope: number; sites: string[]; partial?: boolean; uncertainSites?: string[]; unscoped?: true; callback?: true };
export type BooleanArguments = [parameter: number, value: boolean][];
export type ApiCallFact = [args?: BooleanArguments, guards?: BooleanArguments];
export const apiCallKey = (file: string, line: number, target: number, caller?: number) =>
  `${caller ?? file}:${target}:${line}`;
export type CallbackCreation = [factory: number, file: string, line: number, covered?: true];
export type CallbackInvocation = [caller: number, file: string, line: number, event?: string, possible?: true | 'write'];
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
  transportOverride?: boolean;
  possibleReconnect?: true;
  partial?: boolean;
  dynamic?: boolean;
  propUrlUnknown?: true;
  otherTemplateRoute?: string;
  uncertainty?: string;
  binding?: { file: string; line: number; name: string; supplier?: number; site: string };
  gates?: FlowGate[];
  argumentGuards?: BooleanArguments;
}

type ReferenceSite = [line: number, kind: string, detail?: string, caller?: number, graphOwner?: number, possible?: true];
export type Reference = [symbol: number, file: string, ...site: ReferenceSite];
// Null reuses the symbol's defining file. Packed indexes intern other paths
// by their position in the ordered file table.
export type IndexedReference = [symbol: number, file: string | null | number, ...site: ReferenceSite];
export type ExternalCall = [owner: number, line: number, module: number, name: number, count?: number];
export const enum GraphReferenceKind { Use, MemberCall, DynamicImport, Render, TypeUse, ReturnedUse }
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

export type PageRenderCondition = 'excluded' | 'possible' | 'conditional';
export const renderSiteKey = (from: number, to: number, line: number) => `${from}:${to}:${line}`;
export const renderGuardKey = (from: number, to: number, line: number, site?: string | null) =>
  `${renderSiteKey(from, to, line)}:${site ?? ''}`;

export function advanceRenderGuards(pending: string[][], incoming: string | null | undefined, started: string[][] | undefined) {
  const matching = incoming ? pending.filter(path => path[0] === incoming).map(path => path.slice(1)) : [];
  if (matching.some(path => !path.length) || started?.some(path => !path.length)) return;
  return started ? [...matching, ...started] : matching;
}

export interface PagesEdge {
  from: number;
  to?: number;
  route?: number;
  kind: 'data' | 'wrap' | 'middleware' | 'navigate' | 'redirect' | 'rewrite';
  file: string;
  line: number;
  detail?: string;
  possible?: boolean;
  matcher?: { source: string; conditional?: boolean; overlap?: boolean };
}

export type RouterEntry = {
  role: string;
  symbol: number;
  file: string;
  line: number;
  method?: string;
};

export type RouterEdge = {
  from?: number;
  source?: number;
  destination?: number;
  to?: number;
  kind: 'data' | 'render' | 'wrap' | 'navigate' | 'redirect' | 'load' | 'submit';
  file: string;
  line: number;
  detail: string;
  method?: string;
  conditional?: boolean;
  possible?: boolean;
};

export type RouterIssue =
  | { kind: 'import' | 'module' | 'wrapper'; reason: string; file: string; route?: number }
  | { kind: 'navigation'; reason: string; file: string; route?: number; owner: number; request: boolean; destinations?: number[] }
  | { kind: 'missing-action'; reason: string; file: string; route?: number; owner: number }
  | { kind: 'registry'; reason: string; file: string; route?: number; owner: number; destinations: number[] };

export type RouterRegistryIssue = { reason: string; registration?: { url: string; file: string; id: string } };

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
    router?: RouterPattern & {
      site: { file: string; line: number };
      entries?: RouterEntry[];
      boundaries?: RouterEntry[];
      renderable?: false;
      conditionalRender?: true;
      possibleRender?: true;
      conditionalLayouts?: number[];
      possibleLayouts?: number[];
    };
    methods?: string[];
    methodBasis?: 'enforced' | 'observed';
    observedMethods?: string[]; handlers?: Record<string, number>;
  }[];
  renderEdges: [from: number, to: number, line: number, conditional: number, layout?: true, possible?: true, detail?: string, site?: string | null, file?: string][];
  renderExclusions?: Record<string, string[]>;
  renderGuardPaths?: Record<string, string[][]>;
  renderConditionalPaths?: Record<string, string[][]>;
  renderWitnessPaths?: Record<string, string[][]>;
  contextRenderExclusions?: string[];
  renderLookupIssues?: Record<number, string>;
  opaqueRenderLookupIssues?: Record<number, string>;
  scopedRenderValueIssues?: Record<number, { file: string; reason: string; valueFile: string }>;
  dynamicRenderComponents?: number[];
  wrapperRevision?: number;
  queryRevision?: number;
  wrapChains: Record<string, Wrapper[]>;
  routeWrap: Record<string, string>;
  branches?: Record<string, string[]>;
  references: IndexedReference[];
  fetches: FetchEntry[];
  uncertainChatTransports?: [file: string, owner: number, unbounded?: boolean, line?: number, override?: boolean][];
  serverActions?: ServerAction[];
  mentions?: Record<string, [file: string, line: number][]>;
  graphRevision?: number;
  packedGraph?: string;
  graphReferences?: Record<number, GraphReference[]>;
  graphNames?: string[];
  externalCalls?: ExternalCall[];
  externalModules?: string[];
  flowCalls?: FlowCall[];
  callableOwners?: Record<number, number>;
  callbackCoverageGaps?: Record<number, [file: string, line: number][]>;
  callbackCreations?: Record<number, CallbackCreation[]>;
  apiCallFacts?: Record<string, ApiCallFact>;
  callbackInvocations?: Record<number, CallbackInvocation[]>;
  hasFlowCalls?: boolean;
  callGates?: Record<string, FlowGate[]>;
  flowIssues?: Record<number, { reason: string; gates: FlowGate[] }[]>;
  callIssues?: Record<string, string>;
  refEvidence?: Record<string, string>;
  sourceEvidence?: true;
  callLiterals?: Record<string, string[]>;
  unresolvedCallLiterals?: Record<number, [line: number, callee: string, args: string][]>;
  returnLiterals?: Record<number, [line: number, value: string][]>;
  renderEvidence?: Record<string, RenderEvidence>;
  memoizedCallbacks?: number[];
  renderLabels?: Record<string, string>;
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
  trpcHttpIssues?: Record<number, string>;
  trpcAliases?: Record<number, number[]>;
  trpcUnbound?: number[];
  trpcIssues?: Record<number, [file: number, line: number][]>;
  trpcFiles?: string[];
  workspaceSources?: WorkspaceSources;
  workspacePackages?: Record<string, string>;
  workspaceDependencies?: Record<number, { module: string; gates?: FlowGate[] }[]>;
  workspaceDiscoveryLimited?: true;
  // Legacy index inputs used for Pages bindings and SDK version inference.
  pagesWorkspaceInputs?: { offset: string; files: string[]; hash?: string };
  router?: {
    framework: 'react-router' | 'remix';
    basename: string;
    revision: number;
    dependencies?: string;
    registryIssues: RouterRegistryIssue[];
    registryFiles: string[];
    issues: RouterIssue[];
    edges: RouterEdge[];
  };
  pagesUrlConfig?: NextUrlConfig;
  appUrlConfig?: NextUrlConfig;
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

export function lexicalOwner(owners: QueryIndex['callableOwners'], id: number): number {
  while (owners?.[id] !== undefined) id = owners[id];
  return id;
}
