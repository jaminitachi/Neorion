export interface CodebaseMetadata {
  name: string;
  framework: string;
  router: 'app' | 'pages';
  language: 'ts' | 'js';
  directories: DirectoryMetadata[];
}

export interface DirectoryMetadata {
  path: string;
  role: 'routes' | 'ui_components' | 'react_hooks' | 'api_client' | 'state_management' | 'utils' | 'other';
}

export interface RouteNode {
  id: string;
  path: string; // URL path e.g. /login
  file: string; // File path e.g. app/login/page.tsx
  type: 'page' | 'layout' | 'loading' | 'error' | 'not-found';
  segment: string;
  layoutId?: string; // ID of the parent layout
  componentName?: string; // Name of the component rendered
  isClient: boolean;
  usesHooks?: string[]; // IDs of hooks used
  domain?: string;
}

export interface ComponentNode {
  id: string;
  name: string;
  path: string;
  kind: 'page' | 'layout' | 'ui' | 'form' | 'modal' | 'provider' | 'other';
  isClient: boolean;
  domain?: string;
  props: ComponentProp[];
  imports: ImportInfo[];
  hooks: string[]; // Names of hooks used
  renders: string[]; // IDs of child components rendered
  description?: string;
}

export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

export interface ImportInfo {
  name: string;
  from: string;
  isExternal: boolean;
}

export interface HookNode {
  id: string;
  name: string;
  path: string;
  kind: 'business' | 'utility' | 'other';
  signature: string;
  dependencies: DependencyInfo[];
}

export interface DependencyInfo {
  type: 'api' | 'store' | 'hook' | 'component' | 'other';
  name: string;
  from: string;
}

export interface LibraryInfo {
  name: string;
  version: string;
  role: string;
  usage?: string;
}

export interface CodebaseGraph {
  metadata: CodebaseMetadata;
  routes: RouteNode[];
  components: ComponentNode[];
  hooks: HookNode[];
  libraries: LibraryInfo[];
}
