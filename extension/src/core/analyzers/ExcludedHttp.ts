import { Project, ts } from 'ts-morph';
import { collectApiFacts } from './ArchitectureFacts';
import type { NextConfig } from './NextConfig';
import type { RouteNode } from '../types/GraphTypes';
import type { FetchEntry } from '../../mcp/Index';

export function collectExcludedRequests(root: string, file: string, text: string, routes: RouteNode[],
  config: NextConfig | undefined, onRequest: (entry: FetchEntry) => void) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve }
  });
  const source = project.createSourceFile('/' + file, text);
  collectApiFacts(root, [source], routes, () => file, new Map(), undefined, () => undefined,
    undefined, undefined, undefined, undefined, config, onRequest);
}
