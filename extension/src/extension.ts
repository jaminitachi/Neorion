import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Project } from 'ts-morph';
import { RouteAnalyzer } from './core/analyzers/RouteAnalyzer';
import { ComponentAnalyzer } from './core/analyzers/ComponentAnalyzer';
import { MarkdownSerializer } from './core/serializers/MarkdownSerializer';
import { CodebaseGraph, LibraryInfo } from './core/types/GraphTypes';

import { GraphVisualizer } from './core/visualizers/GraphVisualizer';

export function activate(context: vscode.ExtensionContext) {
    console.log('Neo Architecture Map extension is now active!');

    // Command: Generate Graph (Markdown)
    let generateGraphDisposable = vscode.commands.registerCommand('neo.generateGraph', async () => {
        await runAnalysis(context, { markdown: true });
    });

    // Command: Show Graph (Visualization)
    let showGraphDisposable = vscode.commands.registerCommand('neo.showGraph', async () => {
        await runAnalysis(context, { visualize: true });
    });

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

interface AnalysisOptions {
    markdown?: boolean;
    visualize?: boolean;
}

async function runAnalysis(context: vscode.ExtensionContext, options: AnalysisOptions, silent: boolean = false) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        if (!silent) vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    let projectPath = workspaceFolders[0].uri.fsPath;
    let tsConfigPath = path.join(projectPath, 'tsconfig.json');
    let packageJsonPath = path.join(projectPath, 'package.json');
    
    // Attempt to find app directory
    let appDir = path.join(projectPath, 'app');
    if (!fs.existsSync(appDir)) {
        appDir = path.join(projectPath, 'src', 'app');
    }

    // Smart detection: If not at root, search for it
    if (!fs.existsSync(tsConfigPath)) {
        if (!silent) vscode.window.showInformationMessage('tsconfig.json not found at root. Searching workspace...');
        
        const tsconfigs = await vscode.workspace.findFiles('**/tsconfig.json', '**/node_modules/**');
        if (tsconfigs.length > 0) {
            // Prefer 'neo_client' or closest to root
            const preferred = tsconfigs.find(uri => uri.fsPath.includes('neo_client')) || tsconfigs[0];
            tsConfigPath = preferred.fsPath;
            projectPath = path.dirname(tsConfigPath); // Update project root
            packageJsonPath = path.join(projectPath, 'package.json');
            appDir = path.join(projectPath, 'app');
            
            if (!silent) vscode.window.showInformationMessage(`Found project at: ${vscode.workspace.asRelativePath(projectPath)}`);
        } else {
             if (!silent) vscode.window.showErrorMessage('No tsconfig.json found in workspace!');
             return;
        }
    }

    const run = async (progress?: vscode.Progress<{ message?: string }>) => {
        try {
            if (progress) progress.report({ message: "Analyzing project structure..." });
            
            const project = new Project({
                tsConfigFilePath: tsConfigPath,
            });

            // 1. Analyze Routes
            // appDir is already calculated above
            const routeAnalyzer = new RouteAnalyzer(project, appDir);
            const routes = routeAnalyzer.analyze();
            
            // 2. Analyze Components
            if (progress) progress.report({ message: "Scanning components..." });
            const componentAnalyzer = new ComponentAnalyzer(project);
            const sourceFiles = project.getSourceFiles().filter(sf => {
                const filePath = sf.getFilePath();
                return !filePath.includes('node_modules') && !filePath.includes('.next');
            });
            
            const components = sourceFiles.flatMap(sf => componentAnalyzer.analyzeFile(sf));

            // 3. Analyze Dependencies
            let libraries: LibraryInfo[] = [];
            if (fs.existsSync(packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                libraries = Object.entries(deps).map(([name, version]) => ({
                    name,
                    version: version as string,
                    role: 'dependency'
                }));
            }

            // 4. Construct Graph
            const graph: CodebaseGraph = {
                metadata: {
                    name: 'neo_client',
                    framework: 'nextjs',
                    router: 'app',
                    language: 'ts',
                    directories: []
                },
                routes,
                components,
                hooks: [],
                libraries
            };

            if (options.markdown) {
                // 5. Serialize
                if (progress) progress.report({ message: "Generating Markdown..." });
                const serializer = new MarkdownSerializer();
                const output = serializer.serialize(graph);

                // 6. Write to file and open
                const outputPath = path.join(projectPath, 'codebase_graph.md');
                fs.writeFileSync(outputPath, output);

                if (!silent) {
                    const doc = await vscode.workspace.openTextDocument(outputPath);
                    await vscode.window.showTextDocument(doc);
                    vscode.window.showInformationMessage(`Architecture Map generated!`);
                }
            } 
            
            if (options.visualize) {
                // 5. Visualize
                if (progress) progress.report({ message: "Rendering Graph..." });
                GraphVisualizer.createOrShow(context.extensionUri, graph);
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

export function deactivate() {}
