import * as vscode from 'vscode';
import { CodebaseGraph } from '../types/GraphTypes';
import { DomainExtractor } from '../utils/DomainExtractor';

export class GraphVisualizer {
    public static currentPanel: GraphVisualizer | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
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
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
        }
    }

    public static createOrShow(extensionUri: vscode.Uri, graph: CodebaseGraph) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (GraphVisualizer.currentPanel) {
            GraphVisualizer.currentPanel._panel.reveal(column);
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

        GraphVisualizer.currentPanel = new GraphVisualizer(panel, extensionUri);
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
            label: r.path, 
            group: r.domain || 'other', 
            title: `Route: ${r.path}\nFile: ${r.file}\nDomain: ${r.domain}`,
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

        const hookSet = new Set<string>();
        graph.components.forEach(c => {
            if (c.hooks) c.hooks.forEach(h => hookSet.add(h));
        });
        
        const hookNodes = Array.from(hookSet).map(h => ({
            id: `hook_${h}`,
            label: h,
            group: 'hooks',
            title: `Hook: ${h}\n(Inferred from usage)`,
            shape: 'diamond', 
            size: 20,
            path: '' 
        }));
        // Hooks hidden per user request to reduce clutter
        // const hookSet = new Set<string>();
        // graph.components.forEach(c => {
        //     if (c.hooks) c.hooks.forEach(h => hookSet.add(h));
        // });
        
        // const hookNodes = Array.from(hookSet).map(h => ({
        //     id: `hook_${h}`,
        //     label: h,
        //     group: 'hooks',
        //     title: `Hook: ${h}\n(Inferred from usage)`,
        //     shape: 'diamond', 
        //     size: 20,
        //     path: '' 
        // }));

        const rawNodes = [...routeNodes, ...componentNodes];
        let nodes = Array.from(new Map(rawNodes.map(item => [item.id, item])).values());
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
             // Route to Component (Page to Root Component)
             ...graph.routes.filter(r => r.componentName).map(r => ({ 
                 from: r.id, 
                 to: `cmp_${r.componentName}`, 
                 arrows: 'to', 
                 dashes: false,
                 physics: true,
                 length: 50, // Page <-> Root Component is TIGHT
                 width: 2
             })),
             // Component to Component (Imports)
             ...graph.components.flatMap(c => c.imports.filter(i => !i.isExternal).map(i => ({ 
                 from: c.id, 
                 to: `cmp_${i.name}`, 
                 arrows: 'to', 
                 dashes: false,
                 physics: true, // Re-enabled dragging physics!
                 length: getEdgeLength(c.id, `cmp_${i.name}`),
                 color: { opacity: 0.2 } 
             }))),
             // Hub Gravity (Nodes to their Domain Hubs)
             ...nodes.filter(n => !n.id.startsWith('hub_')).map(n => ({
                 from: n.id, 
                 to: `hub_${n.group}`, 
                 color: { opacity: 0 }, 
                 length: 100, // Medium orbit
                 physics: true, 
                 smooth: false, 
                 dashes: false, 
                 width: 0 
             }))
        ];

        const validNodeIds = new Set(nodes.map(n => n.id));
        const validEdges = edges.filter(e => validNodeIds.has(e.to) && validNodeIds.has(e.from));

        const graphPayload = { nodes, edges: validEdges };
        const safeGraphData = Buffer.from(JSON.stringify(graphPayload)).toString('base64');

        const groupsConfig = domains.reduce((acc, domain) => {
            const color = DomainExtractor.getColor(domain);
            acc[domain] = { color: { background: color, border: color } };
            return acc;
        }, {} as any);
        groupsConfig['hooks'] = { color: { background: '#e17055', border: '#e17055' } };
        

        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vis-network.min.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource};">
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
        
        .version-tag { position: absolute; bottom: 5px; right: 5px; opacity: 0.3; font-size: 10px; pointer-events: none; }
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
    <div class="version-tag">Neorion v0.1.4 - Static Space</div>
    
    <div id="controls">
        <button id="btn-physics" class="btn" onclick="togglePhysics()">❄️ Freeze</button>
        <button class="btn" onclick="network.fit({animation: true})">Fit Graph</button>
    </div>

    <div id="error-overlay">
        <div id="error-content">
            <h3 style="margin-top: 0">Rendering Failed</h3>
            <p id="error-message">Unknown error</p>
            <button onclick="document.getElementById('debug-log').style.display = 'block'" style="background: #444; border: none; color: white; padding: 5px;">Show Logs</button>
        </div>
    </div>
    <div id="debug-log"></div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let physicsEnabled = true;
        let activeDomain = null; // Filter state

        const groupsConfig = ${JSON.stringify(groupsConfig)};
        const domains = ${JSON.stringify(domains)};

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

        function initLegend() {
            const legend = document.getElementById('legend');
            legend.innerHTML = domains.map(d => {
                const color = groupsConfig[d] ? groupsConfig[d].color.background : '#888';
                return \`<div class="legend-item" data-domain="\${d}" onclick="toggleFilter('\${d}')">
                    <div class="dot" style="background: \${color};"></div>\${d}
                </div>\`;
            }).join('');
        }

        try {
            initLegend();
            const rawData = "${safeGraphData}";
            let graphData = JSON.parse(atob(rawData));

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
                window.network = new vis.Network(container, { nodes: new vis.DataSet(graphData.nodes), edges: new vis.DataSet(graphData.edges) }, options);
                
                network.once("stabilizationIterationsDone", function () {
                    log('Stabilization finished. Freezing.');
                    togglePhysics();
                    network.fit();
                });

                network.on("doubleClick", function (params) {
                    if (params.nodes.length > 0) {
                        const nodeId = params.nodes[0];
                        const clickedNode = network.body.data.nodes.get(nodeId);
                        if (clickedNode) {
                            let path = clickedNode.path;
                            if (!path && clickedNode.title) {
                                 const match = clickedNode.title.match(/Path: (.*)/);
                                 if (match) path = match[1].trim();
                            }
                            if (path) vscode.postMessage({ command: 'openFile', path });
                        }
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
