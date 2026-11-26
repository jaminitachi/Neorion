import type { Node, SourceFile } from 'ts-morph';
import type { RouteNode } from '../../types/GraphTypes';
import type { RouterRegistryIssue } from '../../../mcp/Index';
import type { RouterFramework } from '../RouterProbe';

export type Registration = {
  id: string;
  file: string;
  path?: string;
  index?: boolean;
  caseSensitive?: boolean;
  site: Node;
  children?: Registration[];
};

export type Issue = (site: Node | undefined, message: string, registration?: RouterRegistryIssue['registration']) => void;

export type RouterRoute = RouteNode & {
  router: NonNullable<RouteNode['router']>;
  site: Node;
  source?: SourceFile;
};

export type RouterProject = {
  framework: RouterFramework;
  app: string;
  basename: string;
  routes: RouterRoute[];
  registryIssues: RouterRegistryIssue[];
  registryFiles: string[];
};

export const sourceExtension = /\.[cm]?[jt]sx?$/;
export const slash = (file: string) => file.replace(/\\/g, '/');
export const trimPath = (part: string) => part.replace(/^\/+|\/+$/g, '');
