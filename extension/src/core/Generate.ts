import * as path from 'path';
import * as fs from 'fs';
import { validRange } from 'semver';
import { Project, ts } from 'ts-morph';
import { hasOwnRoutes, ignoredProjectDirectories, projectConfig, workspaceDirectories } from './FindProject';
import { projectSnapshot } from './ProjectSnapshot';
import { readNextConfig } from './analyzers/NextConfig';
import { WorkspaceBindings, within } from './analyzers/WorkspaceBindings';
import { RouteAnalyzer } from './analyzers/RouteAnalyzer';
import { ComponentAnalyzer } from './analyzers/ComponentAnalyzer';
import { writeGraph } from './serializers/GraphOutput';
import { CodebaseGraph, DirectoryMetadata, LibraryInfo } from './types/GraphTypes';

export { findProject } from './FindProject';

interface GenerateOptions {
    markdown?: boolean;
    index?: boolean;
    migrateLegacy?: boolean;
    onProgress?: (message: string) => void;
}

export function generateGraph(projectPath: string, options: GenerateOptions) {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const routerDirectory = (name: string) => {
        const root = path.join(projectPath, name);
        return fs.existsSync(root) ? root : path.join(projectPath, 'src', name);
    };
    const appDir = routerDirectory('app');
    const pagesDir = routerDirectory('pages');

    options.onProgress?.("Analyzing project structure...");

    const snapshot = options.markdown ? projectSnapshot(projectPath) : undefined;
    const rootWorkspaceApp = workspaceDirectories(projectPath)?.directories.some(directory => directory !== projectPath) && hasOwnRoutes(projectPath);
    const workspace = new WorkspaceBindings(projectPath, rootWorkspaceApp);
    const workspaceSources = options.markdown ? workspace.snapshot() : undefined;
    const project = openProject(projectPath, workspace);

    const sourceFiles = project.getSourceFiles().filter(file => {
        const filePath = file.getFilePath();
        return !file.isDeclarationFile() && (within(projectPath, filePath) || workspace.packageFor(filePath)) &&
            !path.relative(projectPath, filePath).split(path.sep)
                .some(part => part === 'node_modules' || part === '.next');
    });
    const pagesConfig = fs.existsSync(pagesDir) ? readNextConfig(projectPath, sourceFiles) : undefined;
    const routes = new RouteAnalyzer(appDir, pagesDir, projectPath, pagesConfig, workspace).analyze(sourceFiles, staticMetadataFiles(appDir));
    const appPrefix = path.relative(projectPath, appDir).split(path.sep).join('/') + '/';
    const hasAppRoutes = routes.some(route => route.file.startsWith(appPrefix));
    const hasPagesRoutes = routes.some(route => !route.file.startsWith(appPrefix));
    options.onProgress?.("Scanning components and hooks...");
    const analysis = new ComponentAnalyzer(projectPath, pagesConfig, workspace)
        .analyze(sourceFiles, routes, !!(options.markdown || options.index), !!options.index && !options.markdown);

    if (analysis.index) {
        analysis.index.projectSnapshot = snapshot;
        analysis.index.workspaceSources = workspaceSources;
    }

    const directories = new Map<string, DirectoryMetadata>();
    const routeDirectories = [appDir, pagesDir].map(dir => path.relative(projectPath, dir).split(path.sep).join('/'));
    for (const file of sourceFiles) {
        if (!within(projectPath, file.getFilePath())) continue;
        const parts = path.relative(projectPath, file.getFilePath()).split(path.sep).slice(0, -1);
        for (const [index, part] of parts.entries()) {
            const directory = parts.slice(0, index + 1).join('/');
            if (index > (parts[0] === 'src' ? 1 : 0)) break;
            const role = routeDirectories.includes(directory) ? 'routes' : part === 'components' ? 'ui_components' :
                part === 'hooks' ? 'react_hooks' : 'other';
            directories.set(directory, { path: directory, role });
        }
    }

    let name = path.basename(projectPath);
    let libraries: LibraryInfo[] = [];
    let devDependencies: string[] = [];
    if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        if (typeof pkg?.name === 'string' && pkg.name.trim()) name = pkg.name;
        libraries = Object.entries(pkg?.dependencies ?? {}).map(([name, version]) => ({
            name,
            version: safeDependencySpec(version)
        }));
        devDependencies = Object.keys(pkg?.devDependencies ?? {}).sort();
    }

    // 4. Construct Graph
    const graph: CodebaseGraph = {
        metadata: {
            name,
            router: hasAppRoutes ? (hasPagesRoutes ? 'mixed' : 'app') : (hasPagesRoutes ? 'pages' : 'none'),
            directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path))
        },
        routes,
        sourceFileCount: sourceFiles.length,
        ...analysis,
        libraries,
        devDependencies
    };

    if (!options.markdown) return { graph };
    options.onProgress?.("Generating Markdown...");
    return { graph, outputPath: writeGraph(projectPath, graph, options.migrateLegacy ?? false) };
}

function openProject(root: string, workspace: WorkspaceBindings): Project {
    const resolutionHost = workspace.resolutionHost();
    const configPath = projectConfig(root);
    const typescript = configPath && path.basename(configPath) === 'tsconfig.json';
    if (typescript && !resolutionHost) {
        return new Project({ tsConfigFilePath: configPath, resolutionHost });
    }

    const configHost = resolutionHost ? workspace.configHost() : ts.sys;
    const config = configPath ? ts.readConfigFile(configPath, configHost.readFile) : { config: {} };
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parse = (host: ts.ParseConfigHost) => ts.parseJsonConfigFileContent({ ...config.config }, host, root,
        typescript ? undefined : { allowJs: true, checkJs: false }, configPath ?? path.join(root, 'jsconfig.json'));
    // Resolve inherited file selection before applying defaults to wildcard discovery.
    const selection = config.config.extends ? parse({ ...configHost, readDirectory: () => [] }).raw : config.config;
    const host: ts.ParseConfigHost = selection.files === undefined && selection.include === undefined && selection.exclude === undefined && !typescript
        ? {
            ...configHost,
            readDirectory(directory, extensions, excludes, includes, depth) {
                return ts.sys.readDirectory(directory, extensions, [...(excludes ?? []), ...ignoredProjectDirectories], includes, depth);
            }
        } : configHost;
    const { options, fileNames } = parse(host);
    const project = new Project({ resolutionHost, compilerOptions: { jsx: ts.JsxEmit.Preserve, ...options } });
    for (const file of fileNames) {
        if (!workspace.isRootWorkspace() || !workspace.packageFor(file)) project.addSourceFileAtPath(file);
    }
    project.resolveSourceFileDependencies();
    return project;
}

function staticMetadataFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
            return staticMetadataFiles(file);
        }
        return entry.isFile() && /^(?:opengraph-image\.(?:png|jpg|jpeg|gif)|robots\.txt|sitemap\.xml)$/.test(entry.name)
            ? [file] : [];
    }).sort();
}

function safeDependencySpec(value: unknown): string {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return '[redacted]';
    const spec = value.trim();
    const isTag = (version: string) => /^[a-z][a-z0-9-]*$/i.test(version);
    if (spec && (validRange(spec) || isTag(spec))) return spec;

    const alias = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@(.+))?$/i.exec(spec);
    if (alias && (!alias[1] || validRange(alias[1]) || isTag(alias[1]))) return spec;

    const workspace = /^workspace:(.+)$/.exec(spec)?.[1];
    if (workspace && (validRange(workspace) || workspace === '^' || workspace === '~')) return spec;

    // Accept repository URLs with plain path segments and an optional ref.
    const git = /^(?:git\+)?https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[a-z0-9_-][a-z0-9_.-]*)+\.git(?:#[a-z0-9_-][a-z0-9_.-]*(?:\/[a-z0-9_-][a-z0-9_.-]*)*)?$/i;
    return git.test(spec) ? spec : '[redacted]';
}
