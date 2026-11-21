import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findProject, generateGraph } from './core/Generate';
import { AGENT_FILES, updateAgentFiles } from './core/AgentInstructions';
import { COPY_MCP, MCP_TARGETS, REGISTER_MCP, mcpSnippet, planMcp, type McpTarget } from './core/McpRegistration';
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
            await configureAgents(root, connect ? findProject(root) ?? root : root, connect, context);
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

async function configureAgents(root: string, project: string, connect: boolean, context: vscode.ExtensionContext) {
    try {
        const choices = connect ? await vscode.window.showQuickPick([
            ...AGENT_FILES.map(label => ({ label, picked: fs.existsSync(path.join(root, label)) })),
            { label: REGISTER_MCP, picked: false },
            { label: COPY_MCP, picked: false }
        ], { canPickMany: true, placeHolder: 'Choose AI instruction files and optional MCP registration' }) :
            AGENT_FILES.map(label => ({ label }));
        if (!choices?.length) return;
        const selected = choices.map(choice => choice.label);
        let mcpTargets: McpTarget[] = [];
        let bundled = false;
        const bundleSource = path.resolve(context.extensionPath ?? path.dirname(__dirname), 'out/mcp.cjs');
        if (selected.includes(REGISTER_MCP)) {
            const targets = await vscode.window.showQuickPick(Object.entries(MCP_TARGETS).map(([label, target]) => ({
                label, description: target.file
            })), { canPickMany: true, placeHolder: 'Choose AI tools for workspace MCP registration' });
            if (targets === undefined) return;
            mcpTargets = targets.map(target => target.label as McpTarget);
            if (mcpTargets.length) {
                const mode = await vscode.window.showQuickPick(['Use bundled server', 'Use pinned npm package (requires publishing)'], {
                    placeHolder: 'Choose how to launch the Neorion MCP server'
                });
                if (!mode) return;
                bundled = mode === 'Use bundled server';
            }
        }
        if (selected.includes(COPY_MCP)) {
            const formats = ['Codex CLI', 'Windsurf', 'Gemini CLI'] as const;
            const format = await vscode.window.showQuickPick([...formats], { placeHolder: 'Choose a global MCP config format' });
            if (format) await vscode.env.clipboard.writeText(mcpSnippet(format as typeof formats[number], project, bundleSource));
        }
        const instructions = selected.filter(label => AGENT_FILES.includes(label));
        const configFiles = (connect ? mcpTargets : Object.keys(MCP_TARGETS) as McpTarget[])
            .map(target => MCP_TARGETS[target].file);
        const selectedPaths = new Set([...instructions, ...configFiles].map(file => path.join(root, file)));
        const dirty = vscode.workspace.textDocuments?.find(doc => doc.isDirty && selectedPaths.has(doc.uri.fsPath));
        if (dirty) throw new Error(`Save ${vscode.workspace.asRelativePath(dirty.uri)} before updating AI tools`);
        const mcp = planMcp(root, project, mcpTargets, bundled,
            bundleSource, connect);
        const count = updateAgentFiles(root, project, instructions, connect, mcp.configured);
        mcp.commit();
        const approval = mcpTargets.includes('Claude Code') ?
            ' Claude Code asks for approval before using a project MCP server for the first time.' : '';
        const registration = mcp.count ? ` Updated MCP registration for ${mcp.count} tool(s).` : '';
        vscode.window.showInformationMessage(`Neorion updated ${count} AI instruction file(s).${registration}${approval}`);
    } catch (error) {
        vscode.window.showErrorMessage(`Could not update AI tools: ${error}`);
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
    const projectPath = findProject(workspaceRoot);
    if (!projectPath) {
        if (!silent) vscode.window.showErrorMessage('No tsconfig.json found in workspace!');
        return;
    }
    const run = async (progress?: vscode.Progress<{ message?: string }>) => {
        try {
            const { graph, outputPath } = generateGraph(projectPath, {
                markdown: options.markdown,
                migrateLegacy: true,
                onProgress: message => progress?.report({ message })
            });
            if (outputPath) {
                const promptKey = 'neo.agentPromptShown:' + projectPath;
                if (context.workspaceState && !context.workspaceState.get(promptKey)) {
                    const saved = context.workspaceState.update(promptKey, true);
                    void Promise.resolve(saved).then(async () => {
                        const answer = await vscode.window.showInformationMessage(
                            'Connect AI tools to the Neorion architecture map?', 'Yes');
                        if (answer === 'Yes') await configureAgents(workspaceRoot, projectPath, true, context);
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

export function deactivate() {}
