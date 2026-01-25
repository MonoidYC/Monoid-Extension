import * as vscode from 'vscode';
import { GraphData, GraphNode, GraphEdge, NodeType } from '../types';

export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'monoid-visualize.graphView';
  
  private _view?: vscode.WebviewView;
  private _graphData: GraphData = { nodes: [], edges: [] };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'nodeClick':
          // Open file at the node's location
          if (message.filePath && message.line) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
              const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, message.filePath);
              try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(doc);
                const position = new vscode.Position(message.line - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
              } catch (err) {
                console.error('Could not open file:', err);
              }
            }
          }
          break;
        case 'ready':
          // Send current graph data when webview is ready
          this.updateGraph(this._graphData);
          break;
      }
    });
  }

  public updateGraph(data: GraphData) {
    this._graphData = data;
    if (this._view) {
      this._view.webview.postMessage({ type: 'updateGraph', data });
    }
  }

  public showLoading(message: string) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'loading', message });
    }
  }

  public showError(message: string) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'error', message });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Graph</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600&display=swap');
    
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --text-primary: #c9d1d9;
      --text-secondary: #8b949e;
      --text-muted: #484f58;
      --accent-cyan: #58a6ff;
      --accent-green: #3fb950;
      --accent-purple: #a371f7;
      --accent-orange: #d29922;
      --accent-pink: #f778ba;
      --accent-red: #f85149;
      --border-default: #30363d;
      --shadow-glow: rgba(88, 166, 255, 0.15);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Space Grotesk', -apple-system, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
      height: 100vh;
    }

    .container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: 
        radial-gradient(ellipse at 20% 80%, rgba(88, 166, 255, 0.08) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 20%, rgba(163, 113, 247, 0.06) 0%, transparent 50%),
        var(--bg-primary);
    }

    .header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-default);
      background: var(--bg-secondary);
      backdrop-filter: blur(8px);
    }

    .header h1 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: 0.02em;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .header h1::before {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--accent-cyan);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent-cyan);
    }

    .stats {
      display: flex;
      gap: 16px;
      margin-top: 8px;
    }

    .stat {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .stat-value {
      color: var(--accent-cyan);
      font-weight: 500;
    }

    .canvas-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    canvas {
      width: 100%;
      height: 100%;
      cursor: grab;
    }

    canvas:active {
      cursor: grabbing;
    }

    .tooltip {
      position: absolute;
      padding: 8px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease;
      max-width: 280px;
      z-index: 1000;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .tooltip.visible {
      opacity: 1;
    }

    .tooltip-name {
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .tooltip-type {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: 3px;
      display: inline-block;
      margin-bottom: 4px;
    }

    .tooltip-path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      color: var(--text-muted);
      word-break: break-all;
    }

    .legend {
      padding: 8px 16px;
      border-top: 1px solid var(--border-default);
      background: var(--bg-secondary);
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: var(--text-secondary);
    }

    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .loading-overlay, .error-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(13, 17, 23, 0.9);
      backdrop-filter: blur(4px);
      z-index: 100;
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent-cyan);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-text, .error-text {
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .error-text {
      color: var(--accent-red);
    }

    .empty-state {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px;
    }

    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.3;
    }

    .empty-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 8px;
    }

    .empty-desc {
      font-size: 12px;
      color: var(--text-secondary);
      max-width: 200px;
      line-height: 1.5;
    }

    .hidden {
      display: none !important;
    }

    .controls {
      position: absolute;
      bottom: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .control-btn {
      width: 28px;
      height: 28px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: all 0.15s ease;
    }

    .control-btn:hover {
      background: var(--bg-secondary);
      color: var(--text-primary);
      border-color: var(--accent-cyan);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Code Graph</h1>
      <div class="stats">
        <span class="stat">Nodes: <span class="stat-value" id="nodeCount">0</span></span>
        <span class="stat">Edges: <span class="stat-value" id="edgeCount">0</span></span>
      </div>
    </div>
    
    <div class="canvas-container">
      <canvas id="graph"></canvas>
      <div class="tooltip" id="tooltip">
        <div class="tooltip-name"></div>
        <div class="tooltip-type"></div>
        <div class="tooltip-path"></div>
      </div>
      
      <div class="loading-overlay hidden" id="loading">
        <div class="loading-spinner"></div>
        <div class="loading-text" id="loadingText">Analyzing code...</div>
      </div>
      
      <div class="error-overlay hidden" id="error">
        <div class="error-text" id="errorText"></div>
      </div>
      
      <div class="empty-state" id="empty">
        <div class="empty-icon">◇</div>
        <div class="empty-title">No Graph Data</div>
        <div class="empty-desc">Run "Visualize All Code" to analyze your codebase and generate the graph.</div>
      </div>

      <div class="controls">
        <button class="control-btn" id="zoomIn" title="Zoom In">+</button>
        <button class="control-btn" id="zoomOut" title="Zoom Out">−</button>
        <button class="control-btn" id="resetView" title="Reset View">⌂</button>
      </div>
    </div>
    
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background: #58a6ff"></div>Function</div>
      <div class="legend-item"><div class="legend-dot" style="background: #a371f7"></div>Class</div>
      <div class="legend-item"><div class="legend-dot" style="background: #3fb950"></div>Component</div>
      <div class="legend-item"><div class="legend-dot" style="background: #f778ba"></div>Hook</div>
      <div class="legend-item"><div class="legend-dot" style="background: #d29922"></div>Interface</div>
      <div class="legend-item"><div class="legend-dot" style="background: #8b949e"></div>Module</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    
    const canvas = document.getElementById('graph');
    const ctx = canvas.getContext('2d');
    const tooltip = document.getElementById('tooltip');
    const loadingEl = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const errorEl = document.getElementById('error');
    const errorText = document.getElementById('errorText');
    const emptyEl = document.getElementById('empty');
    const nodeCountEl = document.getElementById('nodeCount');
    const edgeCountEl = document.getElementById('edgeCount');

    // Graph state
    let nodes = [];
    let edges = [];
    let transform = { x: 0, y: 0, scale: 1 };
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let hoveredNode = null;
    let selectedNode = null;

    // Colors for node types
    const nodeColors = {
      function: '#58a6ff',
      class: '#a371f7',
      method: '#8957e5',
      component: '#3fb950',
      hook: '#f778ba',
      interface: '#d29922',
      type: '#d29922',
      module: '#8b949e',
      endpoint: '#f85149',
      handler: '#f85149',
      middleware: '#db6d28',
      variable: '#6e7681',
      constant: '#79c0ff',
      test: '#a5d6ff',
      other: '#6e7681'
    };

    // Edge colors
    const edgeColors = {
      calls: '#58a6ff',
      imports: '#8b949e',
      exports: '#3fb950',
      extends: '#a371f7',
      implements: '#d29922',
      routes_to: '#f85149',
      depends_on: '#6e7681',
      uses: '#58a6ff',
      defines: '#3fb950',
      references: '#6e7681',
      other: '#484f58'
    };

    function resizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      draw();
    }

    function initializeLayout() {
      // Force-directed layout simulation
      const width = canvas.getBoundingClientRect().width;
      const height = canvas.getBoundingClientRect().height;
      
      // Initialize random positions
      nodes.forEach(node => {
        node.x = Math.random() * width * 0.8 + width * 0.1;
        node.y = Math.random() * height * 0.8 + height * 0.1;
        node.vx = 0;
        node.vy = 0;
      });

      // Create node map for edge lookup
      const nodeMap = new Map(nodes.map(n => [n.id, n]));

      // Run simulation
      const iterations = 200;
      const repulsion = 5000;
      const attraction = 0.005;
      const damping = 0.9;
      const centerForce = 0.01;

      for (let iter = 0; iter < iterations; iter++) {
        // Repulsion between all nodes
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[j].x - nodes[i].x;
            const dy = nodes[j].y - nodes[i].y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = repulsion / (dist * dist);
            
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            
            nodes[i].vx -= fx;
            nodes[i].vy -= fy;
            nodes[j].vx += fx;
            nodes[j].vy += fy;
          }
        }

        // Attraction along edges
        edges.forEach(edge => {
          const source = nodeMap.get(edge.source);
          const target = nodeMap.get(edge.target);
          if (!source || !target) return;
          
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          const force = dist * attraction;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          
          source.vx += fx;
          source.vy += fy;
          target.vx -= fx;
          target.vy -= fy;
        });

        // Center force
        const cx = width / 2;
        const cy = height / 2;
        nodes.forEach(node => {
          node.vx += (cx - node.x) * centerForce;
          node.vy += (cy - node.y) * centerForce;
        });

        // Apply velocity with damping
        nodes.forEach(node => {
          node.vx *= damping;
          node.vy *= damping;
          node.x += node.vx;
          node.y += node.vy;
          
          // Keep in bounds
          node.x = Math.max(50, Math.min(width - 50, node.x));
          node.y = Math.max(50, Math.min(height - 50, node.y));
        });
      }

      // Center the view
      resetView();
    }

    function draw() {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      
      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.scale, transform.scale);

      // Draw edges
      edges.forEach(edge => {
        const source = nodes.find(n => n.id === edge.source);
        const target = nodes.find(n => n.id === edge.target);
        if (!source || !target) return;

        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = edgeColors[edge.type] || edgeColors.other;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      // Draw nodes
      nodes.forEach(node => {
        const radius = node.type === 'module' ? 12 : 
                       node.type === 'class' ? 10 : 
                       node.type === 'component' ? 9 : 7;
        const color = nodeColors[node.type] || nodeColors.other;
        const isHovered = hoveredNode === node;
        const isSelected = selectedNode === node;

        // Glow effect for hovered/selected nodes
        if (isHovered || isSelected) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 6, 0, Math.PI * 2);
          ctx.fillStyle = color + '30';
          ctx.fill();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Border
        ctx.strokeStyle = isHovered || isSelected ? '#ffffff' : color + '80';
        ctx.lineWidth = isHovered || isSelected ? 2 : 1;
        ctx.stroke();

        // Label for larger nodes or when zoomed in
        if (transform.scale > 0.8 || node.type === 'module' || node.type === 'class' || node.type === 'component') {
          ctx.font = '10px "Space Grotesk", sans-serif';
          ctx.fillStyle = '#c9d1d9';
          ctx.textAlign = 'center';
          ctx.fillText(node.label, node.x, node.y + radius + 14);
        }
      });

      ctx.restore();
    }

    function getNodeAtPosition(x, y) {
      const canvasX = (x - transform.x) / transform.scale;
      const canvasY = (y - transform.y) / transform.scale;
      
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        const radius = node.type === 'module' ? 12 : 
                       node.type === 'class' ? 10 : 7;
        const dx = canvasX - node.x;
        const dy = canvasY - node.y;
        if (dx * dx + dy * dy < radius * radius) {
          return node;
        }
      }
      return null;
    }

    function showTooltip(node, x, y) {
      const rect = canvas.getBoundingClientRect();
      tooltip.querySelector('.tooltip-name').textContent = node.label;
      tooltip.querySelector('.tooltip-type').textContent = node.type;
      tooltip.querySelector('.tooltip-type').style.color = nodeColors[node.type] || nodeColors.other;
      tooltip.querySelector('.tooltip-path').textContent = node.filePath + ':' + node.line;
      
      let left = x + 10;
      let top = y + 10;
      
      // Keep tooltip in bounds
      const tooltipRect = tooltip.getBoundingClientRect();
      if (left + tooltipRect.width > rect.width) {
        left = x - tooltipRect.width - 10;
      }
      if (top + tooltipRect.height > rect.height) {
        top = y - tooltipRect.height - 10;
      }
      
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.classList.add('visible');
    }

    function hideTooltip() {
      tooltip.classList.remove('visible');
    }

    function resetView() {
      if (nodes.length === 0) return;
      
      const rect = canvas.getBoundingClientRect();
      const minX = Math.min(...nodes.map(n => n.x));
      const maxX = Math.max(...nodes.map(n => n.x));
      const minY = Math.min(...nodes.map(n => n.y));
      const maxY = Math.max(...nodes.map(n => n.y));
      
      const graphWidth = maxX - minX + 100;
      const graphHeight = maxY - minY + 100;
      
      const scaleX = rect.width / graphWidth;
      const scaleY = rect.height / graphHeight;
      transform.scale = Math.min(scaleX, scaleY, 2) * 0.9;
      
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      transform.x = rect.width / 2 - centerX * transform.scale;
      transform.y = rect.height / 2 - centerY * transform.scale;
      
      draw();
    }

    // Event handlers
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (isDragging) {
        transform.x = e.clientX - dragStart.x;
        transform.y = e.clientY - dragStart.y;
        draw();
      } else {
        const node = getNodeAtPosition(x, y);
        if (node !== hoveredNode) {
          hoveredNode = node;
          draw();
          if (node) {
            showTooltip(node, x, y);
            canvas.style.cursor = 'pointer';
          } else {
            hideTooltip();
            canvas.style.cursor = 'grab';
          }
        } else if (node) {
          showTooltip(node, x, y);
        }
      }
    });

    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
    });

    canvas.addEventListener('mouseleave', () => {
      isDragging = false;
      hideTooltip();
    });

    canvas.addEventListener('click', (e) => {
      if (hoveredNode) {
        selectedNode = hoveredNode;
        draw();
        vscode.postMessage({
          type: 'nodeClick',
          filePath: hoveredNode.filePath,
          line: hoveredNode.line
        });
      } else {
        selectedNode = null;
        draw();
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const zoom = e.deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.max(0.1, Math.min(5, transform.scale * zoom));
      
      // Zoom towards mouse position
      transform.x = mouseX - (mouseX - transform.x) * (newScale / transform.scale);
      transform.y = mouseY - (mouseY - transform.y) * (newScale / transform.scale);
      transform.scale = newScale;
      
      draw();
    });

    document.getElementById('zoomIn').addEventListener('click', () => {
      transform.scale = Math.min(5, transform.scale * 1.2);
      draw();
    });

    document.getElementById('zoomOut').addEventListener('click', () => {
      transform.scale = Math.max(0.1, transform.scale / 1.2);
      draw();
    });

    document.getElementById('resetView').addEventListener('click', resetView);

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      
      switch (message.type) {
        case 'updateGraph':
          loadingEl.classList.add('hidden');
          errorEl.classList.add('hidden');
          
          nodes = message.data.nodes || [];
          edges = message.data.edges || [];
          
          nodeCountEl.textContent = nodes.length;
          edgeCountEl.textContent = edges.length;
          
          if (nodes.length === 0) {
            emptyEl.classList.remove('hidden');
          } else {
            emptyEl.classList.add('hidden');
            initializeLayout();
          }
          break;
          
        case 'loading':
          loadingEl.classList.remove('hidden');
          errorEl.classList.add('hidden');
          emptyEl.classList.add('hidden');
          loadingText.textContent = message.message;
          break;
          
        case 'error':
          loadingEl.classList.add('hidden');
          errorEl.classList.remove('hidden');
          errorText.textContent = message.message;
          break;
      }
    });

    // Initialize
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
    
    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
