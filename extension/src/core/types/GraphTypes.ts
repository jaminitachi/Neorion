export interface DirectoryMetadata {
  path: string;
  role: 'routes' | 'ui_components' | 'react_hooks' | 'other';
}

export interface RouteNode {
  id: string;
  path: string;
  file: string;
  type: 'page' | 'layout' | 'loading' | 'error' | 'not-found' | 'api';
  methods?: string[];
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
  type: 'imports' | 'renders';
}

export interface LibraryInfo {
  name: string;
  version: string;
}

export interface CodebaseGraph {
  metadata: {
    name: string;
    directories: DirectoryMetadata[];
  };
  routes: RouteNode[];
  components: ComponentNode[];
  hooks: HookNode[];
  edges: ComponentEdge[];
  libraries: LibraryInfo[];
}
