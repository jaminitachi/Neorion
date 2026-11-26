import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { Node, SyntaxKind, type Project, type SourceFile } from 'ts-morph';
import { valueNode } from '../../analyzers/StaticBindings';
import { startLine } from '../../analyzers/SourceLines';
import { isClientFile } from '../../analyzers/RouteAnalyzer';
import { DomainExtractor } from '../../utils/DomainExtractor';
import { configExtensions, type RouterFramework } from '../RouterProbe';
import { fileRoutes } from './FileRoutes';
import { defaultValue, readRouteConfig } from './RouteConfig';
import { frameworkBinding, properties, stringList, stringValue } from './StaticConfig';
import { type Issue, type Registration, type RouterProject, type RouterRoute, slash, sourceExtension, trimPath } from './RouteTypes';

const moduleExtensions = ['tsx', 'ts', 'jsx', 'js', 'mts', 'mjs', 'cts', 'cjs'];

function within(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function viteOptions(file: SourceFile | undefined, framework: RouterFramework, issue: Issue, required: boolean) {
  const calls = file?.getDescendantsOfKind(SyntaxKind.CallExpression).filter(call => {
    const binding = frameworkBinding(call.getExpression());
    return framework === 'react-router' ? binding?.module === '@react-router/dev/vite' && binding.name === 'reactRouter' :
      binding?.module === '@remix-run/dev' && binding.name === 'vitePlugin' ||
      binding?.module === '@remix-run/dev/vite' && ['remix', 'vitePlugin'].includes(binding.name);
  }) ?? [];
  if (required && !calls.length) issue(file, `unverified ${framework} Vite plugin`);
  if (calls.length > 1) issue(file, `multiple ${framework} Vite plugin configurations`);
  return framework === 'remix' ? calls[0]?.getArguments()[0] : undefined;
}

export function analyzeRouter(root: string, project: Project, framework: RouterFramework): RouterProject {
  const registryIssues: string[] = [];
  const registryFiles = new Set<string>();
  const relative = (file: SourceFile) => slash(path.relative(root, file.getFilePath()));
  const issue: Issue = (site, message) => {
    const reason = site ? `${message} (${relative(site.getSourceFile())}:${startLine(site)})` : message;
    if (!registryIssues.includes(reason)) registryIssues.push(reason);
  };
  const realRoot = realpathSync(root);
  const sourceFor = (file: string) => {
    if (!within(root, file) || !sourceExtension.test(file) || /\.d\.[cm]?ts$/.test(file) ||
        !statSync(file, { throwIfNoEntry: false })?.isFile() || !within(realRoot, realpathSync(file))) return;
    return project.getSourceFile(file) ?? project.addSourceFileAtPath(file);
  };
  const locate = (directory: string, base: string, extensions: string[]) =>
    extensions.map(ext => path.join(directory, base + '.' + ext)).find(file => statSync(file, { throwIfNoEntry: false })?.isFile());
  const load = (directory: string, base: string, extensions: string[]) => {
    const file = locate(directory, base, extensions);
    return file && sourceFor(file);
  };
  const config = load(root, framework + '.config', configExtensions) || undefined;
  const vite = (framework === 'remix' || !config) ? load(root, 'vite.config', configExtensions) || undefined : undefined;
  for (const source of [config, vite]) if (source) registryFiles.add(relative(source));
  const configValue = viteOptions(vite, framework, issue, !config) ?? defaultValue(config);
  const opts = configValue ? properties(configValue) : new Map<string, Node>();
  if (!opts || config && !configValue && !vite) issue(config ?? vite, `dynamic ${framework} configuration`);
  const directory = opts?.get('appDirectory');
  const appDirectory = directory ? stringValue(directory) : 'app';
  if (!appDirectory || /[\x00-\x1f]/.test(appDirectory)) issue(directory, 'dynamic or invalid appDirectory');
  const app = path.resolve(root, appDirectory && !/[\x00-\x1f]/.test(appDirectory) ? appDirectory : 'app');
  const safeApp = within(root, app) && (!statSync(app, { throwIfNoEntry: false }) || within(realRoot, realpathSync(app)));
  if (!safeApp) issue(directory, 'appDirectory is outside the project');
  const baseNode = opts?.get('basename');
  const basename = baseNode ? stringValue(baseNode) : '/';
  if (!basename || !basename.startsWith('/')) issue(baseNode, 'dynamic or invalid router basename');

  const routes: RouterRoute[] = [];
  const result: RouterProject = { framework, app, routes, basename: basename ?? '/', registryIssues, registryFiles: [...registryFiles] };
  if (!safeApp || !appDirectory || /[\x00-\x1f]/.test(appDirectory) || !opts) return result;
  const routeConfig = framework === 'react-router' && load(app, 'routes', configExtensions) || undefined;
  if (routeConfig) registryFiles.add(relative(routeConfig));
  const rootSource = load(app, 'root', moduleExtensions) || undefined;
  if (!rootSource) issue(undefined, 'root route module was not found');
  if (framework === 'react-router' && !routeConfig) issue(undefined, 'routes configuration was not found');
  const ignored = opts.get('ignoredRouteFiles');
  const ignoredFiles = ignored ? stringList(ignored) : [];
  if (framework === 'remix' && !ignoredFiles) issue(ignored, 'dynamic ignoredRouteFiles');
  const custom = opts.get('routes');
  if (framework === 'remix' && custom) issue(custom, 'unsupported Remix custom route registry');
  const flags = properties(opts.get('future'));
  if (framework === 'remix' && opts.has('future') && !flags) issue(opts.get('future'), 'dynamic Remix future flags');
  const configFlag = valueNode(flags?.get('v3_routeConfig'));
  if (framework === 'remix' && configFlag && !Node.isFalseLiteral(configFlag)) {
    issue(configFlag, 'unsupported Remix v3_routeConfig registry');
    return result;
  }

  // Route registration may import files excluded by the app's tsconfig.
  project.resolveSourceFileDependencies();
  const conventionSite = rootSource ?? config ?? vite;
  const registrations = routeConfig ? readRouteConfig(routeConfig, app, issue) :
    framework === 'remix' && conventionSite && ignoredFiles
      ? fileRoutes(app, { directory: 'routes', ignored: ignoredFiles }, conventionSite, issue) : [];
  const ids = new Set<string>();
  const visit = (entry: Registration, parent?: RouterRoute) => {
    if (ids.has(entry.id)) {
      issue(entry.site, `duplicate route registration ID ${entry.id}`);
      return;
    }
    if (!Node.isSourceFile(entry.site)) registryFiles.add(relative(entry.site.getSourceFile()));
    if (/[\x00-\x1f]/.test(entry.file)) {
      issue(entry.site, 'invalid route module path');
      return;
    }
    const filename = path.resolve(app, entry.file);
    const source = sourceFor(filename);
    if (!source) issue(entry.site, `route module unresolved (${entry.file})`);
    if (!within(root, filename)) return;
    const parentPath = parent ? trimPath(parent.path) : '';
    const local = trimPath(entry.path ?? '');
    let full = [parentPath, local].filter(Boolean).join('/');
    if (entry.path?.startsWith('/') && parentPath) {
      if (local !== parentPath && !local.startsWith(parentPath + '/')) {
        issue(entry.site, `absolute child route ${entry.path} does not start with /${parentPath}`);
        return;
      }
      full = local;
    }
    const file = slash(path.relative(root, filename));
    const route: RouterRoute = {
      id: entry.id, file, path: '/' + full, source, site: entry.site,
      type: !parent || !entry.index && entry.path === undefined ? 'layout' : 'page',
      router: { id: entry.id, parentId: parent?.id, pattern: entry.path, index: entry.index, caseSensitive: entry.caseSensitive },
      isClient: !!source && isClientFile(source), domain: DomainExtractor.extract(filename)
    };
    ids.add(route.id);
    routes.push(route);
    for (const child of entry.children ?? []) visit(child, route);
  };
  if (conventionSite) {
    const rootFile = rootSource ? path.basename(rootSource.getFilePath()) : 'root.tsx';
    visit({ id: 'root', file: rootFile, site: rootSource ?? conventionSite, children: registrations });
  }
  project.resolveSourceFileDependencies();
  for (const route of routes) {
    const exports = route.source?.getExportedDeclarations();
    if (route.router.parentId && exports && !exports.has('default') && (exports.has('loader') || exports.has('action'))) {
      route.type = 'api';
      if (exports.has('loader')) route.methods = ['GET'];
      if (exports.has('action')) (route.methods ??= []).push('?');
    }
  }
  result.registryFiles = [...registryFiles];
  return result;
}
