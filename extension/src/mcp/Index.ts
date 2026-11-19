export const INDEX_PATH = '.neorion/index.v1.json';
export const VERSION = '0.4.0';

export const isTestFile = (file: string) =>
  /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|playwright)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(file);

export interface SymbolEntry {
  id: number;
  file: string;
  name: string;
  kind: 'component' | 'hook' | 'function' | 'constant';
  line: number;
  exported?: boolean;
  aliasOf?: string | null;
}

export interface Wrapper {
  file: string;
  symbol: string;
  line: number;
  conditional: boolean;
  external?: string;
}

export interface FetchEntry {
  file: string;
  line: number;
  fn: string | null;
  method: string;
  url: string;
  via: string;
  route: number;
  owner?: number;
  partial?: boolean;
}

export type Reference = [symbol: number, file: string, line: number, kind: string, detail?: string, caller?: number];

export interface QueryIndex {
  schema: 1;
  coverage?: 1;
  generator: string;
  generatedAt: string;
  root: '.';
  files: Record<string, { size: number; mtimeMs: number; sha1: string }>;
  symbols: SymbolEntry[];
  routes: {
    id: number; url: string; file: string; kind: string; line?: number;
    component?: number; fileSymbol?: number; layouts?: number[];
  }[];
  renderEdges: [from: number, to: number, line: number, conditional: number][];
  wrapChains: Record<string, Wrapper[]>;
  routeWrap: Record<string, string>;
  branches?: Record<string, string[]>;
  references: Reference[];
  fetches: FetchEntry[];
  mentions?: Record<string, [file: string, line: number][]>;
}
