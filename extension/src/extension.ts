import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { generateGraph } from './core/Generate';
import { appMode, formatProjectCandidates, missingProject, selectProject, type ProjectSelection } from './core/FindProject';
import { AGENT_FILES, CURSOR_EXTENSION_RULE, CURSOR_SETUP_RULE, hasActiveCursorRule, updateAgentFiles } from './core/AgentInstructions';
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
            const selection = connect ? selectProject(root) : undefined;
            await configureAgents(root, selection, connect, context);
            if (selection) showProjectGuess(root, selection);
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
        if (['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(doc.languageId) ||
            ['tsconfig.json', 'jsconfig.json', 'package.json'].includes(path.basename(doc.fileName))) {
            debouncedUpdate();
        }
    }));

    context.subscriptions.push(generateGraphDisposable);
    context.subscriptions.push(showGraphDisposable);
}

function showProjectGuess(root: string, { directory, guessCandidates, searchLimited, developmentPackages }: ProjectSelection) {
    if (!guessCandidates) return;
    const local = (candidate: string) => path.relative(root, candidate) || '.';
    const candidates = guessCandidates.length > 1 ? ` Candidates: ${formatProjectCandidates(guessCandidates.map(local))}.` : '';
    const development = developmentPackages ? ` Other packages with only a development dependency on Next: ${developmentPackages}.` : '';
    const limitNote = searchLimited ? ' Directory scan limit reached.' : '';
    vscode.window.setStatusBarMessage(`Neorion guessed ${JSON.stringify(local(directory))}.${candidates}${development}${limitNote}`, 15_000);
}

async function configureAgents(root: string, selection: ProjectSelection | undefined, connect: boolean, context: vscode.ExtensionContext) {
    try {
        const project = selection?.directory ?? root;
        const discover = !!(selection?.guessCandidates || selection?.apps && selection.apps.length > 1);
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
            if (format) await vscode.env.clipboard.writeText(mcpSnippet(format as typeof formats[number],
                discover ? root : project, bundleSource, discover));
        }
        const instructions = selected.filter(label => AGENT_FILES.includes(label) &&
            (!connect || label !== CURSOR_EXTENSION_RULE || !hasActiveCursorRule(root, CURSOR_SETUP_RULE)));
        const configFiles = (connect ? mcpTargets : Object.keys(MCP_TARGETS) as McpTarget[])
            .map(target => MCP_TARGETS[target].file);
        const selectedPaths = new Set([...instructions, ...configFiles].map(file => path.join(root, file)));
        const dirty = vscode.workspace.textDocuments?.find(doc => doc.isDirty && selectedPaths.has(doc.uri.fsPath));
        if (dirty) throw new Error(`Save ${vscode.workspace.asRelativePath(dirty.uri)} before updating AI tools`);
        const mcp = planMcp(root, discover ? root : project, mcpTargets, bundled, bundleSource, connect, { discover });
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
    const selection = selectProject(workspaceRoot);
    if (!selection) {
        if (!silent) vscode.window.showErrorMessage(missingProject(workspaceRoot));
        return;
    }
    const mode = appMode(selection);
    if (mode === 'list') {
        if (!silent) vscode.window.showInformationMessage(`Next.js apps: ${selection.apps!.map(app => app.id).join(', ')}. Open an app folder to generate its map.`);
        return;
    }
    const projectPath = selection.directory;
    const run = async (progress?: vscode.Progress<{ message?: string }>) => {
        try {
            const { graph, outputPath } = generateGraph(projectPath, {
                markdown: options.markdown,
                migrateLegacy: true,
                onProgress: message => progress?.report({ message })
            });
            if (options.markdown && mode === 'all') {
                for (const app of selection.apps!) {
                    if (app.directory !== projectPath) generateGraph(app.directory, {
                        markdown: true, migrateLegacy: true, onProgress: message => progress?.report({ message: `${app.id}: ${message}` })
                    });
                }
            }
            if (outputPath) {
                const promptKey = 'neo.agentPromptShown:' + projectPath;
                if (context.workspaceState && !context.workspaceState.get(promptKey)) {
                    const saved = context.workspaceState.update(promptKey, true);
                    void Promise.resolve(saved).then(async () => {
                        const answer = await vscode.window.showInformationMessage(
                            'Connect AI tools to the Neorion architecture map?', 'Yes');
                        if (answer === 'Yes') await configureAgents(workspaceRoot, selection, true, context);
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
    showProjectGuess(workspaceRoot, selection);
}

export function deactivate() {}
