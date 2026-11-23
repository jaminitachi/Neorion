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
                label,
                group: r.domain || 'other',
                title: [`Route: ${label}`, `File: ${r.file}`, `Domain: ${r.domain}`,
                    ...(r.methods?.includes('ALL') ? ['HTTP methods undetermined'] : []),
                    ...(r.wraps?.length ? ['Wraps:', ...r.wraps.map(id => id.slice('route:'.length))] : [])
                ].join('\n'),
                shape: 'box',
                path: r.file
            };
        });

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
                title: `Server action: ${label}\nPath: ${file}`, shape: 'box'
            };
        });
        const callerNodes = [...new Set(graph.edges.map(edge => edge.from).filter(id => id.startsWith('file:')))]
            .map(id => {
                const file = id.slice('file:'.length);
                return {
                    id, label: path.posix.basename(file), path: file,
                    group: DomainExtractor.extract('/' + file), title: `Server action caller: ${file}`, shape: 'box'
                };
            });
        const rawNodes = [...routeNodes, ...componentNodes, ...actionNodes, ...callerNodes];
        const nodes = Array.from(new Map(rawNodes.map(item => [item.id, item])).values());
        const domains = Array.from(new Set(nodes.map(n => n.group))).sort();
        
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

        const codeEdges = [
            ...graph.routes.flatMap(route => route.componentId ? [{
                from: route.id, to: route.componentId, arrows: 'to', length: 50, width: 2
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
            ...nodes.map(node => ({
                from: node.id, to: `hub_${node.group}`, color: { opacity: 0 },
                length: 100, smooth: false, width: 0
            }))
        ];

        const groupsConfig = domains.reduce((acc, domain, index) => {
            const background = DomainExtractor.getColor(domain, index);
            // This outline has at least 3:1 contrast on both white and #1e1e1e.
            acc[domain] = { color: { background, border: '#767676' } };
            return acc;
        }, Object.create(null) as Record<string, { color: { background: string; border: string } }>);

        const denseGraph = nodes.length > 100;
        const displayNodes = nodes.map(node => {
            const prominent = node.id.startsWith('route:') || node.id.startsWith('action:');
            const degree = neighbors.get(node.id)?.size ?? 0;
            // A dense graph fits at a much smaller scale than a handful of nodes.
            const fontSize = denseGraph ? 62 : 18;
            const padding = (denseGraph ? 18 : 10) + Math.min(20, Math.sqrt(degree) * 4);
            return {
                ...node,
                label: truncateLabel(node.label),
                ...(prominent ? {
                    margin: padding,
                    font: { size: fontSize, bold: { size: fontSize } },
                    scaling: { label: { drawThreshold: 0 } }
                } : node.shape === 'ellipse' ? {
                    // Keep the ellipse dimensions stable as labels appear and disappear.
                    font: { size: 12, color: 'transparent', bold: { color: 'transparent' } }
                } : {})
            };
        });
        const graphPayload = {
            nodes: [...displayNodes, ...hubNodes], edges, groupsConfig, domains, denseGraph,
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
        .dot { box-sizing: border-box; width: 12px; height: 12px; border: 1px solid; border-radius: 50%; margin-right: 8px; }
        .shape-key { border-top: 1px solid var(--border-color); margin-top: 6px; padding: 6px 4px 0; font-size: 12px; }
        .shape-key-title { font-weight: 600; margin-bottom: 4px; }
        .shape-key-item { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
        .shape-icon { box-sizing: border-box; width: 14px; height: 10px; border: 1px solid currentColor; }
        .shape-icon.ellipse { border-radius: 50%; }
        
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
    <div class="legend">
        <div id="legend"></div>
        <div class="shape-key">
            <div class="shape-key-title">Node shapes</div>
            <div class="shape-key-item"><span class="shape-icon" aria-hidden="true"></span>Route / action</div>
            <div class="shape-key-item"><span class="shape-icon ellipse" aria-hidden="true"></span>Component</div>
        </div>
    </div>
    
    <div id="controls">
        <button id="btn-physics" class="btn">Pause layout</button>
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

        function setPhysicsEnabled(enabled) {
            physicsEnabled = enabled;
            if (!physicsEnabled) network.storePositions();
            network.setOptions({ physics: { enabled: physicsEnabled } });
            
            const btn = document.getElementById('btn-physics');
            btn.textContent = physicsEnabled ? 'Pause layout' : 'Layout paused (click to resume)';
            btn.title = physicsEnabled ? 'Click to pause layout' : 'Click to re-run layout';
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

        document.getElementById('btn-logs').addEventListener('click', () => {
            document.getElementById('debug-log').style.display = 'block';
        });

        try {
            const rawData = "${safeGraphData}";
            const { nodes, edges, groupsConfig, domains, denseGraph, neighbors } = JSON.parse(
                new TextDecoder().decode(Uint8Array.from(atob(rawData), char => char.charCodeAt(0)))
            );

            const container = document.getElementById('mynetwork');
            const options = {
                layout: {
                    randomSeed: 42,
                    // Start physics from seeded positions and skip the clustering pre-pass.
                    improvedLayout: false
                },
                nodes: {
                    font: { size: 14, color: '#111111' },
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
                const adjacency = new Map(neighbors);
                const components = nodes.filter(node => node.shape === 'ellipse');
                let hoveredNode;
                let showComponentLabels = false;
                let showLabelScale = 0.8;

                function updateLabelVisibility() {
                    const scale = network.getScale();
                    if (scale >= showLabelScale) showComponentLabels = true;
                    else if (scale <= showLabelScale * 0.875) showComponentLabels = false;
                }

                network.on('zoom', updateLabelVisibility);
                network.on('hoverNode', ({ node }) => { hoveredNode = node; });
                network.on('blurNode', () => { hoveredNode = undefined; });
                network.on('afterDrawing', ctx => {
                    // Fits can change the scale without emitting a zoom event.
                    updateLabelVisibility();
                    const active = network.getSelectedNodes();
                    if (hoveredNode !== undefined) active.push(hoveredNode);
                    if (!showComponentLabels && active.length === 0) return;
                    const focused = new Set();
                    for (const id of active) {
                        focused.add(id);
                        for (const adjacent of adjacency.get(id) ?? []) focused.add(adjacent);
                    }
                    const scale = network.getScale();
                    ctx.save();
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    for (const node of components) {
                        const isFocused = focused.has(node.id);
                        if (!showComponentLabels && !isFocused) continue;
                        const { x, y } = network.getPosition(node.id);
                        const fontSize = Math.min(14 / scale, Math.max(12, (isFocused ? 12 : 10) / scale));
                        ctx.font = fontSize + 'px arial';
                        ctx.globalAlpha = activeDomain && node.group !== activeDomain && node.group !== 'hooks' ? 0.1 : 1;
                        if (fontSize > 12) {
                            const width = ctx.measureText(node.label).width + 8 / scale;
                            const height = fontSize + 4 / scale;
                            ctx.fillStyle = groupsConfig[node.group].color.background;
                            ctx.beginPath();
                            ctx.roundRect(x - width / 2, y - height / 2, width, height, 3 / scale);
                            ctx.fill();
                        }
                        ctx.fillStyle = '#111111';
                        ctx.fillText(node.label, x, y);
                    }
                    ctx.restore();
                });
                document.getElementById('btn-fit').addEventListener('click', () => network.fit({ animation: true }));
                
                const pauseAfterStabilization = () => {
                    log('Stabilization finished. Layout paused.');
                    setPhysicsEnabled(false);
                    network.fit();
                    if (denseGraph) {
                        // Dense graphs start farther out, so reveal labels after a modest zoom in.
                        showLabelScale = Math.min(0.8, network.getScale() * 1.4);
                    }
                };
                network.once('stabilizationIterationsDone', pauseAfterStabilization);
                document.getElementById('btn-physics').addEventListener('click', () => {
                    network.off('stabilizationIterationsDone', pauseAfterStabilization);
                    setPhysicsEnabled(!physicsEnabled);
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
