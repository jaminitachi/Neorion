import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { validRange } from 'semver';
import { Project } from 'ts-morph';
import { RouteAnalyzer } from './core/analyzers/RouteAnalyzer';
import { ComponentAnalyzer } from './core/analyzers/ComponentAnalyzer';
import { AGENT_FILES, updateAgentFiles } from './core/AgentInstructions';
import { writeGraph } from './core/serializers/GraphOutput';
import { CodebaseGraph, DirectoryMetadata, LibraryInfo } from './core/types/GraphTypes';

import { GraphVisualizer } from './core/visualizers/GraphVisualizer';

export function activate(context: vscode.ExtensionContext) {

    // Command: Generate Graph (Markdown)
    let generateGraphDisposable = vscode.commands.registerCommand('neo.generateGraph', async () => {
        await runAnalysis(context, { markdown: true });
    });

    // Command: Show Graph (Visualization)
    let showGraphDisposable = vscode.commands.registerCommand('neo.showGraph', async () => {
        await runAnalysis(context, { visualize: true });
    });

    for (const [command, connect] of [['neo.connectAITools', true], ['neo.disconnectAITools', false]] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) return vscode.window.showErrorMessage('No workspace folder open');
            await configureAgents(root, connect ? await findProject(root) ?? root : root, connect);
        }));
    }

    // Auto-update on save
    let debounceTimer: NodeJS.Timeout;
    const debouncedUpdate = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            // Update both if possible, silent mode
            runAnalysis(context, { markdown: true, visualize: !!GraphVisualizer.currentPanel }, true);
        }, 2000); // 2 second debounce
    };

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        // Only trigger for relevant files
        if (doc.languageId === 'typescript' || doc.languageId === 'typescriptreact' || doc.fileName.endsWith('package.json')) {
            debouncedUpdate();
        }
    }));

    context.subscriptions.push(generateGraphDisposable);
    context.subscriptions.push(showGraphDisposable);
}

async function findProject(root: string) {
    if (fs.existsSync(path.join(root, 'tsconfig.json'))) return root;
    const configs = await vscode.workspace.findFiles('**/tsconfig.json', '**/{node_modules,.next}/**');
    const candidates = configs.map(uri => uri.fsPath).filter(file => isWithin(root, file));
    candidates.sort((a, b) =>
        path.relative(root, a).split(path.sep).length -
        path.relative(root, b).split(path.sep).length || a.localeCompare(b));
    return candidates.length ? path.dirname(candidates[0]) : undefined;
}

async function configureAgents(root: string, project: string, connect: boolean) {
    try {
        const targets = connect ? await vscode.window.showQuickPick(AGENT_FILES.map(label => ({
            label,
            picked: fs.existsSync(path.join(root, label))
        })), { canPickMany: true, placeHolder: 'Choose AI instruction files to update' }) : AGENT_FILES.map(label => ({ label }));
        if (!targets?.length) return;
        const selectedPaths = new Set(targets.map(target => path.join(root, target.label)));
        const dirty = vscode.workspace.textDocuments?.find(doc => doc.isDirty && selectedPaths.has(doc.uri.fsPath));
        if (dirty) throw new Error(`Save ${vscode.workspace.asRelativePath(dirty.uri)} before updating AI instructions`);
        const count = updateAgentFiles(root, project, targets.map(target => target.label), connect);
        vscode.window.showInformationMessage(`Neorion updated ${count} AI instruction file(s).`);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not update AI instructions: ${error}`);
    }
}

interface AnalysisOptions {
    markdown?: boolean;
    visualize?: boolean;
}

async function runAnalysis(context: vscode.ExtensionContext, options: AnalysisOptions, silent: boolean = false) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
        if (!silent) vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const projectPath = await findProject(workspaceRoot);
    if (!projectPath) {
        if (!silent) vscode.window.showErrorMessage('No tsconfig.json found in workspace!');
        return;
    }
    const tsConfigPath = path.join(projectPath, 'tsconfig.json');

    const packageJsonPath = path.join(projectPath, 'package.json');
    const routerDirectory = (name: string) => {
        const root = path.join(projectPath, name);
        return fs.existsSync(root) ? root : path.join(projectPath, 'src', name);
    };
    const appDir = routerDirectory('app');
    const pagesDir = routerDirectory('pages');

    const run = async (progress?: vscode.Progress<{ message?: string }>) => {
        try {
            if (progress) progress.report({ message: "Analyzing project structure..." });
            
            const project = new Project({
                tsConfigFilePath: tsConfigPath,
            });

            const sourceFiles = project.getSourceFiles().filter(file => {
                const filePath = file.getFilePath();
                return !file.isDeclarationFile() && isWithin(projectPath, filePath) &&
                    !path.relative(projectPath, filePath).split(path.sep)
                        .some(part => part === 'node_modules' || part === '.next');
            });
            const routes = new RouteAnalyzer(appDir, pagesDir, projectPath).analyze(sourceFiles, staticMetadataFiles(appDir));
            const appPrefix = path.relative(projectPath, appDir).split(path.sep).join('/') + '/';
            const hasAppRoutes = routes.some(route => route.file.startsWith(appPrefix));
            const hasPagesRoutes = routes.some(route => !route.file.startsWith(appPrefix));
            if (progress) progress.report({ message: "Scanning components and hooks..." });
            const analysis = new ComponentAnalyzer(projectPath).analyze(sourceFiles, routes, !!options.markdown);

            const directories = new Map<string, DirectoryMetadata>();
            const routeDirectories = [appDir, pagesDir].map(dir => path.relative(projectPath, dir).split(path.sep).join('/'));
            for (const file of sourceFiles) {
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

            if (options.markdown) {
                // 5. Serialize
                if (progress) progress.report({ message: "Generating Markdown..." });
                const outputPath = writeGraph(projectPath, graph);

                const promptKey = 'neo.agentPromptShown:' + projectPath;
                if (context.workspaceState && !context.workspaceState.get(promptKey)) {
                    const saved = context.workspaceState.update(promptKey, true);
                    void Promise.resolve(saved).then(async () => {
                        const answer = await vscode.window.showInformationMessage(
                            'Connect AI tools to the Neorion architecture map?', 'Yes');
                        if (answer === 'Yes') await configureAgents(workspaceRoot, projectPath, true);
                    }).catch(error => console.error(error));
                }

                if (!silent) {
                    const doc = await vscode.workspace.openTextDocument(outputPath);
                    await vscode.window.showTextDocument(doc);
                    vscode.window.showInformationMessage(`Architecture Map generated!`);
                }
            } 
            
            if (options.visualize) {
                // 5. Visualize
                if (progress) progress.report({ message: "Rendering Graph..." });
                GraphVisualizer.createOrShow(context.extensionUri, graph, projectPath);
            }

        } catch (error) {
            console.error(error);
            if (!silent) vscode.window.showErrorMessage(`Failed to process: ${error}`);
        }
    };

    if (silent) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window, // Show in status bar
            title: "Updating Architecture Graph...",
            cancellable: false
        }, async () => {
            await run();
        });
    } else {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: options.markdown ? "Generating Architecture Map..." : "Visualizing Architecture...",
            cancellable: false
        }, async (progress) => {
            await run(progress);
        });
    }
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

function isWithin(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function deactivate() {}
