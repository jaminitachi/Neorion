import type { RouterPattern } from '../frameworks/RouterMatch';
import type { QueryIndex } from '../../mcp/Index';

export interface DirectoryMetadata {
  path: string;
  role: 'routes' | 'ui_components' | 'react_hooks' | 'other';
}

export interface RouteNode {
  id: string;
  path: string;
  file: string;
  type: 'page' | 'layout' | 'loading' | 'error' | 'not-found' | 'api' | 'robots' | 'sitemap' | 'opengraph-image' | 'template' | 'default' | 'global-error';
  methods?: string[];
  methodBasis?: 'enforced' | 'observed';
  observedMethods?: string[];
  pages?: boolean;
  router?: RouterPattern;
  issue?: string;
  scope?: string;
  wraps?: string[];
  componentId?: string;
  isClient: boolean;
  domain: string;
}

export interface ComponentNode {
  id: string;
  name: string;
  path: string;
  isClient: boolean;
  domain: string;
  props: string[];
  hooks: string[];
  description?: string;
  aliasOf?: string;
}

export interface HookNode {
  id: string;
  name: string;
  path?: string;
  module?: string;
}

export interface ComponentEdge {
  from: string;
  to: string;
  type: 'imports' | 'renders' | 'uses-action';
}

export interface LibraryInfo {
  name: string;
  version: string;
}

export interface FactValue {
  depth: number;
  fanOut: number;
  layoutOnly?: boolean;
}

export type DetailFacts = Map<string, Map<string, FactValue>>;

export interface CodebaseGraph {
  metadata: {
    name: string;
    router: 'app' | 'pages' | 'mixed' | 'none' | 'react-router' | 'remix';
    directories: DirectoryMetadata[];
  };
  routes: RouteNode[];
  pagesApps?: { file: string; componentId?: string }[];
  index?: QueryIndex;
  sourceFileCount: number;
  facts: DetailFacts;
  components: ComponentNode[];
  hooks: HookNode[];
  edges: ComponentEdge[];
  libraries: LibraryInfo[];
  devDependencies: string[];
  actions: string[];
  fileHooks: Map<string, { hooks: string[]; isClient: boolean }>;
}
