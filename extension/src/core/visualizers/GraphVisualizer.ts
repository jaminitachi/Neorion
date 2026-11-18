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
        // 1. Prepare Nodes
        const routeNodes = graph.routes.map(r => ({ 
            id: r.id, 
            label: r.methods?.length ? `${r.methods.join(", ")} ${r.path}` : r.scope ?? r.path,
            group: r.domain || 'other', 
            title: [`Route: ${r.path}`, `File: ${r.file}`, `Domain: ${r.domain}`,
                ...(r.wraps?.length ? ['Wraps:', ...r.wraps.map(id => id.slice('route:'.length))] : [])
            ].join('\n'),
            shape: 'box',     
            path: r.file,
            margin: 10
        }));

        const componentNodes = graph.components.map(c => ({ 
            id: c.id, 
            label: c.name, 
            group: c.domain || 'other', 
            title: `Component: ${c.name}\nPath: ${c.path}\nDomain: ${c.domain}\n\n${c.description ? '📝 ' + c.description : ''}`,
            shape: 'ellipse', 
            path: c.path 
        }));

        const actionNodes = graph.actions.map(id => {
            const separator = id.lastIndexOf('#');
            const file = id.slice('action:'.length, separator);
            const label = id.slice(separator + 1);
            return {
                id, label, path: file, group: DomainExtractor.extract('/' + file),
                title: `Server action: ${label}\nPath: ${file}`, shape: 'box', margin: 10
            };
        });
        const rawNodes = [...routeNodes, ...componentNodes, ...actionNodes];
        const nodes = Array.from(new Map(rawNodes.map(item => [item.id, item])).values());
        const domains = Array.from(new Set(nodes.map(n => n.group)));
        
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
            if (fromDomain && toDomain && fromDomain === toDomain) return 50; 
            // Inter-Galactic: Far away
            return 400; 
        };

        const edges = [
            ...graph.routes.flatMap(route => route.componentId ? [{
                from: route.id, to: route.componentId, arrows: 'to', length: 50, width: 2
            }] : []),
            ...graph.edges.map(edge => ({
                from: edge.from, to: edge.to, title: edge.type, arrows: 'to',
                dashes: edge.type === 'imports', length: getEdgeLength(edge.from, edge.to)
            })),
            ...nodes.map(node => ({
                from: node.id, to: `hub_${node.group}`, color: { opacity: 0 },
                length: 100, smooth: false, width: 0
            }))
        ];

        const groupsConfig = domains.reduce((acc, domain) => {
            const color = DomainExtractor.getColor(domain);
            acc[domain] = { color: { background: color, border: color } };
            return acc;
        }, Object.create(null) as Record<string, { color: { background: string; border: string } }>);
        groupsConfig['hooks'] = { color: { background: '#e17055', border: '#e17055' } };
        

        const graphPayload = { nodes: [...nodes, ...hubNodes], edges, groupsConfig, domains };
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
        :root {
            --bg-color: var(--vscode-editor-background, #1e1e1e);
            --fg-color: var(--vscode-editor-foreground, #ccc);
            --border-color: var(--vscode-panel-border, #444);
        }
        body { margin: 0; padding: 0; width: 100%; height: 100vh; background-color: var(--bg-color); color: var(--fg-color); overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        #mynetwork { width: 100%; height: 100%; border: 1px solid var(--border-color); }
        .legend { position: absolute; top: 10px; left: 10px; background: var(--bg-color); opacity: 0.9; max-height: 80vh; overflow-y: auto; padding: 10px; border-radius: 5px; z-index: 1000; border: 1px solid var(--border-color); }
        .legend-item { display: flex; align-items: center; margin-bottom: 5px; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 3px; transition: background 0.2s; }
        .legend-item:hover { background: rgba(255,255,255,0.1); }
        .legend-item.inactive { opacity: 0.3; }
        .dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        
        #controls { position: absolute; top: 10px; right: 10px; z-index: 1000; display: flex; gap: 8px; }
        .btn { background: #333; color: white; border: 1px solid #555; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 12px; transition: background 0.2s; }
        .btn:hover { background: #444; }
        
        #error-overlay { display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 2000; align-items: center; justify-content: center; flex-direction: column; }
        #error-content { background: #2d2d2d; padding: 20px; border-radius: 8px; max-width: 80%; border: 1px solid #ff4444; color: #ff9999; }
        #debug-log { position: absolute; bottom: 0; left: 0; width: 100%; max-height: 150px; background: rgba(0,0,0,0.8); color: lime; font-family: monospace; font-size: 10px; overflow-y: auto; display: none; padding: 5px; }
    </style>
</head>
<body>
    <div id="mynetwork"></div>
    <div class="legend" id="legend">
        <!-- Generated by JS -->
    </div>
    
    <div id="controls">
        <button id="btn-physics" class="btn">❄️ Freeze</button>
        <button id="btn-fit" class="btn">Fit Graph</button>
    </div>

    <div id="error-overlay">
        <div id="error-content">
            <h3 style="margin-top: 0">Rendering Failed</h3>
            <p id="error-message">Unknown error</p>
            <button id="btn-logs" style="background: #444; border: none; color: white; padding: 5px;">Show Logs</button>
        </div>
    </div>
    <div id="debug-log"></div>
    
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let physicsEnabled = true;
        let activeDomain = null; // Filter state


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

        function togglePhysics() {
            physicsEnabled = !physicsEnabled;
            if (!physicsEnabled) network.storePositions();
            network.setOptions({ physics: { enabled: physicsEnabled } });
            
            const btn = document.getElementById('btn-physics');
            btn.innerText = physicsEnabled ? "❄️ Freeze" : "▶️ Unfreeze";
            btn.style.background = physicsEnabled ? "#333" : "#e17055";
        }

        // Filtering Logic
        function toggleFilter(domain) {
            if (activeDomain === domain) {
                // Reset
                activeDomain = null;
                // Restore all opacities
                network.body.data.nodes.update(
                    network.body.data.nodes.get().map(n => ({ id: n.id, opacity: undefined, color: undefined }))
                );
                document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('inactive'));
            } else {
                // Focus
                activeDomain = domain;
                const allNodes = network.body.data.nodes.get();
                const updates = allNodes.map(n => {
                    const isMatch = n.group === domain || n.group === 'hooks'; // Keep hooks visible as connectors
                    const isHub = n.id.startsWith('hub_');
                    if (isHub) return { id: n.id }; // Ignore hubs

                    return { 
                        id: n.id, 
                        opacity: isMatch ? 1 : 0.1,
                        // Optional: grey out color
                    };
                });
                network.body.data.nodes.update(updates);
                
                // Update Legend UI
                document.querySelectorAll('.legend-item').forEach(el => {
                    if (el.dataset.domain === domain) el.classList.remove('inactive');
                    else el.classList.add('inactive');
                });
            }
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
                dot.style.background = groupsConfig[domain].color.background;
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

        document.getElementById('btn-logs').addEventListener('click', () => {
            document.getElementById('debug-log').style.display = 'block';
        });

        try {
            const rawData = "${safeGraphData}";
            const { nodes, edges, groupsConfig, domains } = JSON.parse(
                new TextDecoder().decode(Uint8Array.from(atob(rawData), char => char.charCodeAt(0)))
            );

            const container = document.getElementById('mynetwork');
            const options = {
                nodes: {
                    font: { size: 14, color: '#eeeeee' },
                    borderWidth: 2,
                    shadow: true
                },
                groups: groupsConfig,
                edges: {
                    color: { color: '#636e72', opacity: 0.6 },
                    arrows: 'to',
                    width: 1.5,
                    smooth: { type: 'continuous', roundness: 0.5 }
                },
                physics: {
                    stabilization: {
                        enabled: true,
                        iterations: 2000,
                        updateInterval: 50,
                        fit: true
                    },
                    solver: 'barnesHut', 
                    barnesHut: {
                        gravitationalConstant: -40000, // Massive repulsion (Static Space)
                        centralGravity: 0.001,         // Almost zero gravity (Universe)
                        springLength: 50,              // Tighter internal springs
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
                initLegend(domains, groupsConfig);
                document.getElementById('btn-physics').addEventListener('click', togglePhysics);
                document.getElementById('btn-fit').addEventListener('click', () => network.fit({ animation: true }));
                
                network.once("stabilizationIterationsDone", function () {
                    log('Stabilization finished. Freezing.');
                    togglePhysics();
                    network.fit();
                });

                network.on("doubleClick", function (params) {
                    if (params.nodes.length > 0) {
                        const nodeId = params.nodes[0];
                        const clickedNode = network.body.data.nodes.get(nodeId);
                        if (clickedNode?.path) vscode.postMessage({ command: 'openFile', path: clickedNode.path });
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
