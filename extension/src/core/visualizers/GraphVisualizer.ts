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

        const routeNodes = graph.routes.map(r => {
            const label = r.type === 'layout' ? `layout ${r.scope ?? r.path}`
                : ['loading', 'error', 'not-found', 'template', 'default', 'global-error'].includes(r.type) ? `${r.type} ${r.path}`
                : r.methods?.length ? `${r.methods.join(", ").replace(/^ALL$/, "*")} ${r.path}` : r.path;
            return {
                id: r.id,
                kind: r.type === 'layout' ? 'layout' : 'route',
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
                id, label, kind: 'action', path: file, group: DomainExtractor.extract('/' + file),
                title: `Server action: ${label}\nPath: ${file}`, shape: 'square'
            };
        });
        const callerNodes = [...new Set(graph.edges.map(edge => edge.from).filter(id => id.startsWith('file:')))]
            .map(id => {
                const file = id.slice('file:'.length);
                return {
                    id, kind: 'file', label: path.posix.basename(file), path: file,
                    group: DomainExtractor.extract('/' + file), title: `Server action caller: ${file}`, shape: 'square'
                };
            });
        const rawNodes = [...routeNodes, ...componentNodes, ...actionNodes, ...callerNodes];
        const nodes = Array.from(new Map(rawNodes.map(item => [item.id, item])).values());
        const domains = Array.from(new Set(nodes.map(n => n.group))).sort();
        
        const componentCounts = new Map<string, number>();
        for (const node of nodes) {
            if (node.kind === 'component') {
                componentCounts.set(node.group, (componentCounts.get(node.group) ?? 0) + 1);
            }
        }
        const bigGroups = [...componentCounts].filter(([, count]) => count > 40);

        const hasBigGroups = bigGroups.length > 0;
        // Hub nodes with reduced mass to prevent spinning
        const hubNodes = domains.map(d => ({
            id: `hub_${d}`,
            label: '',
            group: d,
            shape: 'dot',
            size: 0, opacity: 0, 
            mass: 1, 
            fixed: false, // RELEASED: Allow hubs to float and find natural balance
            title: '', path: ''
        }));
        // 3. Prepare Edges (Galaxy v2: Tight Clusters, Loose Space)
        const nodeDomainMap = new Map<string, string>();
        nodes.forEach(n => nodeDomainMap.set(n.id, n.group));

        const getEdgeLength = (fromId: string, toId: string) => {
            const fromDomain = nodeDomainMap.get(fromId);
            const toDomain = nodeDomainMap.get(toId);
            // Same Galaxy (Domain): Tight gravity
            if (fromDomain && toDomain && fromDomain === toDomain) return hasBigGroups ? 160 : 50;
            return hasBigGroups ? 500 : 400;
        };

        const codeEdges = [
            ...graph.routes.flatMap(route => route.componentId ? [{
                from: route.id, to: route.componentId, arrows: 'to', length: hasBigGroups ? 160 : 50, width: 2
            }] : []),
            ...graph.edges.map(edge => ({
                from: edge.from, to: edge.to, title: edge.type, arrows: 'to',
                dashes: edge.type === 'imports', length: getEdgeLength(edge.from, edge.to)
            }))
        ];
        const neighbors = new Map(nodes.map(node => [node.id, new Set<string>()]));
        for (const { from, to } of codeEdges) {
            if (from !== to && neighbors.has(from) && neighbors.has(to)) {
                neighbors.get(from)?.add(to);
                neighbors.get(to)?.add(from);
            }
        }
        const edges = [
            ...codeEdges,
            ...nodes.map((node, index) => ({
                id: `hub-edge:${index}`,
                from: node.id, to: `hub_${node.group}`, color: { opacity: 0 },
                length: hasBigGroups ? 220 : 100, smooth: false, width: 0
            }))
        ];

        const groupsConfig = domains.reduce((acc, domain, index) => {
            acc[domain] = DomainExtractor.getColor(domain, index);
            return acc;
        }, Object.create(null) as Record<string, string>);

        const denseGraph = nodes.length > 100;
        const displayNodes = nodes.map(node => ({
            ...node,
            fullLabel: node.label,
            shortLabel: truncateLabel(node.label),
            label: '',
            size: node.kind === 'component' ? 13 : 18
        }));
        const graphPayload = {
            nodes: [...displayNodes, ...hubNodes], edges, groupsConfig, domains, denseGraph, bigGroups,
            neighbors: Array.from(neighbors, ([id, adjacent]) => [id, [...adjacent]])
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
        #hint { margin: 0; padding: 5px 10px; border-top: 1px solid var(--border-color); font-size: 12px; }
        #details { flex: 0 0 min(300px, 36%); min-width: 0; box-sizing: border-box; padding: 14px; overflow: auto; background: var(--vscode-sideBar-background, var(--bg-color)); color: var(--vscode-sideBar-foreground, var(--fg-color)); border-left: 1px solid var(--border-color); z-index: 1001; font-size: 13px; overflow-wrap: anywhere; }
        #details header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        #details h2 { margin: 0; font-size: 16px; }
        #details h3 { margin: 16px 0 4px; font-size: 13px; }
        #details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; }
        #details dd { margin: 0; }
        #details ul { padding-left: 18px; margin: 0; }
        .connection { text-align: left; padding: 3px 0; border: 0; background: transparent; color: var(--vscode-textLink-foreground, var(--fg-color)); font: inherit; overflow-wrap: anywhere; cursor: pointer; }
        .connection:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--fg-color)); }
        .legend { flex: 0 0 min(154px, 24%); min-width: 0; box-sizing: border-box; background: var(--vscode-sideBar-background, var(--bg-color)); overflow: auto; padding: 10px; border-right: 1px solid var(--border-color); }
        .legend-item { display: flex; align-items: center; margin-bottom: 5px; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 3px; transition: background 0.2s; }
        .legend-item:hover { background: var(--vscode-list-hoverBackground, var(--border-color)); }
        .legend-item.inactive { opacity: 0.3; }
        .dot { box-sizing: border-box; width: 12px; height: 12px; border: 1px solid; border-radius: 50%; margin-right: 8px; }
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
            <div id="legend"></div>
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
            <h3>Incoming</h3><ul id="details-incoming"></ul>
            <h3>Outgoing</h3><ul id="details-outgoing"></ul>
        </aside>
    </div>

    <p id="hint">Click a node for details, double-click to open file</p>

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
        let activeDomain = null;
        let searchMatches = null;


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
            if (!physicsEnabled) network.storePositions();
            
            const btn = document.getElementById('btn-physics');
            btn.textContent = physicsEnabled ? 'Pause layout' : 'Layout paused (click to resume)';
            btn.title = physicsEnabled ? 'Click to pause layout' : 'Click to re-run layout';
        }

        function domainOpacity(domain) {
            return !activeDomain || domain === activeDomain || domain === 'hooks' ? 1 : 0.1;
        }

        function isInsideCluster(id) {
            return network.findNode(id).length > 1;
        }

        function isCollapsed(id) {
            // Expanded clusters are absent, and vis logs an error if isCluster receives an absent ID.
            return network.findNode(id).length > 0;
        }

        function nodeOpacity(id, domain) {
            return domainOpacity(domain) * (!searchMatches || searchMatches.has(id) ? 1 : 0.18);
        }

        function clusterOpacity(cluster) {
            return domainOpacity(cluster.domain) *
                (!searchMatches || cluster.componentIds.some(id => searchMatches.has(id)) ? 1 : 0.18);
        }

        function updateNodeOpacity() {
            const updates = network.body.data.nodes.get()
                .filter(node => node.kind && !isInsideCluster(node.id))
                .map(node => ({ id: node.id, opacity: nodeOpacity(node.id, node.group) }));
            network.body.data.nodes.update(updates);

            for (const cluster of componentClusters) {
                if (isCollapsed(cluster.id)) {
                    network.updateClusteredNode(cluster.id, { opacity: clusterOpacity(cluster) });
                }
            }
        }

        function toggleFilter(domain) {
            activeDomain = activeDomain === domain ? null : domain;
            updateNodeOpacity();
            document.querySelectorAll('.legend-item').forEach(el => {
                el.classList.toggle('inactive', activeDomain !== null && el.dataset.domain !== activeDomain);
            });
        }

        function collapseGroup(cluster) {
            const { id, domain, count, hubEdges } = cluster;
            // Remove tethers before clustering so vis never redirects them to the cluster.
            network.body.data.edges.remove(hubEdges.map(edge => edge.id));
            network.cluster({
                joinCondition: node => node.group === domain && node.kind === 'component',
                clusterNodeProperties: {
                    id, group: domain,
                    label: '', shape: 'dot', size: 32, mass: 12,
                    opacity: clusterOpacity(cluster)
                }
            });
        }

        function expandGroup(cluster) {
            const { id, domain, componentIds, hubEdges } = cluster;
            network.openCluster(id, {
                // Give members distinct positions even when layout is paused.
                releaseFunction: (center, positions) => Object.fromEntries(
                    Object.keys(positions).sort().map((nodeId, index) => {
                        const angle = index * Math.PI * (3 - Math.sqrt(5));
                        const radius = 26 * Math.sqrt(index);
                        return [nodeId, { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }];
                    })
                )
            });
            network.body.data.edges.add(hubEdges);
            network.body.data.nodes.update(componentIds.map(id => ({ id, opacity: nodeOpacity(id, domain) })));
        }

        function updateClusterButton(button) {
            button.textContent = componentClusters.some(({ id }) => isCollapsed(id))
                ? 'Expand all' : 'Collapse big groups';
        }

        function initLegend(domains, groupsConfig) {
            const legend = document.getElementById('legend');
            for (const domain of domains) {
                const item = document.createElement('div');
                item.className = 'legend-item';
                item.dataset.domain = domain;
                item.addEventListener('click', () => toggleFilter(domain));
                const dot = document.createElement('div');
                dot.className = 'dot';
                dot.style.backgroundColor = groupsConfig[domain].color.background;
                dot.style.borderColor = groupsConfig[domain].color.border;
                item.append(dot, document.createTextNode(domain));
                legend.appendChild(item);
            }
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
            const surface = luminance(rgb(background));
            const contrast = channels => {
                const fill = luminance(channels);
                return (Math.max(surface, fill) + 0.05) / (Math.min(surface, fill) + 0.05);
            };
            const groups = Object.create(null);
            const textColor = hex(rgb(foreground));
            for (const [domain, color] of Object.entries(groupsConfig)) {
                const original = rgb(color);
                const target = surface > 0.3 ? 0 : 255;
                let adjusted = original;
                for (let mix = 0.05; contrast(adjusted) < 3 && mix <= 1; mix += 0.05) {
                    adjusted = original.map(value => Math.round(value + (target - value) * mix));
                }
                const fill = hex(adjusted);
                groups[domain] = { color: {
                    background: fill, border: fill, highlight: { background: fill, border: textColor },
                    hover: { background: fill, border: textColor }
                } };
            }
            const widgetBorder = styles.getPropertyValue('--vscode-editorWidget-border').trim();
            const editorForeground = styles.getPropertyValue('--vscode-foreground').trim() || foreground;
            return {
                groups,
                font: { color: textColor, background: hex(rgb(background)), bold: { color: textColor } },
                edge: {
                    color: hex(rgb(widgetBorder && contrast(rgb(widgetBorder)) >= 2 ? widgetBorder : editorForeground)),
                    inherit: false,
                    opacity: document.body.matches('.vscode-high-contrast, .vscode-high-contrast-light') ? 1 : 0.6
                }
            };
        }

        document.getElementById('btn-logs').addEventListener('click', () => {
            document.getElementById('debug-log').style.display = 'block';
        });

        let componentClusters = [];
        try {
            const rawData = "${safeGraphData}";
            const { nodes, edges, groupsConfig, domains, denseGraph, bigGroups, neighbors } = JSON.parse(
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
                        iterations: bigGroups.length ? 4000 : 2000,
                        updateInterval: 50,
                        fit: false
                    },
                    solver: 'barnesHut', 
                    barnesHut: {
                        gravitationalConstant: bigGroups.length ? -300000 : -40000,
                        centralGravity: bigGroups.length ? 0.22 : 0.001,
                        springLength: bigGroups.length ? 160 : 50,
                        springConstant: 0.04,
                        damping: 0.5,                  // High resistance (Stops self-movement)
                        avoidOverlap: 1
                    },
                    minVelocity: 0.75
                },
                interaction: { hover: true, tooltipDelay: 200, zoomView: true }
            };
            
            if (typeof vis === 'undefined') {
                showError('Error: vis library not loaded.');
            } else {
                window.network = new vis.Network(container, {
                    nodes: new vis.DataSet(nodes.map(withTextTooltip)),
                    edges: new vis.DataSet(edges.map(withTextTooltip))
                }, options);
                initLegend(domains, theme.groups);
                const graphColors = node => theme.groups[node.group].color;
                new MutationObserver(() => {
                    theme = readTheme(groupsConfig);
                    network.setOptions({ nodes: { font: theme.font }, groups: theme.groups, edges: { color: theme.edge } });
                    network.body.data.nodes.update(nodes.filter(node => node.kind).map(node => ({
                        id: node.id, color: graphColors(node)
                    })));
                    for (const cluster of componentClusters) {
                        if (isCollapsed(cluster.id)) network.updateClusteredNode(cluster.id, { color: graphColors({ group: cluster.domain }) });
                    }
                    for (const item of document.querySelectorAll('.legend-item')) {
                        const color = graphColors({ group: item.dataset.domain });
                        const dot = item.querySelector('.dot');
                        dot.style.backgroundColor = color.background;
                        dot.style.borderColor = color.border;
                    }
                    network.redraw();
                }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
                const adjacency = new Map(neighbors);
                const graphNodes = new Map(nodes.filter(node => node.kind).map(node => [node.id, node]));
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
                componentClusters = bigGroups.map(([domain, count], index) => {
                    const componentIds = components.filter(node => node.group === domain).map(node => node.id);
                    const members = new Set(componentIds);
                    return {
                        id: 'component-cluster:' + index, domain, count, componentIds,
                        hubEdges: edges.filter(edge => edge.id?.startsWith('hub-edge:') && members.has(edge.from))
                    };
                });
                let rowNodes = new Set();
                let rowHeading;
                let fitScale = 1;
                function visibleComponents() {
                    const visible = new Set(network.body.nodeIndices.filter(id => !id.startsWith('hub_')));
                    const links = new Map(Array.from(visible, id => [id, new Set()]));
                    for (const { from, to } of edges) {
                        if (!graphNodes.has(from) || !graphNodes.has(to)) continue;
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
                    if (!groups.length) return;
                    const cutoff = Math.max(2, Math.floor(network.body.nodeIndices.length / 10));
                    const main = groups.filter((group, index) => index === 0 || group.length >= cutoff).flat();
                    const small = groups.slice(1).filter(group => group.length < cutoff);
                    rowNodes = new Set(small.flat());
                    rowHeading = undefined;
                    network.setSize(container.clientWidth + 'px', container.clientHeight + 'px');
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
                        let slot = 0;
                        const totalSlots = rowNodes.size + (small.length - 1) * 0.35;
                        const spacing = Math.max(1, width - padding * 2) / totalSlots;
                        for (const group of small) {
                            for (const id of group) {
                                const point = network.DOMtoCanvas({
                                    x: padding + (slot + 0.5) * spacing,
                                    y: height - 35
                                });
                                network.moveNode(id, point.x, point.y);
                                slot++;
                            }
                            slot += 0.35;
                        }
                        rowHeading = network.DOMtoCanvas({ x: padding, y: height - 80 });
                    }
                    network.redraw();
                }

                const searchInput = document.getElementById('search-input');
                const searchCount = document.getElementById('search-count');
                const details = document.getElementById('details');
                let searchTimer;

                function applySearch() {
                    clearTimeout(searchTimer);
                    const query = searchInput.value.trim().toLowerCase();
                    searchMatches = query ? new Set() : null;
                    if (searchMatches) {
                        for (const node of graphNodes.values()) {
                            if ([node.fullLabel, node.path].some(value => value.toLowerCase().includes(query))) {
                                searchMatches.add(node.id);
                            }
                        }
                    }
                    searchCount.textContent = searchMatches ? searchMatches.size + (searchMatches.size === 1 ? ' match' : ' matches') : '';
                    updateNodeOpacity();
                }

                function focusNode(id) {
                    const [clusterId] = network.findNode(id);
                    if (clusterId !== id) {
                        const cluster = componentClusters.find(cluster => cluster.id === clusterId);
                        if (cluster) {
                            expandGroup(cluster);
                            updateClusterButton(clusterButton);
                        }
                    }
                    network.selectNodes([id], false);
                    showDetails(id);
                    if (!rowNodes.has(id)) network.focus(id, { locked: false });
                }

                function closeDetails() {
                    if (!details.hidden) {
                        details.hidden = true;
                        fitGraph();
                    }
                    document.getElementById('details-open').onclick = null;
                }

                function openNodeFile(node) {
                    if (node?.path) vscode.postMessage({ command: 'openFile', path: node.path });
                }

                function showDetails(id) {
                    const node = graphNodes.get(id);
                    if (!node) {
                        closeDetails();
                        return;
                    }
                    document.getElementById('details-label').textContent = node.fullLabel;
                    document.getElementById('details-kind').textContent = node.kind;
                    document.getElementById('details-path').textContent = node.path;
                    document.getElementById('details-domain').textContent = node.group;
                    const openButton = document.getElementById('details-open');
                    openButton.disabled = !node.path;
                    openButton.onclick = () => openNodeFile(node);

                    for (const [direction, ids] of Object.entries(connections.get(id))) {
                        const list = document.getElementById('details-' + direction);
                        list.replaceChildren();
                        if (ids.size === 0) {
                            const empty = document.createElement('li');
                            empty.textContent = 'None';
                            list.appendChild(empty);
                        }
                        for (const adjacent of ids) {
                            const neighbor = graphNodes.get(adjacent);
                            const item = document.createElement('li');
                            const button = document.createElement('button');
                            button.className = 'connection';
                            button.textContent = neighbor.fullLabel;
                            button.title = neighbor.path;
                            button.addEventListener('click', () => focusNode(adjacent));
                            item.appendChild(button);
                            list.appendChild(item);
                        }
                    }
                    if (details.hidden) {
                        details.hidden = false;
                        fitGraph();
                    }
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
                        applySearch();
                        const first = searchMatches?.values().next().value;
                        if (first !== undefined) focusNode(first);
                    }
                });
                document.getElementById('details-close').addEventListener('click', () => {
                    network.unselectAll();
                    closeDetails();
                });
                network.on('click', ({ nodes }) => showDetails(nodes[0]));

                for (const cluster of componentClusters) collapseGroup(cluster);
                clusterButton.hidden = componentClusters.length === 0;
                clusterButton.addEventListener('click', () => {
                    const expand = componentClusters.some(({ id }) => isCollapsed(id));
                    network.unselectAll();
                    closeDetails();
                    for (const cluster of componentClusters) {
                        if (expand && isCollapsed(cluster.id)) expandGroup(cluster);
                        else if (!expand) collapseGroup(cluster);
                    }
                    updateClusterButton(clusterButton);
                    fitGraph();
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
                network.on('afterDrawing', ctx => {
                    const scale = network.getScale();
                    const level = labelOverride || (graphNodes.size <= 6 || scale >= Math.max(0.85, fitScale * 2) ? 'Full'
                        : !denseGraph || scale >= fitScale * 1.3 ? 'Read' : 'Map');
                    if (currentLevel !== level) {
                        currentLevel = level;
                        for (const button of levelButtons) {
                            button.setAttribute('aria-pressed', String(button.dataset.level === level));
                        }
                    }
                    labelControl.title = labelOverride ? 'Click the active level to return to Auto' : 'Auto · follows zoom';

                    const focused = new Set(network.getSelectedNodes());
                    if (hoveredNode !== undefined) focused.add(hoveredNode);
                    for (const id of [...focused]) {
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
                        const radius = (cluster ? 32 : node.size) * scale + 2;
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
                            alpha: cluster ? clusterOpacity(cluster) : nodeOpacity(id, domain),
                            priority: isFocused ? 0 : cluster ? 1 : isRoute ? 2 : 4,
                            inRow: rowNodes.has(id)
                        });
                    }
                    for (const [domain, positions] of positionsByDomain) {
                        if (positions.length < 2 || componentClusters.some(cluster => cluster.domain === domain && isCollapsed(cluster.id))) continue;
                        const center = positions.reduce((sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y }), { x: 0, y: 0 });
                        labels.push({ x: center.x / positions.length, y: center.y / positions.length,
                            radius: 16, size: 13, text: domain, alpha: domainOpacity(domain), priority: 3 });
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
                    setPhysicsEnabled(!physicsEnabled);
                    if (!physicsEnabled) fitGraph();
                });

                network.on("doubleClick", function (params) {
                    if (params.nodes.length > 0) {
                        const nodeId = params.nodes[0];
                        if (network.isCluster(nodeId)) {
                            const cluster = componentClusters.find(({ id }) => id === nodeId);
                            if (cluster) {
                                network.unselectAll();
                                expandGroup(cluster);
                                updateClusterButton(clusterButton);
                                fitGraph();
                            }
                            return;
                        }
                        openNodeFile(graphNodes.get(nodeId));
                    }
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
