import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { CodebaseGraph } from '../types/GraphTypes';
import { DomainExtractor } from '../utils/DomainExtractor';

export class GraphVisualizer {
    public static currentPanel: GraphVisualizer | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private projectRoot: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'openFile':
                        this.openFile(message.path);
                        return;
                    case 'copyQuery':
                        if (typeof message.text === 'string') {
                            void vscode.env.clipboard.writeText(message.text).then(
                                () => this._panel.webview.postMessage({ command: 'queryCopied', text: message.text }),
                                () => vscode.window.showErrorMessage('Failed to copy the Neorion query.')
                            );
                        }
                        return;
                    case 'error':
                        vscode.window.showErrorMessage(`Graph Error: ${message.text}`);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private async openFile(filePath: string) {
        try {
            const fullPath = path.resolve(this.projectRoot, filePath);
            const relative = path.relative(this.projectRoot, fullPath);
            if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
        }
    }

    public static createOrShow(extensionUri: vscode.Uri, graph: CodebaseGraph, projectRoot: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (GraphVisualizer.currentPanel) {
            GraphVisualizer.currentPanel._panel.reveal(column);
            GraphVisualizer.currentPanel.projectRoot = projectRoot;
            GraphVisualizer.currentPanel.update(graph);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'neoArchGraph',
            'Neo Architecture Graph',
            column || vscode.ViewColumn.One,
            {
                // Enable javascript in the webview
                enableScripts: true,

                // And restrict the webview to only loading content from our extension's `media` directory.
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        GraphVisualizer.currentPanel = new GraphVisualizer(panel, extensionUri, projectRoot);
        GraphVisualizer.currentPanel.update(graph);
    }

    public dispose() {
        GraphVisualizer.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private update(graph: CodebaseGraph) {
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, graph);
    }

    private _getHtmlForWebview(webview: vscode.Webview, graph: CodebaseGraph) {
        const truncateLabel = (label: string) => {
            const characters = Array.from(label);
            return characters.length > 28 ? characters.slice(0, 27).join('') + '…' : label;
        };

        const query = (kind: string, target: string) => {
            const argument = /^[a-zA-Z0-9_./-]+$/.test(target) && !target.startsWith('-')
                ? target : "'" + target.replace(/'/g, "'\\''") + "'";
            return `neorion query ${kind} ${argument}`;
        };
        const layouts = graph.routes.filter(route => route.type === 'layout' || route.type === 'template');
        const wrapperRoots = new Map<string, string[]>();
        for (const layout of layouts) {
            for (const page of layout.wraps ?? []) {
                const roots = wrapperRoots.get(page) ?? [];
                roots.push(`file:${layout.file}`);
                if (layout.componentId) roots.push(layout.componentId);
                wrapperRoots.set(page, roots);
            }
        }
        const pagesApps = new Map(graph.pagesApps?.map(app => [app.file, app]));
        const renderRoots = graph.routes.filter(route => route.type === 'page').map(route => {
            const pagesDirectory = /^(?:src\/)?pages\//.exec(route.file)?.[0];
            const app = pagesDirectory && ['tsx', 'ts', 'jsx', 'js']
                .map(ext => pagesApps.get(`${pagesDirectory}_app.${ext}`)).find(Boolean);
            const wraps = app ? [`file:${app.file}`, app.componentId] : wrapperRoots.get(route.id) ?? [];
            return { id: route.id, roots: [`file:${route.file}`, route.componentId, ...wraps].filter(Boolean) };
        });
        const layoutDepth = new Map(layouts.map(layout => {
            const directory = path.posix.dirname(layout.file);
            const depth = layouts.filter(outer => directory.startsWith(path.posix.dirname(outer.file) + '/')).length;
            return [layout.id, depth];
        }));
        const pageLevel = Math.max(0, ...layoutDepth.values()) + 1;
        const componentLevel = pageLevel + 1;

        const routeNodes = graph.routes.map(r => {
            const label = r.type === 'layout' ? `layout ${r.scope ?? r.path}`
                : ['loading', 'error', 'not-found', 'template', 'default', 'global-error'].includes(r.type) ? `${r.type} ${r.path}`
                : r.methods?.length ? `${r.methods.join(", ").replace(/^ALL$/, "*")} ${r.path}` : r.path;
            return {
                id: r.id,
                kind: r.type === 'layout' || r.type === 'template' ? 'layout' : 'route',
                level: layoutDepth.get(r.id) ?? pageLevel,
                routeType: r.type,
                componentId: r.componentId,
                query: r.type === 'page' ? query('wrappers', r.path)
                    : r.type === 'api' ? query('api_consumers', r.path) : query('search', r.file),
                label,
                group: r.domain || 'other',
                title: [`Route: ${label}`, `File: ${r.file}`, `Domain: ${r.domain}`,
                    ...(r.methods?.includes('ALL') ? ['HTTP methods undetermined'] : []),
                    ...(r.wraps?.length ? ['Wraps:', ...r.wraps.map(id => id.slice('route:'.length))] : [])
                ].join('\n'),
                shape: 'square',
                path: r.file
            };
        });

        const componentNodes = graph.components.map(c => ({ 
            id: c.id,
            kind: 'component',
            level: componentLevel,
            query: query('who_renders', c.path + '#' + c.name),
            label: c.name, 
            group: c.domain || 'other', 
            title: `Component: ${c.name}\nPath: ${c.path}\nDomain: ${c.domain}\n\n${c.description ? '📝 ' + c.description : ''}`,
            shape: 'dot',
            path: c.path 
        }));

        const actionNodes = graph.actions.map(id => {
            const separator = id.lastIndexOf('#');
            const file = id.slice('action:'.length, separator);
            const label = id.slice(separator + 1);
            return {
                id, label, kind: 'action', level: componentLevel + 1, path: file, group: DomainExtractor.extract('/' + file),
                query: query('api_consumers', file + '#' + label),
                title: `Server action: ${label}\nPath: ${file}`, shape: 'square'
            };
        });
        const callerNodes = [...new Set(graph.edges.map(edge => edge.from).filter(id => id.startsWith('file:')))]
            .map(id => {
                const file = id.slice('file:'.length);
                return {
                    id, kind: 'file', level: componentLevel, label: path.posix.basename(file), path: file,
                    group: DomainExtractor.extract('/' + file), query: query('search', file), title: `Server action caller: ${file}`, shape: 'square'
                };
            });
        const rawNodes = [...routeNodes, ...componentNodes, ...actionNodes, ...callerNodes];
        const nodes = Array.from(new Map(rawNodes.map(item => [item.id, item])).values());
        const domains = Array.from(new Set(nodes.map(n => n.group))).sort();
        
        const hubNodes = domains.map(d => ({
            id: `hub_${d}`,
            level: componentLevel,
            label: '',
            group: d,
            shape: 'dot',
            size: 0, opacity: 0, 
            mass: 1, 
            fixed: false, // RELEASED: Allow hubs to float and find natural balance
            title: '', path: ''
        }));
        const nodeDomainMap = new Map(nodes.map(node => [node.id, node.group]));
        const codeEdges = [
            ...graph.routes.flatMap(route => route.componentId ? [{
                from: route.id, to: route.componentId, type: 'renders'
            }] : []),
            ...layouts.flatMap(layout => (layout.wraps ?? []).map(page => ({
                from: layout.id, to: page, type: 'wraps'
            }))),
            ...graph.edges
        ].filter(edge => nodeDomainMap.has(edge.from) && nodeDomainMap.has(edge.to));

        // Dense mid-size graphs can be harder to read than sparse graphs with more nodes.
        const denseGraph = nodes.length > 100 || (nodes.length >= 64 && codeEdges.length >= 2 * nodes.length);
        const componentCounts = new Map<string, number>();
        if (denseGraph) {
            for (const node of nodes) {
                if (node.kind === 'component') {
                    componentCounts.set(node.group, (componentCounts.get(node.group) ?? 0) + 1);
                }
            }
        }
        const clusterGroups = [...componentCounts];
        const hasClusters = clusterGroups.length > 0;
        const getEdgeLength = (from: string, to: string) => nodeDomainMap.get(from) === nodeDomainMap.get(to)
            ? (hasClusters ? 160 : 50) : (hasClusters ? 500 : 400);

        const neighbors = new Map(nodes.map(node => [node.id, new Set<string>()]));
        for (const { from, to } of codeEdges) {
            if (from !== to && neighbors.has(from) && neighbors.has(to)) {
                neighbors.get(from)?.add(to);
                neighbors.get(to)?.add(from);
            }
        }
        const edges = [
            ...codeEdges.map((edge, index) => ({
                ...edge, id: 'edge:' + index, title: edge.type, arrows: 'to', length: getEdgeLength(edge.from, edge.to)
            })),
            ...nodes.map((node, index) => ({
                id: `hub-edge:${index}`,
                from: node.id, to: `hub_${node.group}`, color: { opacity: 0 },
                length: hasClusters ? 220 : 100, smooth: false, width: 0
            }))
        ];

        const groupsConfig = domains.reduce((acc, domain, index) => {
            acc[domain] = DomainExtractor.getColor(domain, index);
            return acc;
        }, Object.create(null) as Record<string, string>);

        const displayNodes = nodes.map(node => {
            const degree = neighbors.get(node.id)?.size ?? 0;
            const base = node.kind === 'component' ? 8 : 12;
            return {
                ...node,
                fullLabel: node.label,
                shortLabel: truncateLabel(node.label),
                label: '',
                size: Math.min(base + 14, base + Math.sqrt(degree) * 3.2)
            };
        });
        const graphPayload = {
            nodes: [...displayNodes, ...hubNodes], edges, groupsConfig, domains, clusterGroups,
            counts: { routes: graph.routes.length, components: graph.components.length, actions: graph.actions.length,
                edges: codeEdges.length },
            neighbors: Array.from(neighbors, ([id, adjacent]) => [id, [...adjacent]]),
            renderRoots,
            renderEdges: graph.edges.filter(edge => edge.type === 'renders').map(({ from, to }) => [from, to])
        };
        const safeGraphData = Buffer.from(JSON.stringify(graphPayload), 'utf8').toString('base64');
        const nonce = randomBytes(16).toString('base64');

        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vis-network.min.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Neo Architecture Graph</title>
    <script type="text/javascript" src="${scriptUri}"></script>
    <style>
        body {
            --bg-color: var(--vscode-editor-background, #1e1e1e);
            --fg-color: var(--vscode-editor-foreground, #ccc);
            --border-color: var(--vscode-panel-border, #444);
        }
        body { margin: 0; padding: 0; width: 100%; height: 100vh; background-color: var(--bg-color); color: var(--fg-color); overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        body { display: flex; flex-direction: column; }
        #mynetwork { flex: 1; min-width: 0; min-height: 0; }
        #top-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border-color); }
        #search-controls { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        #search-input { box-sizing: border-box; width: min(220px, 55vw); padding: 6px 8px; font: inherit; background: var(--vscode-input-background, var(--bg-color)); color: var(--vscode-input-foreground, var(--fg-color)); border: 1px solid var(--vscode-input-border, var(--border-color)); border-radius: 4px; }
        #search-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--fg-color)); }
        :is(button, input):focus-visible { outline: 2px solid var(--vscode-focusBorder, #007acc); outline-offset: 1px; }
        #graph-area { position: relative; display: flex; flex: 1; min-height: 0; }
        #hop-levels { margin-top: 10px; }
        div.vis-tooltip { background-color: var(--bg-color); color: var(--fg-color); border-color: var(--border-color); box-shadow: none; font: 12px system-ui; pointer-events: none; }
        #graph-footer { display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: space-between; padding: 5px 10px; border-top: 1px solid var(--border-color); font-size: 12px; }
        #stats { font-variant-numeric: tabular-nums; }
        #details { flex: 0 0 min(300px, 36%); min-width: 0; box-sizing: border-box; padding: 14px; overflow: auto; background: var(--vscode-sideBar-background, var(--bg-color)); color: var(--vscode-sideBar-foreground, var(--fg-color)); border-left: 1px solid var(--border-color); z-index: 1001; font-size: 13px; overflow-wrap: anywhere; }
        #details header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        #details h2 { margin: 0; font-size: 16px; }
        #details h3 { margin: 16px 0 4px; font-size: 13px; }
        #details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; }
        #details dd { margin: 0; }
        #details :is(ul, ol) { padding-left: 20px; margin: 0; }
        .passport-counts { padding-block: 9px; margin: 14px 0 0; border-block: 1px solid var(--border-color); }
        .query-command { width: 100%; box-sizing: border-box; margin: 4px 0 7px; padding: 6px; color: var(--fg-color); background: var(--bg-color); border: 1px solid var(--border-color); font: 12px var(--vscode-editor-font-family, monospace); }
        #copy-status { margin-left: 6px; }
        .connection { text-align: left; padding: 3px 0; border: 0; background: transparent; color: var(--vscode-textLink-foreground, var(--fg-color)); font: inherit; overflow-wrap: anywhere; cursor: pointer; }
        .connection:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--fg-color)); }
        .legend { flex: 0 0 min(180px, 28%); min-width: 0; box-sizing: border-box; background: var(--vscode-sideBar-background, var(--bg-color)); overflow: auto; padding: 10px; border-right: 1px solid var(--border-color); }
        .legend-heading { margin: 2px 0 7px; font-size: 12px; font-weight: 600; }
        .legend-heading-row { display: flex; align-items: baseline; gap: 4px; justify-content: space-between; }
        .legend-tools { display: flex; gap: 4px; }
        .legend-action { border: 0; background: transparent; color: var(--vscode-textLink-foreground, var(--fg-color)); padding: 0; font: inherit; cursor: pointer; }
        .legend-action:hover { text-decoration: underline; }
        .legend-divider { border-top: 1px solid var(--border-color); margin: 10px 0 6px; padding-top: 8px; }
        .legend-item { display: flex; align-items: center; min-height: 26px; gap: 6px; font-size: 12px; }
        .legend-item:hover { background: var(--vscode-list-hoverBackground, var(--border-color)); }
        .legend-item input { margin: 0 1px 0 0; flex: none; accent-color: var(--vscode-focusBorder, #007acc); cursor: pointer; }
        .legend-label { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; padding: 2px 0; text-align: left; background: transparent; border: 0; color: inherit; font: inherit; overflow-wrap: anywhere; cursor: pointer; }
        .legend-label[aria-pressed="true"] { font-weight: 700; }
        .legend-count { margin-left: auto; font-variant-numeric: tabular-nums; }
        .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; }
        .shape-key { border-top: 1px solid var(--border-color); margin-top: 6px; padding: 6px 4px 0; font-size: 12px; }
        .shape-key-title { font-weight: 600; margin-bottom: 4px; }
        .shape-key-item { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
        .shape-icon { box-sizing: border-box; width: 14px; height: 10px; border: 1px solid currentColor; }
        .shape-icon.ellipse { border-radius: 50%; }
        
        #controls { display: flex; flex-wrap: wrap; gap: 8px; }
        .btn { background: var(--vscode-button-secondaryBackground, var(--bg-color)); color: var(--vscode-button-secondaryForeground, var(--fg-color)); border: 1px solid var(--vscode-button-border, var(--border-color)); padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; transition: background 0.2s; }
        .segments { display: inline-flex; }
        .segments .btn { border-radius: 0; padding-inline: 9px; }
        .segments .btn:first-child { border-radius: 4px 0 0 4px; }
        .segments .btn:last-child { border-radius: 0 4px 4px 0; }
        .segments .btn + .btn { margin-left: -1px; }
        .segments .btn[aria-pressed="true"] { box-shadow: inset 0 -2px var(--vscode-focusBorder, #007acc); font-weight: 600; }
        .btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--border-color)); }
        
        #error-overlay { display: none; position: absolute; inset: 0; background: var(--bg-color); z-index: 2000; align-items: center; justify-content: center; flex-direction: column; }
        #error-content { background: var(--vscode-inputValidation-errorBackground, var(--bg-color)); padding: 20px; border-radius: 8px; max-width: 80%; border: 1px solid currentColor; color: var(--vscode-errorForeground, var(--fg-color)); }
        #debug-log { position: absolute; bottom: 0; left: 0; width: 100%; max-height: 150px; background: var(--bg-color); color: var(--fg-color); font-family: monospace; font-size: 10px; overflow-y: auto; display: none; padding: 5px; }
    </style>
</head>
<body>
    <div id="top-bar">
        <div id="search-controls" role="search">
            <input id="search-input" type="search" aria-label="Search nodes" placeholder="Search nodes">
            <span id="search-count" role="status"></span>
        </div>
        <div id="controls">
            <div id="graph-mode" class="segments" role="group" aria-label="Graph layout">
                <button id="mode-graph" class="btn" aria-pressed="true">Graph</button>
                <button id="mode-routes" class="btn" aria-pressed="false">Routes</button>
            </div>
            <div id="label-levels" class="segments" role="group" aria-label="Label detail">
                <button class="btn" data-level="Map" aria-pressed="false">Map</button>
                <button class="btn" data-level="Read" aria-pressed="false">Read</button>
                <button class="btn" data-level="Full" aria-pressed="false">Full</button>
            </div>
            <button id="btn-physics" class="btn">Pause layout</button>
            <button id="btn-clusters" class="btn" hidden>Expand all</button>
            <button id="btn-fit" class="btn">Fit Graph</button>
        </div>
    </div>
    <div id="graph-area">
        <aside class="legend" aria-label="Graph legend">
            <div class="legend-heading-row">
                <h2 class="legend-heading">Domains</h2>
                <div class="legend-tools">
                    <button id="domains-all" class="legend-action">All</button>
                    <button id="domains-none" class="legend-action">None</button>
                </div>
            </div>
            <div id="legend"></div>
            <h2 class="legend-heading legend-divider">Edge types</h2>
            <div id="edge-legend"></div>
            <div class="shape-key">
                <div class="shape-key-title">Node shapes</div>
                <div class="shape-key-item"><span class="shape-icon" aria-hidden="true"></span>Route / action</div>
                <div class="shape-key-item"><span class="shape-icon ellipse" aria-hidden="true"></span>Component</div>
            </div>
        </aside>
        <div id="mynetwork"></div>
        <aside id="details" aria-labelledby="details-label" hidden>
            <header>
                <h2 id="details-label"></h2>
                <button id="details-close" class="btn" aria-label="Close details">×</button>
            </header>
            <dl>
                <dt>Kind</dt><dd id="details-kind"></dd>
                <dt>File path</dt><dd id="details-path"></dd>
                <dt>Domain</dt><dd id="details-domain"></dd>
            </dl>
            <button id="details-open" class="btn">Open file</button>
            <p class="passport-counts"><span id="upstream"></span> upstream · <span id="downstream"></span> downstream</p>
            <div id="hop-levels" class="segments" role="group" aria-label="Neighborhood depth" title="Click the active depth to return to the query answer">
                <button class="btn" data-hops="1" aria-pressed="false">1 hop</button>
                <button class="btn" data-hops="2" aria-pressed="false">2 hops</button>
                <button class="btn" data-hops="3" aria-pressed="false">3 hops</button>
            </div>
            <section id="wrapper-section" hidden>
                <h3>Wrapped by (outer → inner)</h3>
                <ol id="details-wrappers"></ol>
            </section>
            <section id="render-section" hidden>
                <h3 id="render-heading"></h3>
                <ul id="details-pages"></ul>
            </section>
            <section id="callers-section" hidden>
                <h3 id="callers-heading"></h3>
                <ul id="details-callers"></ul>
            </section>
            <h3><label for="details-query">Neorion query</label></h3>
            <input id="details-query" class="query-command" type="text" readonly>
            <button id="copy-query" class="btn">Copy query</button><span id="copy-status" role="status"></span>
        </aside>
    </div>

    <footer id="graph-footer">
        <span id="hint">Click a node for details, double-click to open file</span>
        <span id="stats"></span>
    </footer>

    <div id="error-overlay">
        <div id="error-content">
            <h3 style="margin-top: 0">Rendering Failed</h3>
            <p id="error-message">Unknown error</p>
            <button id="btn-logs" class="btn">Show Logs</button>
        </div>
    </div>
    <div id="debug-log"></div>
    
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let physicsEnabled = true;
        let routesMode = false;
        let visibleDomains;
        let searchMatches = null;
        let focusIds = null;
        let hopNodes = null;
        let domainFocus;


        function log(msg) {
            console.log(msg);
            const logDiv = document.getElementById('debug-log');
            if (logDiv) {
                const line = document.createElement('div');
                line.textContent = '>' + msg;
                logDiv.appendChild(line);
                logDiv.scrollTop = logDiv.scrollHeight;
            }
        }
        
        function showError(msg) {
            document.getElementById('error-overlay').style.display = 'flex';
            document.getElementById('error-message').textContent = msg;
            vscode.postMessage({ command: 'error', text: msg });
        }

        function setPhysicsEnabled(enabled) {
            physicsEnabled = enabled;
            network.setOptions({ physics: { enabled: physicsEnabled } });
            const btn = document.getElementById('btn-physics');
            btn.textContent = physicsEnabled ? 'Pause layout' : 'Layout paused (click to resume)';
            btn.title = physicsEnabled ? 'Click to pause layout' : 'Click to re-run layout';
        }

        function isInsideCluster(id) {
            return network.findNode(id).length > 1;
        }

        function isCollapsed(id) {
            // Expanded clusters are absent, and vis logs an error if isCluster receives an absent ID.
            return network.findNode(id).length > 0;
        }

        function nodeOpacity(id) {
            if (hopNodes || focusIds) return (hopNodes || focusIds).has(id) ? 1 : 0.15;
            return !searchMatches || searchMatches.has(id) ? 1 : 0.18;
        }

        function clusterOpacity(cluster) {
            if (hopNodes || focusIds) return cluster.componentIds.some(id => (hopNodes || focusIds).has(id)) ? 1 : 0.15;
            return !searchMatches || cluster.componentIds.some(id => searchMatches.has(id)) ? 1 : 0.18;
        }

        function withoutRedraw(update) {
            // Vis emits synchronous redraws for DataSet and cluster changes while physics is paused.
            const { emitter } = network.body;
            const wasDrawing = network.renderer.allowRedraw;
            if (wasDrawing) emitter.emit('_blockRedraw');
            try {
                update();
            } finally {
                if (wasDrawing) emitter.emit('_allowRedraw');
            }
        }

        function updateNodeOpacity() {
            const updates = network.body.data.nodes.get()
                .filter(node => node.kind && !isInsideCluster(node.id))
                .map(node => ({ id: node.id, opacity: nodeOpacity(node.id) }));
            withoutRedraw(() => {
                network.body.data.nodes.update(updates);
                for (const cluster of componentClusters) {
                    if (isCollapsed(cluster.id)) {
                        network.body.nodes[cluster.id].setOptions({ opacity: clusterOpacity(cluster) });
                    }
                }
            });
            network.redraw();
        }

        function collapseGroups(clusters) {
            if (!clusters.length) return;
            withoutRedraw(() => {
                // Remove tethers before clustering so vis never redirects them to a bubble.
                network.body.data.edges.remove(clusters.flatMap(cluster => cluster.hubEdges.map(edge => edge.id)));
                for (const cluster of clusters) {
                    const { id, domain } = cluster;
                    network.cluster({
                        joinCondition: node => node.group === domain && node.kind === 'component',
                        clusterNodeProperties: {
                            id, group: domain,
                            label: '', shape: 'dot', size: cluster.size, mass: 12, allowSingleNodeCluster: true,
                            level: cluster.level, hidden: !visibleDomains.has(domain),
                            opacity: clusterOpacity(cluster)
                        }
                    }, false);
                }
                network.body.emitter.emit('_dataChanged');
            });
        }

        function expandGroups(clusters) {
            if (!clusters.length) return;
            withoutRedraw(() => {
                for (const { id } of clusters) {
                    network.openCluster(id, {
                        // Give members distinct positions even when layout is paused.
                        releaseFunction: (center, positions) => Object.fromEntries(
                            Object.keys(positions).sort().map((nodeId, index) => {
                                const angle = index * Math.PI * (3 - Math.sqrt(5));
                                const radius = 41 * Math.sqrt(index);
                                return [nodeId, { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }];
                            })
                        )
                    }, false);
                }
                // Adding the tethers also refreshes vis's visible indices.
                network.body.data.edges.add(clusters.flatMap(cluster => cluster.hubEdges.map(edge => ({ ...edge, hidden: routesMode }))));
            });
        }

        function updateClusterButton(button) {
            button.textContent = domainFocus ? 'Exit domain focus'
                : componentClusters.some(({ id }) => isCollapsed(id)) ? 'Expand all' : 'Collapse groups';
        }

        function withTextTooltip(item) {
            if (!item.title) return item;
            const tooltip = document.createElement('div');
            tooltip.style.whiteSpace = 'pre-wrap';
            tooltip.textContent = item.title;
            return { ...item, title: tooltip };
        }

        function readTheme(groupsConfig) {
            const styles = getComputedStyle(document.body);
            const { color: foreground, backgroundColor: background } = styles;
            const swatch = document.createElement('canvas');
            swatch.width = swatch.height = 1;
            const colorContext = swatch.getContext('2d', { willReadFrequently: true });
            const rgb = color => {
                colorContext.clearRect(0, 0, 1, 1);
                colorContext.fillStyle = color;
                colorContext.fillRect(0, 0, 1, 1);
                return Array.from(colorContext.getImageData(0, 0, 1, 1).data.slice(0, 3));
            };
            const hex = channels => '#' + channels.map(value => value.toString(16).padStart(2, '0')).join('');
            const luminance = channels => channels.reduce((sum, channel, index) => {
                const value = channel / 255;
                const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                return sum + linear * [0.2126, 0.7152, 0.0722][index];
            }, 0);
            const surfaceRGB = rgb(background);
            const surface = luminance(surfaceRGB);
            const contrast = channels => {
                const fill = luminance(channels);
                return (Math.max(surface, fill) + 0.05) / (Math.min(surface, fill) + 0.05);
            };
            const groups = Object.create(null);
            const textColor = hex(rgb(foreground));
            for (const [domain, color] of Object.entries(groupsConfig)) {
                const original = rgb(color);
                const target = surface > 0.179 ? 0 : 255;
                let adjusted = original;
                for (let step = 1; contrast(adjusted) < 3 && step <= 20; step++) {
                    adjusted = original.map(value => Math.round(value + (target - value) * step / 20));
                }
                const fill = hex(adjusted);
                groups[domain] = { color: {
                    background: fill, border: fill, highlight: { background: fill, border: textColor },
                    hover: { background: fill, border: textColor }
                } };
            }
            const widget = styles.getPropertyValue('--vscode-editorWidget-border').trim();
            const neutral = rgb(styles.getPropertyValue('--vscode-foreground').trim() || foreground);
            const accent = styles.getPropertyValue('--vscode-textLink-foreground').trim()
                || styles.getPropertyValue('--vscode-focusBorder').trim() || foreground;
            const highContrast = document.body.matches('.vscode-high-contrast, .vscode-high-contrast-light');
            const renderOpacity = highContrast ? 1 : 0.92;
            const renderContrast = channels => contrast(channels.map(
                (value, index) => value * renderOpacity + surfaceRGB[index] * (1 - renderOpacity)));
            const border = widget ? rgb(widget) : neutral;
            const renderColor = [border, neutral, surface > 0.179 ? [0, 0, 0] : [255, 255, 255]]
                .find(channels => renderContrast(channels) >= 3);
            return {
                groups,
                font: { color: textColor, background: hex(surfaceRGB), bold: { color: textColor } },
                edge: { color: hex(renderColor), inherit: false, opacity: renderOpacity },
                accent: hex(rgb(accent))
            };
        }

        document.getElementById('btn-logs').addEventListener('click', () => {
            document.getElementById('debug-log').style.display = 'block';
        });

        let componentClusters = [];
        try {
            const rawData = "${safeGraphData}";
            const { nodes, edges, groupsConfig, domains, clusterGroups, neighbors, counts, renderRoots, renderEdges } = JSON.parse(
                new TextDecoder().decode(Uint8Array.from(atob(rawData), char => char.charCodeAt(0)))
            );

            const container = document.getElementById('mynetwork');
            let theme = readTheme(groupsConfig);
            const options = {
                layout: {
                    randomSeed: 42,
                    // Start physics from seeded positions and skip the clustering pre-pass.
                    improvedLayout: false
                },
                nodes: {
                    font: { size: 14, ...theme.font },
                    borderWidth: 2
                },
                groups: theme.groups,
                edges: {
                    color: theme.edge,
                    arrows: 'to',
                    width: 1.5,
                    smooth: { type: 'continuous', roundness: 0.5 }
                },
                physics: {
                    stabilization: {
                        enabled: true,
                        iterations: clusterGroups.length ? 4000 : 2000,
                        updateInterval: 50,
                        fit: false
                    },
                    solver: 'barnesHut', 
                    barnesHut: {
                        gravitationalConstant: clusterGroups.length ? -300000 : -40000,
                        centralGravity: clusterGroups.length ? 0.22 : 0.001,
                        springLength: clusterGroups.length ? 160 : 50,
                        springConstant: 0.04,
                        damping: 0.5,                  // High resistance (Stops self-movement)
                        avoidOverlap: 1
                    },
                    minVelocity: 0.75
                },
                interaction: { hover: true, tooltipDelay: 200, zoomView: true, selectConnectedEdges: false }
            };
            
            if (typeof vis === 'undefined') {
                showError('Error: vis library not loaded.');
            } else {
                window.network = new vis.Network(container, {
                    nodes: new vis.DataSet(nodes.map(withTextTooltip)),
                    edges: new vis.DataSet(edges.map(withTextTooltip))
                }, options);
                visibleDomains = new Set(domains);
                const graphColors = node => theme.groups[node.group].color;
                const graphNodes = new Map(nodes.filter(node => node.kind).map(node => [node.id, node]));
                const codeEdges = edges.filter(edge => edge.type);
                const edgeStyles = {
                    wraps: { width: 2.8, dashes: false },
                    renders: { width: 1.8, dashes: false },
                    imports: { width: 0.85, dashes: [5, 4] },
                    'uses-action': { width: 2, dashes: [1.5, 4] }
                };
                function edgeColor(edge) {
                    let { color, opacity } = theme.edge;
                    if (edge.type === 'wraps') {
                        color = graphColors(graphNodes.get(edge.from)).background;
                        opacity = 1;
                    } else if (edge.type === 'uses-action') {
                        color = theme.accent;
                        opacity = 1;
                    } else if (edge.type === 'imports') {
                        opacity *= 0.65;
                    }
                    const focused = hopNodes || !focusIds || (focusIds.has(edge.from) && focusIds.has(edge.to));
                    return { color, highlight: color, hover: color, inherit: false, opacity: opacity * (focused ? 1 : 0.15) };
                }
                function updateEdgeColors() {
                    const updates = codeEdges.map(edge => ({ id: edge.id, color: edgeColor(edge) }));
                    for (const update of updates) {
                        for (const id of network.getClusteredEdges(update.id)) {
                            if (id !== update.id) network.body.edges[id].setOptions({ color: update.color });
                        }
                    }
                    network.body.data.edges.update(updates);
                }
                updateEdgeColors();
                new MutationObserver(() => {
                    theme = readTheme(groupsConfig);
                    network.setOptions({ nodes: { font: theme.font }, groups: theme.groups, edges: { color: theme.edge } });
                    updateEdgeColors();
                    network.body.data.nodes.update(nodes.filter(node => node.kind).map(node => ({
                        id: node.id, color: graphColors(node)
                    })));
                    for (const cluster of componentClusters) {
                        if (isCollapsed(cluster.id)) network.updateClusteredNode(cluster.id, { color: graphColors({ group: cluster.domain }) });
                    }
                    for (const item of document.querySelectorAll('[data-domain]')) {
                        const color = graphColors({ group: item.dataset.domain });
                        const dot = item.querySelector('.dot');
                        dot.style.backgroundColor = color.background;
                    }
                    if (routesMode) fitGraph();
                    else network.redraw();
                }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
                const adjacency = new Map(neighbors);
                const connections = new Map(Array.from(graphNodes.keys(), id => [
                    id, { incoming: new Set(), outgoing: new Set() }
                ]));
                for (const { id, from, to } of edges) {
                    if (!id?.startsWith('hub-edge:') && connections.has(from) && connections.has(to)) {
                        connections.get(from).outgoing.add(to);
                        connections.get(to).incoming.add(from);
                    }
                }
                const components = nodes.filter(node => node.kind === 'component');
                const clusterButton = document.getElementById('btn-clusters');
                componentClusters = clusterGroups.map(([domain, count], index) => {
                    const componentIds = components.filter(node => node.group === domain).map(node => node.id);
                    const members = new Set(componentIds);
                    return {
                        id: 'component-cluster:' + index, domain, count, componentIds, level: components[0].level,
                        size: Math.min(52, 27 + Math.sqrt(count) * 2.5),
                        hubEdges: edges.filter(edge => edge.id?.startsWith('hub-edge:') && members.has(edge.from))
                    };
                });
                const layoutsByPage = new Map();
                const edgeById = new Map(codeEdges.map(edge => [edge.id, edge]));
                const incomingRenders = new Map();
                const pagesByRoot = new Map();
                for (const edge of codeEdges) {
                    if (edge.type !== 'wraps') continue;
                    const chain = layoutsByPage.get(edge.to) ?? [];
                    chain.push(edge);
                    layoutsByPage.set(edge.to, chain);
                }
                for (const chain of layoutsByPage.values()) {
                    chain.sort((a, b) => {
                        const first = graphNodes.get(a.from);
                        const second = graphNodes.get(b.from);
                        return first.level - second.level ||
                            Number(first.routeType === 'template') - Number(second.routeType === 'template');
                    });
                }
                for (const [from, to] of renderEdges) {
                    const parents = incomingRenders.get(to) ?? new Set();
                    parents.add(from);
                    incomingRenders.set(to, parents);
                }
                for (const { id, roots } of renderRoots) {
                    for (const root of roots) {
                        const pages = pagesByRoot.get(root) ?? new Set();
                        pages.add(id);
                        pagesByRoot.set(root, pages);
                    }
                }
                function renderedBy(symbol) {
                    const pages = new Set();
                    const visited = new Set([symbol]);
                    const pending = [symbol];
                    for (const current of pending) {
                        if (current !== symbol) {
                            for (const page of pagesByRoot.get(current) ?? []) pages.add(page);
                        }
                        for (const parent of incomingRenders.get(current) ?? []) {
                            if (visited.has(parent)) continue;
                            visited.add(parent);
                            pending.push(parent);
                        }
                    }
                    return [...pages].sort((a, b) => graphNodes.get(a).fullLabel.localeCompare(graphNodes.get(b).fullLabel));
                }

                let selectedId;
                let hopLimit;
                const temporarilyOpened = new Set();
                let rowNodes = new Set();
                let rowHeading;
                const unpinned = new Map();
                function placeNodes(positions) {
                    // Keep coordinates on the live vis nodes, including cluster bubbles.
                    // moveNode queues a simulation start and redraw for every coordinate pair.
                    for (const [id, { x, y }] of positions) {
                        const node = network.body.nodes[id];
                        if (!node) continue;
                        node.x = x;
                        node.y = y;
                    }
                }
                function restorePositions(keepInRow = new Set()) {
                    const positions = new Map();
                    for (const [id, point] of unpinned) {
                        if (keepInRow.has(id)) continue;
                        positions.set(id, point);
                        unpinned.delete(id);
                    }
                    placeNodes(positions);
                }
                let fitScale = 1;
                function visibleComponents() {
                    const visible = new Set(network.body.nodeIndices.filter(id => !id.startsWith('hub_')));
                    const links = new Map(Array.from(visible, id => [id, new Set()]));
                    for (const { from, to, type } of edges) {
                        if (!visibleEdgeTypes.has(type)) continue;
                        const [a] = network.findNode(from);
                        const [b] = network.findNode(to);
                        if (visible.has(a) && visible.has(b) && a !== b) {
                            links.get(a).add(b);
                            links.get(b).add(a);
                        }
                    }
                    const groups = [];
                    const visited = new Set();
                    for (const id of visible) {
                        if (visited.has(id)) continue;
                        const group = [id];
                        visited.add(id);
                        for (const member of group) {
                            for (const next of links.get(member)) {
                                if (visited.has(next)) continue;
                                visited.add(next);
                                group.push(next);
                            }
                        }
                        groups.push(group);
                    }
                    return groups.sort((a, b) => b.length - a.length);
                }

                function fitGraph() {
                    if (!container.clientWidth || !container.clientHeight) return;
                    const groups = visibleComponents();
                    if (!groups.length) {
                        restorePositions();
                        rowNodes.clear();
                        rowHeading = undefined;
                        network.redraw();
                        return;
                    }
                    const cutoff = Math.max(2, groups.flat().length / 10);
                    const fitAll = routesMode || domainFocus;
                    const main = fitAll ? groups.flat() : groups[0];
                    const small = fitAll ? [] : groups.slice(1).filter(group => group.length < cutoff);
                    rowNodes = new Set(small.flat());
                    restorePositions(rowNodes);
                    rowHeading = undefined;
                    if (routesMode) {
                        // The analyzed wrapper depth gives each node its column.
                        // Sort by source path so sibling routes are kept together.
                        const columns = new Map();
                        for (const id of main) {
                            const { level, size } = graphNodes.get(id) ?? clustersById.get(id);
                            const column = columns.get(level) ?? [];
                            const order = graphNodes.get(id)?.path ?? clustersById.get(id).domain;
                            column.push({ id, size, order });
                            columns.set(level, column);
                        }
                        const positions = [];
                        for (const [level, column] of columns) {
                            column.sort((a, b) => a.order.localeCompare(b.order));
                            let y = 0;
                            const rows = column.map(({ id, size }, index) => {
                                if (index) y += Math.max(52, column[index - 1].size + size + 16);
                                return [id, { x: level * 410, y }];
                            });
                            const center = (y + column.at(-1).size - column[0].size) / 2;
                            for (const [id, point] of rows) positions.push([id, { x: point.x, y: point.y - center }]);
                        }
                        placeNodes(positions);
                    }
                    network.setSize(container.clientWidth + 'px', container.clientHeight + 'px');
                    network.redraw();
                    network.fit({ nodes: main });
                    const boxes = main.map(id => network.getBoundingBox(id));
                    const left = Math.min(...boxes.map(box => box.left));
                    const right = Math.max(...boxes.map(box => box.right));
                    const top = Math.min(...boxes.map(box => box.top));
                    const bottom = Math.max(...boxes.map(box => box.bottom));
                    const { clientWidth: width, clientHeight: height } = container;
                    const padding = 34;
                    const rowHeight = rowNodes.size ? 112 : 0;
                    const scale = Math.min(1.2, Math.max(1, width - padding * 2) / Math.max(1, right - left),
                        Math.max(1, height - padding * 2 - rowHeight) / Math.max(1, bottom - top));
                    fitScale = scale;
                    network.moveTo({
                        scale,
                        position: { x: (left + right) / 2, y: (top + bottom) / 2 },
                        offset: { x: 0, y: -rowHeight / 2 }
                    });
                    if (rowNodes.size) {
                        const positions = [];
                        let slot = 0;
                        const totalSlots = rowNodes.size + (small.length - 1) * 0.35;
                        const spacing = Math.max(1, width - padding * 2) / totalSlots;
                        for (const group of small) {
                            for (const id of group) {
                                if (!unpinned.has(id)) unpinned.set(id, network.getPosition(id));
                                const point = network.DOMtoCanvas({
                                    x: padding + (slot + 0.5) * spacing,
                                    y: height - 35
                                });
                                positions.push([id, point]);
                                slot++;
                            }
                            slot += 0.35;
                        }
                        placeNodes(positions);
                        rowHeading = network.DOMtoCanvas({ x: padding, y: height - 80 });
                    }
                    network.redraw();
                }

                const searchInput = document.getElementById('search-input');
                const searchCount = document.getElementById('search-count');
                const details = document.getElementById('details');
                let searchTimer;

                const domainRows = new Map();
                const edgeTypes = ['wraps', 'renders', 'imports', 'uses-action'];
                const visibleEdgeTypes = new Set(edgeTypes);
                const incidentEdges = new Map(Array.from(graphNodes.keys(), id => [id, []]));
                for (const edge of codeEdges) {
                    incidentEdges.get(edge.from).push(edge);
                    incidentEdges.get(edge.to).push(edge);
                }
                const hopButtons = [...document.querySelectorAll('#hop-levels button')];
                function neighborsWithinHops() {
                    const nodes = new Set([selectedId]);
                    let frontier = [selectedId];
                    for (let depth = 0; depth < hopLimit && frontier.length; depth++) {
                        const next = [];
                        for (const id of frontier) {
                            for (const { from, to, type } of incidentEdges.get(id)) {
                                if (!visibleEdgeTypes.has(type)) continue;
                                const adjacent = from === id ? to : from;
                                if (nodes.has(adjacent) || !visibleDomains.has(graphNodes.get(adjacent).group)) continue;
                                nodes.add(adjacent);
                                next.push(adjacent);
                            }
                        }
                        frontier = next;
                    }
                    return nodes;
                }

                function syncAnswerClusters() {
                    const answer = hopNodes ?? focusIds;
                    const expand = [];
                    const collapse = [];
                    for (const cluster of componentClusters) {
                        const needed = answer && visibleDomains.has(cluster.domain) && cluster.componentIds.some(id => answer.has(id));
                        if (needed && isCollapsed(cluster.id)) {
                            expand.push(cluster);
                            temporarilyOpened.add(cluster.id);
                        } else if (!needed && temporarilyOpened.delete(cluster.id)) {
                            collapse.push(cluster);
                        }
                    }
                    expandGroups(expand);
                    collapseGroups(collapse);
                    updateClusterButton(clusterButton);
                }

                for (const button of hopButtons) {
                    button.addEventListener('click', () => {
                        const hops = Number(button.dataset.hops);
                        hopLimit = hopLimit === hops ? undefined : hops;
                        applyFilters();
                    });
                }

                function applyFilters() {
                    hopNodes = hopLimit ? neighborsWithinHops() : null;
                    withoutRedraw(() => {
                        syncAnswerClusters();
                        for (const button of hopButtons) {
                            button.setAttribute('aria-pressed', String(Number(button.dataset.hops) === hopLimit));
                        }
                        for (const [domain, { checkbox, label }] of domainRows) {
                            checkbox.checked = visibleDomains.has(domain);
                            label.setAttribute('aria-pressed', String(visibleDomains.size === 1 && visibleDomains.has(domain)));
                        }
                        const nodeUpdates = Array.from(graphNodes.values(), node => ({
                            id: node.id, hidden: !visibleDomains.has(node.group) || (hopNodes !== null && !hopNodes.has(node.id)),
                            opacity: nodeOpacity(node.id)
                        }));
                        for (const cluster of componentClusters) {
                            if (isCollapsed(cluster.id)) {
                                network.body.nodes[cluster.id].setOptions({
                                    hidden: !visibleDomains.has(cluster.domain) || hopNodes !== null,
                                    opacity: clusterOpacity(cluster)
                                });
                            }
                        }
                        network.body.data.nodes.update(nodeUpdates);
                        const edgeUpdates = codeEdges.map(edge => ({
                            id: edge.id,
                            hidden: !visibleEdgeTypes.has(edge.type) || (hopNodes !== null && (!hopNodes.has(edge.from) || !hopNodes.has(edge.to))),
                            color: edgeColor(edge)
                        }));
                        for (const update of edgeUpdates) {
                            for (const id of network.getClusteredEdges(update.id)) {
                                if (id !== update.id) network.body.edges[id].setOptions({ hidden: update.hidden, color: update.color });
                            }
                        }
                        network.body.data.edges.update(edgeUpdates);
                    });
                    if (selectedId && !network.body.nodeIndices.includes(selectedId)) {
                        closeDetails();
                        return;
                    }
                    fitGraph();
                }

                function legendRow(name, count) {
                    const row = document.createElement('div');
                    row.className = 'legend-item';
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = true;
                    checkbox.setAttribute('aria-label', 'Show ' + name);
                    const total = document.createElement('span');
                    total.className = 'legend-count';
                    total.textContent = String(count);
                    row.append(checkbox, total);
                    return { row, checkbox, total };
                }

                function initLegend() {
                    const domainsPanel = document.getElementById('legend');
                    const edgesPanel = document.getElementById('edge-legend');
                    const domainTotals = new Map(domains.map(domain => [domain, 0]));
                    for (const node of graphNodes.values()) domainTotals.set(node.group, domainTotals.get(node.group) + 1);
                    for (const [domain, count] of domainTotals) {
                        const { row, checkbox, total } = legendRow(domain, count);
                        row.dataset.domain = domain;
                        const label = document.createElement('button');
                        label.className = 'legend-label';
                        label.title = 'Solo ' + domain;
                        label.setAttribute('aria-pressed', 'false');
                        const dot = document.createElement('span');
                        dot.className = 'dot';
                        dot.style.backgroundColor = theme.groups[domain].color.background;
                        label.append(dot, document.createTextNode(domain));
                        row.insertBefore(label, total);
                        domainRows.set(domain, { checkbox, label });
                        checkbox.addEventListener('change', () => {
                            if (checkbox.checked) visibleDomains.add(domain);
                            else visibleDomains.delete(domain);
                            applyFilters();
                        });
                        label.addEventListener('click', () => {
                            visibleDomains = new Set(visibleDomains.size === 1 && visibleDomains.has(domain) ? domains : [domain]);
                            applyFilters();
                        });
                        domainsPanel.append(row);
                    }
                    for (const type of edgeTypes) {
                        const { row, checkbox, total } = legendRow(type, codeEdges.filter(edge => edge.type === type).length);
                        const label = document.createElement('label');
                        checkbox.id = 'show-edge-' + type;
                        label.htmlFor = checkbox.id;
                        label.textContent = type;
                        row.insertBefore(label, total);
                        checkbox.addEventListener('change', () => {
                            if (checkbox.checked) visibleEdgeTypes.add(type);
                            else visibleEdgeTypes.delete(type);
                            applyFilters();
                        });
                        edgesPanel.append(row);
                    }
                    for (const [id, values] of [['domains-all', domains], ['domains-none', []]]) {
                        document.getElementById(id).addEventListener('click', () => {
                            visibleDomains = new Set(values);
                            applyFilters();
                        });
                    }
                    document.getElementById('stats').textContent = Object.entries(counts)
                        .map(([label, count]) => count + ' ' + label).join(' · ');
                }
                initLegend();

                function applySearch(openMatch = false) {
                    clearTimeout(searchTimer);
                    const query = searchInput.value.trim().toLowerCase();
                    searchMatches = query ? new Set() : null;
                    if (searchMatches) {
                        for (const node of graphNodes.values()) {
                            if (visibleDomains.has(node.group) && [node.fullLabel, node.path].some(value => value.toLowerCase().includes(query))) {
                                searchMatches.add(node.id);
                            }
                        }
                    }
                    searchCount.textContent = searchMatches ? searchMatches.size + (searchMatches.size === 1 ? ' match' : ' matches') : '';
                    const first = openMatch ? searchMatches?.values().next().value : undefined;
                    if (first !== undefined) showDetails(first);
                    else updateNodeOpacity();
                }

                function closeDetails() {
                    if (details.hidden) return;
                    selectedId = undefined;
                    focusIds = null;
                    hopLimit = undefined;
                    network.unselectAll();
                    details.hidden = true;
                    document.getElementById('details-open').onclick = null;
                    applyFilters();
                }

                function openNodeFile(node) {
                    if (node?.path) vscode.postMessage({ command: 'openFile', path: node.path });
                }

                function listNodes(id, ids, empty) {
                    const list = document.getElementById(id);
                    list.replaceChildren();
                    for (const nodeId of ids) {
                        const neighbor = graphNodes.get(nodeId);
                        const item = document.createElement('li');
                        const button = document.createElement('button');
                        button.className = 'connection';
                        button.textContent = neighbor.fullLabel;
                        button.title = neighbor.path;
                        button.addEventListener('click', () => {
                            if (!visibleDomains.has(neighbor.group)) {
                                visibleDomains.add(neighbor.group);
                                applyFilters();
                            }
                            showDetails(nodeId);
                        });
                        item.appendChild(button);
                        list.appendChild(item);
                    }
                    if (!ids.length) {
                        const item = document.createElement('li');
                        item.textContent = empty;
                        list.appendChild(item);
                    }
                }

                const queryInput = document.getElementById('details-query');
                const copyStatus = document.getElementById('copy-status');
                document.getElementById('copy-query').addEventListener('click', () => {
                    vscode.postMessage({ command: 'copyQuery', text: queryInput.value });
                });
                window.addEventListener('message', ({ data }) => {
                    if (data?.command === 'queryCopied' && data.text === queryInput.value) copyStatus.textContent = 'Copied';
                });

                function showDetails(id) {
                    const node = graphNodes.get(id);
                    if (!node) {
                        closeDetails();
                        return;
                    }
                    if (selectedId !== id) hopLimit = undefined;
                    selectedId = id;
                    const wrappers = (layoutsByPage.get(id) ?? []).map(edge => edge.from);
                    const pages = node.kind === 'component' ? renderedBy(id) : [];
                    const callers = node.kind === 'action' ? [...connections.get(id).incoming] : [];
                    focusIds = new Set([id, ...wrappers, ...pages, ...callers]);
                    if (node.componentId) focusIds.add(node.componentId);

                    document.getElementById('details-label').textContent = node.fullLabel;
                    document.getElementById('details-kind').textContent = node.routeType ?? node.kind;
                    document.getElementById('details-path').textContent = node.path;
                    document.getElementById('details-domain').textContent = node.group;
                    const openButton = document.getElementById('details-open');
                    openButton.disabled = !node.path;
                    openButton.onclick = () => openNodeFile(node);
                    document.getElementById('upstream').textContent = connections.get(id).incoming.size;
                    document.getElementById('downstream').textContent = connections.get(id).outgoing.size;
                    document.getElementById('wrapper-section').hidden = node.routeType !== 'page';
                    document.getElementById('render-section').hidden = node.kind !== 'component';
                    document.getElementById('callers-section').hidden = node.kind !== 'action';
                    listNodes('details-wrappers', wrappers, 'No layouts');
                    listNodes('details-pages', pages, 'No rendering pages found');
                    listNodes('details-callers', callers, 'No callers');
                    document.getElementById('render-heading').textContent = 'Rendered by ' + pages.length + (pages.length === 1 ? ' page' : ' pages');
                    document.getElementById('callers-heading').textContent = 'Called by ' + callers.length + (callers.length === 1 ? ' node' : ' nodes');
                    queryInput.value = node.query;
                    queryInput.scrollLeft = 0;
                    copyStatus.textContent = '';

                    details.hidden = false;
                    applyFilters();
                    network.selectNodes([id], false);
                }

                searchInput.addEventListener('input', () => {
                    clearTimeout(searchTimer);
                    searchTimer = setTimeout(applySearch, 150);
                });
                searchInput.addEventListener('keydown', event => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        searchInput.value = '';
                        applySearch();
                    } else if (event.key === 'Enter') {
                        event.preventDefault();
                        applySearch(true);
                    }
                });
                let pendingSelection;
                document.getElementById('details-close').addEventListener('click', closeDetails);
                document.addEventListener('keydown', event => {
                    if (event.key !== 'Escape') return;
                    clearTimeout(pendingSelection);
                    if (!details.hidden) closeDetails();
                    else if (domainFocus) leaveDomainFocus();
                });
                network.on('click', ({ nodes }) => {
                    clearTimeout(pendingSelection);
                    // Keep the canvas in place while a second click can still open the file or cluster.
                    pendingSelection = setTimeout(() => showDetails(nodes[0]), 250);
                });

                collapseGroups(componentClusters);
                clusterButton.hidden = componentClusters.length === 0;
                if (componentClusters.length) {
                    document.getElementById('hint').textContent = 'Click for details · Double-click to open a file or expand a bubble';
                }

                function focusDomain(cluster) {
                    closeDetails();
                    restorePositions();
                    domainFocus = { cluster, domains: visibleDomains, position: network.getPosition(cluster.id) };
                    expandGroups([cluster]);
                    visibleDomains = new Set([cluster.domain]);
                    applyFilters();
                }

                function leaveDomainFocus() {
                    const { cluster, domains, position } = domainFocus;
                    domainFocus = undefined;
                    visibleDomains = domains;
                    collapseGroups([cluster]);
                    placeNodes([[cluster.id, position]]);
                    applyFilters();
                }

                clusterButton.addEventListener('click', () => {
                    if (domainFocus) {
                        leaveDomainFocus();
                        return;
                    }
                    closeDetails();
                    const expand = componentClusters.some(({ id }) => isCollapsed(id));
                    restorePositions();
                    if (expand) expandGroups(componentClusters.filter(({ id }) => isCollapsed(id)));
                    else collapseGroups(componentClusters);
                    applyFilters();
                });

                const labelControl = document.getElementById('label-levels');
                const levelButtons = [...labelControl.querySelectorAll('button')];
                let labelOverride;
                let currentLevel;
                let hoveredNode;
                const rankedRoutes = nodes.filter(node => node.kind === 'route' || node.kind === 'layout')
                    .sort((a, b) => adjacency.get(b.id).length - adjacency.get(a.id).length);
                const mapRoutes = new Set(rankedRoutes.slice(0, 12).map(node => node.id));
                const clustersById = new Map(componentClusters.map(cluster => [cluster.id, cluster]));
                labelControl.addEventListener('click', event => {
                    const level = event.target.dataset.level;
                    if (!level) return;
                    labelOverride = labelOverride === level ? undefined : level;
                    network.redraw();
                });

                network.on('hoverNode', ({ node }) => { hoveredNode = node; network.redraw(); });
                network.on('blurNode', () => { hoveredNode = undefined; network.redraw(); });
                network.on('beforeDrawing', () => {
                    const scale = network.getScale();
                    for (const id of network.body.edgeIndices) {
                        const original = edgeById.get(network.getBaseEdge(id));
                        if (!original) continue;
                        const style = edgeStyles[original.type];
                        const edge = network.body.edges[id];
                        edge.options.width = style.width / scale;
                        edge.options.dashes = style.dashes && style.dashes.map(length => length / scale);
                    }
                });
                network.on('afterDrawing', ctx => {
                    const scale = network.getScale();
                    const level = labelOverride || (graphNodes.size <= 6 || scale >= Math.max(0.85, fitScale * 2) ? 'Full'
                        : routesMode || domainFocus || network.body.nodeIndices.length <= 150 || scale >= fitScale * 1.3
                            ? 'Read' : 'Map');
                    if (currentLevel !== level) {
                        currentLevel = level;
                        for (const button of levelButtons) {
                            button.setAttribute('aria-pressed', String(button.dataset.level === level));
                        }
                    }
                    labelControl.title = labelOverride ? 'Click the active level to return to Auto' : 'Auto · follows zoom';

                    const focused = new Set(hopNodes ?? focusIds ?? network.getSelectedNodes());
                    for (const id of [...focused]) focused.add(network.findNode(id)[0]);
                    if (hoveredNode !== undefined) focused.add(hoveredNode);
                    for (const id of [...focused]) {
                        if (focusIds) break;
                        for (const member of adjacency.get(id) ?? []) focused.add(network.findNode(member)[0]);
                    }
                    const { clientWidth: width, clientHeight: height } = container;
                    const labels = [];
                    const positionsByDomain = new Map();
                    const markers = [];
                    for (const id of network.body.nodeIndices) {
                        const node = graphNodes.get(id);
                        const cluster = clustersById.get(id);
                        if (!node && !cluster) continue;
                        const { x, y } = network.canvasToDOM(network.getPosition(id));
                        if (x < 0 || x > width || y < 0 || y > height) continue;
                        const domain = node?.group ?? cluster.domain;
                        const point = { x, y };
                        const radius = (cluster?.size ?? node.size) * scale + 2;
                        markers.push({ left: x - radius, top: y - radius, right: x + radius, bottom: y + radius });
                        if (level === 'Map' && !rowNodes.has(id)) {
                            const points = positionsByDomain.get(domain) ?? [];
                            points.push(point);
                            positionsByDomain.set(domain, points);
                        }
                        const isRoute = node?.kind === 'route' || node?.kind === 'layout';
                        const isFocused = focused.has(id);
                        const eligible = isFocused || cluster || level === 'Full' ||
                            (level === 'Map' && mapRoutes.has(id)) ||
                            (level === 'Read' && (isRoute || node.kind !== 'component' || adjacency.get(id).length >= 2));
                        if (!eligible) continue;
                        labels.push({
                            ...point, radius, size: cluster || isRoute ? 13 : 11,
                            text: cluster ? domain + ' (' + cluster.count + ')' : node.shortLabel,
                            alpha: cluster ? clusterOpacity(cluster) : nodeOpacity(id),
                            priority: isFocused ? 0 : cluster ? 1 : isRoute ? 2 : 4,
                            inRow: rowNodes.has(id)
                        });
                    }
                    for (const [domain, positions] of positionsByDomain) {
                        if (positions.length < 2 || componentClusters.some(cluster => cluster.domain === domain && isCollapsed(cluster.id))) continue;
                        const center = positions.reduce((sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y }), { x: 0, y: 0 });
                        labels.push({ x: center.x / positions.length, y: center.y / positions.length,
                            radius: 16, size: 13, text: domain, alpha: focusIds ? 0.15 : 1, priority: 3 });
                    }
                    labels.sort((a, b) => a.priority - b.priority);

                    // Work in screen pixels, leaving vis in control of the canvas transform.
                    ctx.save();
                    const pixelRatio = ctx.getTransform().a / scale;
                    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    const occupied = [];
                    if (rowHeading) {
                        const { x, y } = network.canvasToDOM(rowHeading);
                        ctx.fillStyle = theme.font.color;
                        ctx.font = '12px system-ui';
                        const text = 'Unconnected (' + rowNodes.size + ')';
                        ctx.fillText(text, x, y);
                        occupied.push({ left: x, top: y - 8, right: x + ctx.measureText(text).width, bottom: y + 8 });
                    }
                    if (selectedId) {
                        const wrapperNumbers = new Map((layoutsByPage.get(selectedId) ?? []).map((edge, index) => [edge.id, index + 1]));
                        for (const id of network.body.edgeIndices) {
                            if (!wrapperNumbers.has(id)) continue;
                            const edge = network.body.edges[id];
                            const { x, y } = network.canvasToDOM(edge.edgeType.getPoint(0.55));
                            ctx.beginPath();
                            ctx.arc(x, y, 9, 0, Math.PI * 2);
                            ctx.fillStyle = theme.font.background;
                            ctx.fill();
                            ctx.strokeStyle = edgeColor(edgeById.get(id)).color;
                            ctx.stroke();
                            ctx.fillStyle = theme.font.color;
                            ctx.textAlign = 'center';
                            ctx.font = '11px system-ui';
                            ctx.fillText(String(wrapperNumbers.get(id)), x, y);
                            ctx.textAlign = 'left';
                            occupied.push({ left: x - 9, right: x + 9, top: y - 9, bottom: y + 9 });
                        }
                    }
                    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
                    for (const label of labels) {
                        const { x, y, radius, size } = label;
                        ctx.font = size + 'px system-ui';
                        const w = ctx.measureText(label.text).width + 8;
                        const h = size + 5;
                        const centered = Math.max(3, Math.min(width - w - 3, x - w / 2));
                        const sides = [[x + radius, y - h / 2], [x - radius - w, y - h / 2]];
                        const vertical = [[centered, y + radius], [centered, y - radius - h]];
                        const candidates = label.inRow ? [...vertical, ...sides] : [...sides, ...vertical];
                        for (const extra of [h + 3, (h + 3) * 2, (h + 3) * 3]) {
                            candidates.push([centered, y - radius - h - extra], [centered, y + radius + extra]);
                        }
                        for (const [left, top] of candidates) {
                            const box = { left, top, right: left + w, bottom: top + h };
                            if (left < 2 || top < 2 || box.right > width - 2 || box.bottom > height - 2) continue;
                            if (occupied.some(other => intersects(box, other)) || markers.some(other => intersects(box, other))) continue;
                            occupied.push(box);
                            ctx.globalAlpha = label.alpha;
                            const nearestY = Math.max(top, Math.min(y, box.bottom));
                            if (Math.abs(nearestY - y) > radius + 3) {
                                ctx.strokeStyle = theme.edge.color;
                                ctx.lineWidth = 1;
                                ctx.beginPath();
                                ctx.moveTo(x, y + Math.sign(nearestY - y) * radius);
                                ctx.lineTo(Math.max(left, Math.min(x, box.right)), nearestY);
                                ctx.stroke();
                            }
                            ctx.fillStyle = theme.font.background;
                            ctx.beginPath();
                            ctx.roundRect(left, top, w, h, 3);
                            ctx.fill();
                            ctx.fillStyle = theme.font.color;
                            ctx.fillText(label.text, left + 4, top + h / 2);
                            break;
                        }
                    }
                    ctx.restore();
                });
                const graphButton = document.getElementById('mode-graph');
                const routesButton = document.getElementById('mode-routes');
                const physicsButton = document.getElementById('btn-physics');
                let graphPositions;
                let resumeGraphPhysics = false;
                function switchLayout(toRoutes) {
                    if (routesMode === toRoutes) return;
                    withoutRedraw(() => {
                        if (toRoutes) {
                            restorePositions();
                            resumeGraphPhysics = physicsEnabled;
                            graphPositions = network.getPositions(Object.keys(network.body.nodes));
                            setPhysicsEnabled(false);
                        }
                        routesMode = toRoutes;
                        const hubs = nodes.filter(node => !node.kind);
                        network.body.data.nodes.update(hubs.map(({ id }) => ({ id, hidden: toRoutes })));
                        const activeTethers = network.body.data.edges.getIds({ filter: edge => edge.id.startsWith('hub-edge:') });
                        network.body.data.edges.update(activeTethers.map(id => ({ id, hidden: toRoutes })));
                        network.setOptions({ edges: { smooth: toRoutes ? false : options.edges.smooth } });
                        if (!toRoutes) {
                            placeNodes(Object.entries(graphPositions));
                            setPhysicsEnabled(resumeGraphPhysics);
                        }
                    });
                    graphButton.setAttribute('aria-pressed', String(!toRoutes));
                    routesButton.setAttribute('aria-pressed', String(toRoutes));
                    physicsButton.disabled = toRoutes;
                    fitGraph();
                }
                graphButton.addEventListener('click', () => switchLayout(false));
                routesButton.addEventListener('click', () => switchLayout(true));

                document.getElementById('btn-fit').addEventListener('click', () => fitGraph());
                new ResizeObserver(() => {
                    if (!physicsEnabled) fitGraph();
                }).observe(container);
                
                const pauseAfterStabilization = () => {
                    log('Stabilization finished. Layout paused.');
                    setPhysicsEnabled(false);
                    fitGraph();

                };
                network.once('stabilizationIterationsDone', pauseAfterStabilization);
                document.getElementById('btn-physics').addEventListener('click', () => {
                    network.off('stabilizationIterationsDone', pauseAfterStabilization);
                    if (!physicsEnabled) {
                        restorePositions();
                        rowNodes.clear();
                        rowHeading = undefined;
                    }
                    setPhysicsEnabled(!physicsEnabled);
                    if (!physicsEnabled) fitGraph();
                });

                network.on('doubleClick', ({ nodes }) => {
                    clearTimeout(pendingSelection);
                    const id = nodes[0];
                    if (!id) return;
                    const cluster = clustersById.get(id);
                    if (cluster) focusDomain(cluster);
                    else openNodeFile(graphNodes.get(id));
                });
            }
        } catch (e) {
            log('CRITICAL ERROR: ' + e.message);
            showError('Critical Error: ' + e.message);
        }
    </script>
</body>
</html>`;
    }
}
