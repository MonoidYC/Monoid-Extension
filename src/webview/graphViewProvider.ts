import * as vscode from 'vscode';
import type { AnalysisResult, LocalNode, LocalEdge } from '../types';
import { readLocalGraph, writeLocalGraph } from '../utils/localGraph';

const DEFAULT_DASHBOARD_URL = 'https://monoid-dashboard.vercel.app';

const NODE_TYPE_COLORS: Record<string, string> = {
  function: '#3b82f6',
  method: '#3b82f6',
  class: '#8b5cf6',
  component: '#ec4899',
  endpoint: '#10b981',
  handler: '#f59e0b',
  middleware: '#f59e0b',
  hook: '#06b6d4',
  module: '#6366f1',
  variable: '#64748b',
  type: '#6b7280',
  interface: '#6b7280',
  constant: '#64748b',
  test: '#9ca3af',
  other: '#9ca3af',
};

const CLUSTER_COLORS: Record<string, string> = {
  frontend: '#ec4899',
  backend: '#10b981',
  shared: '#8b5cf6',
  unknown: '#6b7280',
};

const CLUSTER_OPTIONS = ['frontend', 'backend', 'shared', 'unknown'] as const;

function detectCluster(filePath: string): 'frontend' | 'backend' | 'shared' | 'unknown' {
  const path = '/' + (filePath || '').toLowerCase().replace(/^\/+/, '');
  if (
    path.includes('/components/') ||
    path.includes('/pages/') ||
    path.includes('/hooks/') ||
    path.includes('/ui/') ||
    path.includes('/views/') ||
    path.endsWith('.tsx') ||
    path.endsWith('.jsx')
  ) {
    if (path.includes('/api/')) {
      return 'backend';
    }
    return 'frontend';
  }
  if (path.includes('/app/')) {
    if (path.includes('/api/')) {
      return 'backend';
    }
    return 'frontend';
  }
  if (
    path.includes('/api/') ||
    path.includes('/server/') ||
    path.includes('/services/') ||
    path.includes('/controllers/') ||
    path.includes('/routes/') ||
    path.includes('/middleware/') ||
    path.includes('/db/') ||
    path.includes('/database/')
  ) {
    return 'backend';
  }
  if (
    path.includes('/types/') ||
    path.includes('/schemas/') ||
    path.includes('/constants/') ||
    path.includes('/utils/') ||
    path.includes('/lib/') ||
    path.includes('/shared/') ||
    path.includes('/common/')
  ) {
    return 'shared';
  }
  return 'unknown';
}

/**
 * Opens a webview panel that renders the graph from local .monoid/graph.json (no auth, no iframe).
 */
export class GraphPanelManager {
  private static panel: vscode.WebviewPanel | undefined;
  private static currentGraphData: AnalysisResult | null = null;

  static openPanel(
    extensionUri: vscode.Uri,
    workspaceSlug: string,
    repoSlug: string,
    graphData?: AnalysisResult | null
  ): void {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const dashboardUrl = config.get<string>('webAppUrl') || DEFAULT_DASHBOARD_URL;

    const data = graphData ?? null;
    const hadData = this.currentGraphData !== null;
    this.currentGraphData = data;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.webview.html = this.getWebviewContent(dashboardUrl, workspaceSlug, repoSlug, data);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'monoid-visualize.graphPanel',
      '🔮 Monoid Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    this.panel.webview.html = this.getWebviewContent(dashboardUrl, workspaceSlug, repoSlug, data);

    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'openFile':
          await this.openFile(message.filePath, message.line);
          break;
        case 'refresh':
          vscode.commands.executeCommand('monoid-visualize.visualizeAllCode');
          break;
        case 'pushToSupabase':
          await vscode.commands.executeCommand('monoid-visualize.pushToSupabase');
          break;
        case 'saveGraph':
          if (message.nodes && message.edges) {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
              await writeLocalGraph(workspaceFolder, { nodes: message.nodes, edges: message.edges });
            }
          }
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.currentGraphData = null;
    });
  }

  static updateGraphData(graphData: AnalysisResult | null): void {
    this.currentGraphData = graphData;
    if (this.panel) {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const dashboardUrl = config.get<string>('webAppUrl') || DEFAULT_DASHBOARD_URL;
      const workspaceSlug = '';
      const repoSlug = '';
      this.panel.webview.html = this.getWebviewContent(dashboardUrl, workspaceSlug, repoSlug, graphData);
    }
  }

  static refreshPanel(): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'refresh' });
    }
  }

  static showLoading(message: string): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'loading', message });
    }
  }

  private static async openFile(filePath: string, line: number): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }
    try {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      console.error('Could not open file:', err);
    }
  }

  private static getWebviewContent(
    dashboardUrl: string,
    workspaceSlug: string,
    repoSlug: string,
    graphData: AnalysisResult | null
  ): string {
    const hasGraph = graphData && graphData.nodes.length > 0;
    const graphJson = hasGraph
      ? JSON.stringify({ nodes: graphData!.nodes, edges: graphData!.edges }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
      : 'null';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Monoid Graph</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #08080a; }
    .container { display: flex; flex-direction: column; height: 100%; }
    .toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 16px; background: #0c0c0e; border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-shrink: 0;
    }
    .toolbar-left { display: flex; align-items: center; gap: 12px; }
    .toolbar-title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; font-weight: 600; color: #e5e5e5;
      display: flex; align-items: center; gap: 8px;
    }
    .toolbar-title::before {
      content: ''; width: 8px; height: 8px;
      background: linear-gradient(135deg, #a78bfa, #8b5cf6);
      border-radius: 50%; box-shadow: 0 0 8px rgba(167,139,250,0.5);
    }
    .toolbar-info {
      font-family: 'SF Mono', Monaco, monospace; font-size: 11px; color: #6b7280;
      padding: 4px 8px; background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.05); border-radius: 4px;
    }
    .toolbar-actions { display: flex; gap: 8px; }
    .btn {
      padding: 6px 12px; font-size: 12px; font-weight: 500; color: #e5e5e5;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; cursor: pointer; transition: all 0.15s ease;
    }
    .btn:hover { background: rgba(255,255,255,0.08); border-color: rgba(167,139,250,0.3); }
    .btn-primary {
      background: linear-gradient(135deg, rgba(167,139,250,0.2), rgba(139,92,246,0.2));
      border-color: rgba(167,139,250,0.3);
    }
    .graph-container { flex: 1; position: relative; overflow: hidden; }
    #graphSvg { width: 100%; height: 100%; display: block; cursor: grab; }
    #graphSvg.panning { cursor: grabbing; }
    .empty-state {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; background: #08080a;
      text-align: center; padding: 40px;
    }
    .empty-state.hidden { display: none; }
    .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-title { font-size: 18px; font-weight: 600; color: #e5e5e5; margin-bottom: 8px; }
    .empty-desc { font-size: 14px; color: #6b7280; max-width: 400px; line-height: 1.5; margin-bottom: 24px; }
    .loading-overlay {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; background: rgba(8,8,10,0.95);
      z-index: 100; opacity: 0; pointer-events: none; transition: opacity 0.2s;
    }
    .loading-overlay.visible { opacity: 1; pointer-events: all; }
    .loading-spinner {
      width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #a78bfa; border-radius: 50%; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { margin-top: 16px; font-size: 13px; color: #6b7280; }
    .node-label { font-size: 10px; fill: #e5e5e5; pointer-events: none; text-anchor: middle; user-select: none; }
    .btn.connect-active { background: rgba(167,139,250,0.3); border-color: #a78bfa; }
    .node-connect-source { stroke: #a78bfa; stroke-width: 3; }
    .detail-panel {
      position: absolute; top: 8px; right: 8px; bottom: 8px; width: 280px; z-index: 20;
      background: #0c0c0e; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
      display: none; flex-direction: column; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .detail-panel.visible { display: flex; }
    .detail-panel .panel-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
    .detail-panel .panel-title { font-size: 14px; font-weight: 600; color: #e5e5e5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-panel .panel-close { padding: 4px; cursor: pointer; color: #6b7280; background: none; border: none; border-radius: 4px; }
    .detail-panel .panel-close:hover { color: #e5e5e5; background: rgba(255,255,255,0.05); }
    .detail-panel .panel-body { flex: 1; overflow-y: auto; padding: 12px 14px; font-size: 12px; }
    .detail-panel .panel-field { margin-bottom: 12px; }
    .detail-panel .panel-field label { display: block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 4px; }
    .detail-panel .panel-field .value { color: #e5e5e5; font-family: monospace; font-size: 11px; }
    .detail-panel select.cluster-select {
      width: 100%; padding: 6px 8px; font-size: 12px; color: #e5e5e5;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; cursor: pointer;
    }
    .detail-panel .panel-footer { padding: 12px 14px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; gap: 8px; flex-shrink: 0; }
    .detail-panel .btn-open-file { flex: 1; }
  </style>
</head>
<body>
  <div class="container">
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">Monoid Graph</span>
        <span class="toolbar-info">${workspaceSlug || 'local'}${repoSlug ? '/' + repoSlug : ''}</span>
        ${hasGraph ? `<span class="toolbar-info" style="color:#a78bfa;">${graphData!.nodes.length} nodes, ${graphData!.edges.length} edges</span>` : ''}
      </div>
      <div class="toolbar-actions">
        <button class="btn" id="connectBtn" title="Add edge: click source node, then target node">⊕ Connect</button>
        <button class="btn btn-primary" id="analyzeBtn" title="Re-analyze codebase">↻ Analyze</button>
        <button class="btn" id="pushBtn" title="Push local graph to cloud">↑ Push</button>
      </div>
    </div>
    <div class="graph-container">
      <div class="loading-overlay" id="loading">
        <div class="loading-spinner"></div>
        <div class="loading-text" id="loadingText">Loading...</div>
      </div>
      <div class="empty-state ${hasGraph ? 'hidden' : ''}" id="emptyState">
        <div class="empty-icon">🔮</div>
        <div class="empty-title">No Graph Yet</div>
        <div class="empty-desc">Run "Visualize All Code" to analyze your codebase and generate a graph. Data is saved to .monoid/graph.json (no sign-in required).</div>
        <button class="btn btn-primary" id="analyzeBtnEmpty">✨ Visualize All Code</button>
      </div>
      ${hasGraph ? `<div class="detail-panel" id="detailPanel">
        <div class="panel-header">
          <span class="panel-title" id="detailPanelTitle">Node</span>
          <button class="panel-close" id="detailPanelClose" title="Close">✕</button>
        </div>
        <div class="panel-body">
          <div class="panel-field">
            <label>Location</label>
            <div class="value" id="detailPanelLocation">—</div>
          </div>
          <div class="panel-field">
            <label>Cluster</label>
            <select class="cluster-select" id="detailPanelCluster">
              ${CLUSTER_OPTIONS.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="panel-footer">
          <button class="btn btn-open-file" id="detailPanelOpenFile">Open file</button>
        </div>
      </div>` : ''}
      ${hasGraph ? '<svg id="graphSvg" viewBox="0 0 1200 800"></svg>' : ''}
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const graphData = ${graphJson};
    const CLUSTER_COLORS = ${JSON.stringify(CLUSTER_COLORS)};
    function detectCluster(filePath) {
      var path = '/' + (filePath || '').toLowerCase().replace(/^\\/+/, '');
      if (path.indexOf('/components/') !== -1 || path.indexOf('/pages/') !== -1 || path.indexOf('/hooks/') !== -1 || path.indexOf('/ui/') !== -1 || path.indexOf('/views/') !== -1 || path.endsWith('.tsx') || path.endsWith('.jsx')) {
        if (path.indexOf('/api/') !== -1) return 'backend';
        return 'frontend';
      }
      if (path.indexOf('/app/') !== -1) {
        if (path.indexOf('/api/') !== -1) return 'backend';
        return 'frontend';
      }
      if (path.indexOf('/api/') !== -1 || path.indexOf('/server/') !== -1 || path.indexOf('/services/') !== -1 || path.indexOf('/controllers/') !== -1 || path.indexOf('/routes/') !== -1 || path.indexOf('/middleware/') !== -1 || path.indexOf('/db/') !== -1 || path.indexOf('/database/') !== -1) return 'backend';
      if (path.indexOf('/types/') !== -1 || path.indexOf('/schemas/') !== -1 || path.indexOf('/constants/') !== -1 || path.indexOf('/utils/') !== -1 || path.indexOf('/lib/') !== -1 || path.indexOf('/shared/') !== -1 || path.indexOf('/common/') !== -1) return 'shared';
      return 'unknown';
    }
    const loadingEl = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const emptyState = document.getElementById('emptyState');
    
    function showLoading(msg) {
      if (loadingEl) { loadingEl.classList.add('visible'); loadingEl.style.pointerEvents = 'all'; }
      if (loadingText) loadingText.textContent = msg || 'Loading...';
    }
    function hideLoading() {
      if (loadingEl) { loadingEl.classList.remove('visible'); loadingEl.style.pointerEvents = 'none'; }
    }

    document.getElementById('analyzeBtn')?.addEventListener('click', () => {
      showLoading('Analyzing codebase...');
      emptyState?.classList.add('hidden');
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('analyzeBtnEmpty')?.addEventListener('click', () => {
      showLoading('Analyzing codebase...');
      emptyState?.classList.add('hidden');
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('pushBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'pushToSupabase' });
    });

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d.type === 'loading') {
        if (d.message) { showLoading(d.message); emptyState?.classList.add('hidden'); }
        else { hideLoading(); }
      }
    });

    if (graphData && graphData.nodes && graphData.nodes.length > 0) {
      (function() {
        const svg = document.getElementById('graphSvg');
        if (!svg) return;
        const NS = 'http://www.w3.org/2000/svg';
        const nodes = graphData.nodes.map(n => ({
          id: n.stable_id,
          name: n.name,
          node_type: n.node_type || 'other',
          file_path: n.file_path,
          start_line: n.start_line,
          cluster: n.cluster || detectCluster(n.file_path),
          x: Math.random() * 800 + 200,
          y: Math.random() * 500 + 150,
          vx: 0, vy: 0
        }));
        const nodeById = {};
        nodes.forEach(n => { nodeById[n.id] = n; });
        const edges = (graphData.edges || []).filter(e => nodeById[e.source_stable_id] && nodeById[e.target_stable_id]);

        var connectMode = false;
        var connectSource = null;

        const width = 1200, height = 800;
        const charge = -80, linkDistance = 120, alpha = 0.3;
        const minZoom = 0.15, maxZoom = 4;

        function step() {
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            n.vx *= 0.9; n.vy *= 0.9;
            for (let j = i + 1; j < nodes.length; j++) {
              const m = nodes[j];
              const dx = n.x - m.x, dy = n.y - m.y;
              const d = Math.sqrt(dx*dx + dy*dy) || 0.1;
              const f = charge / (d * d);
              const fx = (dx/d) * f; const fy = (dy/d) * f;
              n.vx += fx; n.vy += fy; m.vx -= fx; m.vy -= fy;
            }
          }
          edges.forEach(e => {
            const a = nodeById[e.source_stable_id];
            const b = nodeById[e.target_stable_id];
            if (!a || !b) return;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx*dx + dy*dy) || 0.1;
            const k = (d - linkDistance) * alpha / d;
            const fx = dx * k; const fy = dy * k;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          });
          nodes.forEach(n => {
            n.x += n.vx; n.y += n.vy;
            n.x = Math.max(30, Math.min(width - 30, n.x));
            n.y = Math.max(30, Math.min(height - 30, n.y));
          });
        }
        for (let i = 0; i < 80; i++) step();

        function screenToGraph(clientX, clientY) {
          var pt = svg.createSVGPoint();
          pt.x = clientX;
          pt.y = clientY;
          var m = svg.getScreenCTM();
          if (!m) return { x: 0, y: 0 };
          var inv = m.inverse();
          var p = pt.matrixTransform(inv);
          // p is in SVG viewBox coords; graph is inside zoomPan with translate(tx,ty) scale(scale)
          // so graph coords: gx = (p.x - tx) / scale, gy = (p.y - ty) / scale
          return { x: (p.x - tx) / scale, y: (p.y - ty) / scale };
        }

        var tx = 0, ty = 0, scale = 1;
        var isPanning = false, panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;
        var draggedNode = null, dragOffsetX = 0, dragOffsetY = 0, didDrag = false;

        var zoomPan = document.createElementNS(NS, 'g');
        zoomPan.id = 'zoom-pan-group';
        function applyTransform() {
          zoomPan.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + scale + ')');
        }
        applyTransform();

        var edgesGroup = document.createElementNS(NS, 'g');
        zoomPan.appendChild(edgesGroup);
        var lineEls = [];
        edges.forEach(e => {
          var line = document.createElementNS(NS, 'line');
          line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
          line.setAttribute('stroke-width', '1');
          line.setAttribute('data-source', e.source_stable_id);
          line.setAttribute('data-target', e.target_stable_id);
          edgesGroup.appendChild(line);
          lineEls.push(line);
        });

        function redrawEdges() {
          edges.forEach((e, i) => {
            var a = nodeById[e.source_stable_id];
            var b = nodeById[e.target_stable_id];
            var line = lineEls[i];
            if (!a || !b || !line) return;
            line.setAttribute('x1', a.x);
            line.setAttribute('y1', a.y);
            line.setAttribute('x2', b.x);
            line.setAttribute('y2', b.y);
          });
        }
        redrawEdges();

        const NODE_COLORS = ${JSON.stringify(NODE_TYPE_COLORS)};
        var nodesGroup = document.createElementNS(NS, 'g');
        zoomPan.appendChild(nodesGroup);
        var nodeCircles = {};
        var nodeLabels = {};
        nodes.forEach(n => {
          var color = CLUSTER_COLORS[n.cluster] || CLUSTER_COLORS.unknown || '#6b7280';
          var circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('r', '14');
          circle.setAttribute('fill', color);
          circle.setAttribute('stroke', 'rgba(255,255,255,0.3)');
          circle.setAttribute('stroke-width', '1');
          circle.setAttribute('data-id', n.id);
          circle.style.cursor = 'grab';
          nodeCircles[n.id] = circle;
          nodesGroup.appendChild(circle);
          var label = document.createElementNS(NS, 'text');
          label.setAttribute('class', 'node-label');
          label.textContent = n.name.length > 16 ? n.name.slice(0, 14) + '…' : n.name;
          nodeLabels[n.id] = label;
          nodesGroup.appendChild(label);
        });

        function redrawNodes() {
          nodes.forEach(n => {
            var c = nodeCircles[n.id];
            var l = nodeLabels[n.id];
            if (c) { c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); }
            if (l) { l.setAttribute('x', n.x); l.setAttribute('y', n.y + 28); }
          });
        }
        redrawNodes();

        function hitNode(gx, gy) {
          for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var dx = gx - n.x, dy = gy - n.y;
            if (dx*dx + dy*dy <= 14*14) return n;
          }
          return null;
        }

        function clearConnectSource() {
          if (connectSource) {
            nodeCircles[connectSource.id].classList.remove('node-connect-source');
            connectSource = null;
          }
        }

        function addEdge(sourceId, targetId) {
          if (sourceId === targetId) return;
          var exists = edges.some(function(e) { return e.source_stable_id === sourceId && e.target_stable_id === targetId; });
          if (exists) return;
          var newEdge = { source_stable_id: sourceId, target_stable_id: targetId, edge_type: 'depends_on' };
          edges.push(newEdge);
          var line = document.createElementNS(NS, 'line');
          line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
          line.setAttribute('stroke-width', '1');
          line.setAttribute('data-source', sourceId);
          line.setAttribute('data-target', targetId);
          edgesGroup.appendChild(line);
          lineEls.push(line);
          redrawEdges();
          vscode.postMessage({ type: 'saveGraph', nodes: graphData.nodes, edges: edges });
        }

        function onPointerDown(evt) {
          if (evt.button !== 0 && evt.button !== 1) return;
          var g = screenToGraph(evt.clientX, evt.clientY);
          var node = hitNode(g.x, g.y);

          if (connectMode && node && evt.button === 0) {
            evt.preventDefault();
            if (!connectSource) {
              connectSource = node;
              nodeCircles[node.id].classList.add('node-connect-source');
            } else if (node.id === connectSource.id) {
              clearConnectSource();
            } else {
              addEdge(connectSource.id, node.id);
              clearConnectSource();
              connectMode = false;
              var connectBtn = document.getElementById('connectBtn');
              if (connectBtn) connectBtn.classList.remove('connect-active');
            }
            return;
          }

          if (node && evt.button === 0) {
            evt.preventDefault();
            draggedNode = node;
            dragOffsetX = g.x - node.x;
            dragOffsetY = g.y - node.y;
            didDrag = false;
            nodeCircles[node.id].style.cursor = 'grabbing';
          } else {
            if (connectMode) { clearConnectSource(); }
            isPanning = true;
            svg.classList.add('panning');
            panStartX = evt.clientX;
            panStartY = evt.clientY;
            panStartTx = tx;
            panStartTy = ty;
          }
        }

        function onPointerMove(evt) {
          if (draggedNode) {
            var g = screenToGraph(evt.clientX, evt.clientY);
            draggedNode.x = g.x - dragOffsetX;
            draggedNode.y = g.y - dragOffsetY;
            didDrag = true;
            redrawEdges();
            redrawNodes();
          } else if (isPanning) {
            tx = panStartTx + (evt.clientX - panStartX);
            ty = panStartTy + (evt.clientY - panStartY);
            applyTransform();
          }
        }

        var selectedNode = null;
        var detailPanel = document.getElementById('detailPanel');
        var detailPanelTitle = document.getElementById('detailPanelTitle');
        var detailPanelLocation = document.getElementById('detailPanelLocation');
        var detailPanelCluster = document.getElementById('detailPanelCluster');
        var detailPanelClose = document.getElementById('detailPanelClose');
        var detailPanelOpenFile = document.getElementById('detailPanelOpenFile');

        function showDetailPanel(node) {
          selectedNode = node;
          if (detailPanel && detailPanelTitle && detailPanelLocation && detailPanelCluster) {
            detailPanelTitle.textContent = node.name;
            detailPanelLocation.textContent = (node.file_path || '').split('/').pop() + ':' + (node.start_line || 0);
            detailPanelCluster.value = node.cluster || 'unknown';
            detailPanel.classList.add('visible');
          }
        }
        function hideDetailPanel() {
          selectedNode = null;
          if (detailPanel) detailPanel.classList.remove('visible');
        }
        function onClusterChange(newCluster) {
          if (!selectedNode) return;
          var n = nodeById[selectedNode.id];
          if (n) n.cluster = newCluster;
          var rawIdx = graphData.nodes.findIndex(function(r) { return r.stable_id === selectedNode.id; });
          if (rawIdx >= 0) graphData.nodes[rawIdx].cluster = newCluster;
          var circle = nodeCircles[selectedNode.id];
          if (circle) circle.setAttribute('fill', CLUSTER_COLORS[newCluster] || CLUSTER_COLORS.unknown);
          detailPanelCluster.value = newCluster;
          vscode.postMessage({ type: 'saveGraph', nodes: graphData.nodes, edges: edges });
        }
        if (detailPanelClose) detailPanelClose.onclick = hideDetailPanel;
        if (detailPanelOpenFile) detailPanelOpenFile.onclick = function() {
          if (selectedNode) {
            vscode.postMessage({ type: 'openFile', filePath: selectedNode.file_path, line: selectedNode.start_line });
          }
        };
        if (detailPanelCluster) detailPanelCluster.onchange = function() {
          onClusterChange(detailPanelCluster.value);
        };

        function onPointerUp(evt) {
          if (draggedNode) {
            nodeCircles[draggedNode.id].style.cursor = 'grab';
            if (!didDrag) {
              showDetailPanel(draggedNode);
            }
            draggedNode = null;
          }
          isPanning = false;
          svg.classList.remove('panning');
        }

        document.getElementById('connectBtn')?.addEventListener('click', function() {
          connectMode = !connectMode;
          if (!connectMode) { clearConnectSource(); }
          var connectBtn = document.getElementById('connectBtn');
          if (connectBtn) connectBtn.classList.toggle('connect-active', connectMode);
        });

        svg.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        svg.addEventListener('wheel', function(evt) {
          evt.preventDefault();
          var g = screenToGraph(evt.clientX, evt.clientY);
          var factor = evt.deltaY > 0 ? 0.9 : 1.1;
          var sNew = Math.max(minZoom, Math.min(maxZoom, scale * factor));
          tx = tx + g.x * (scale - sNew);
          ty = ty + g.y * (scale - sNew);
          scale = sNew;
          applyTransform();
        }, { passive: false });

        var pinchStartDist = 0, pinchStartScale = 1, pinchStartTx = 0, pinchStartTy = 0, pinchCenter = { x: 0, y: 0 };
        function getTouchCenter(touches) {
          var x = 0, y = 0;
          for (var i = 0; i < touches.length; i++) { x += touches[i].clientX; y += touches[i].clientY; }
          return { x: x / touches.length, y: y / touches.length };
        }
        function getTouchDist(touches) {
          if (touches.length < 2) return 0;
          var dx = touches[1].clientX - touches[0].clientX;
          var dy = touches[1].clientY - touches[0].clientY;
          return Math.sqrt(dx*dx + dy*dy);
        }
        svg.addEventListener('touchstart', function(evt) {
          if (evt.touches.length === 2) {
            evt.preventDefault();
            pinchStartDist = getTouchDist(evt.touches);
            pinchStartScale = scale;
            pinchStartTx = tx;
            pinchStartTy = ty;
            pinchCenter = getTouchCenter(evt.touches);
          }
        }, { passive: false });
        svg.addEventListener('touchmove', function(evt) {
          if (evt.touches.length === 2 && pinchStartDist > 0) {
            evt.preventDefault();
            var d = getTouchDist(evt.touches);
            var sNew = Math.max(minZoom, Math.min(maxZoom, pinchStartScale * (d / pinchStartDist)));
            var c = getTouchCenter(evt.touches);
            var g = screenToGraph(c.x, c.y);
            tx = pinchStartTx + (c.x - pinchCenter.x);
            ty = pinchStartTy + (c.y - pinchCenter.y);
            scale = sNew;
            applyTransform();
          }
        }, { passive: false });
        svg.addEventListener('touchend', function(evt) {
          if (evt.touches.length < 2) pinchStartDist = 0;
        });

        svg.appendChild(zoomPan);
        hideLoading();
      })();
    } else {
      hideLoading();
    }
  </script>
</body>
</html>`;
  }
}

// Sidebar node type colors (match dashboard CodeNode)
const SIDEBAR_NODE_COLORS: Record<string, string> = {
  function: '#3b82f6',
  method: '#3b82f6',
  class: '#8b5cf6',
  component: '#ec4899',
  endpoint: '#10b981',
  handler: '#f59e0b',
  middleware: '#f59e0b',
  hook: '#06b6d4',
  module: '#6366f1',
  variable: '#64748b',
  type: '#6b7280',
  interface: '#6b7280',
  constant: '#64748b',
  test: '#9ca3af',
  other: '#9ca3af',
};

export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'monoid-visualize.graphView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this.getSidebarHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'openPanel') {
        await vscode.commands.executeCommand('monoid-visualize.openGraphPanel');
      } else if (message.type === 'getGraphData') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          const data = await readLocalGraph(workspaceFolder);
          webviewView.webview.postMessage({ type: 'graphData', data });
        } else {
          webviewView.webview.postMessage({ type: 'graphData', data: null });
        }
      } else if (message.type === 'openFile' && message.filePath !== undefined && message.line !== undefined) {
        await this.openFile(message.filePath, message.line);
      } else if (
        message.type === 'updateNodeCluster' &&
        message.nodeId !== undefined &&
        message.nodeId !== null &&
        message.cluster !== undefined &&
        message.cluster !== null &&
        ['frontend', 'backend', 'shared', 'unknown'].includes(message.cluster)
      ) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          const data = await readLocalGraph(workspaceFolder);
          if (data?.nodes) {
            const node = data.nodes.find((n) => n.stable_id === message.nodeId);
            if (node) {
              node.cluster = message.cluster as LocalNode['cluster'];
              await writeLocalGraph(workspaceFolder, { nodes: data.nodes, edges: data.edges });
              webviewView.webview.postMessage({
                type: 'graphData',
                data: { nodes: data.nodes, edges: data.edges },
              });
              GraphPanelManager.updateGraphData({ nodes: data.nodes, edges: data.edges });
            }
          }
        }
      }
    });
  }

  private async openFile(filePath: string, line: number): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }
    try {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      console.error('Could not open file:', err);
    }
  }

  private getSidebarHtml(): string {
    const nodeColorsJson = JSON.stringify(SIDEBAR_NODE_COLORS);
    const clusterColorsJson = JSON.stringify(CLUSTER_COLORS);
    const clusterOptions = ['frontend', 'backend', 'shared', 'unknown'];
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 12px; color: #e5e5e5; background: #08080a; font-size: 12px; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
    .title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .title::before { content: ''; width: 6px; height: 6px; background: linear-gradient(135deg, #a78bfa, #8b5cf6); border-radius: 50%; }
    .btn { padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(167,139,250,0.3); background: linear-gradient(135deg, rgba(167,139,250,0.2), rgba(139,92,246,0.2)); color: #e5e5e5; cursor: pointer; font-size: 11px; font-weight: 500; }
    .btn:hover { background: linear-gradient(135deg, rgba(167,139,250,0.3), rgba(139,92,246,0.3)); border-color: rgba(167,139,250,0.5); }
    .node-list { display: flex; flex-direction: column; gap: 10px; }
    .node-card { border-radius: 10px; border: 1px solid; padding: 10px 12px; cursor: pointer; transition: all 0.15s ease; min-width: 0; }
    .node-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .node-summary { font-size: 11px; color: rgba(255,255,255,0.8); line-height: 1.4; margin-bottom: 8px; font-weight: 300; }
    .node-divider { height: 1px; background: rgba(255,255,255,0.06); margin-bottom: 8px; }
    .node-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .node-type-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    .node-name { font-weight: 500; color: rgba(255,255,255,0.9); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-type-badge { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; }
    .node-footer { font-size: 10px; color: #6b7280; margin-top: 6px; padding-left: 16px; }
    .node-cluster { margin-top: 8px; }
    .node-cluster label { display: block; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 4px; }
    .node-cluster select { width: 100%; padding: 4px 6px; font-size: 11px; color: #e5e5e5; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; cursor: pointer; }
    .empty { color: #6b7280; font-size: 12px; padding: 16px 0; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <span class="title">Code Graph</span>
    <button class="btn" id="openPanelBtn">Open Panel</button>
  </div>
  <div id="nodeList" class="node-list"></div>
  <div id="emptyState" class="empty" style="display:none;">Run &quot;Visualize All Code&quot; to generate a graph.</div>
  <script>
    const vscode = acquireVsCodeApi();
    const NODE_COLORS = ${nodeColorsJson};
    const CLUSTER_COLORS = ${clusterColorsJson};

    function openPanel() { vscode.postMessage({ type: 'openPanel' }); }
    document.getElementById('openPanelBtn').onclick = openPanel;

    function detectCluster(filePath) {
      if (!filePath) return 'unknown';
      var path = '/' + String(filePath).toLowerCase().replace(/^\\/+/, '');
      if (path.indexOf('/components/') !== -1 || path.indexOf('/pages/') !== -1 || path.indexOf('/hooks/') !== -1 || path.indexOf('/ui/') !== -1 || path.indexOf('/views/') !== -1 || path.endsWith('.tsx') || path.endsWith('.jsx')) {
        if (path.indexOf('/api/') !== -1) return 'backend';
        return 'frontend';
      }
      if (path.indexOf('/app/') !== -1) {
        if (path.indexOf('/api/') !== -1) return 'backend';
        return 'frontend';
      }
      if (path.indexOf('/api/') !== -1 || path.indexOf('/server/') !== -1 || path.indexOf('/services/') !== -1 || path.indexOf('/controllers/') !== -1 || path.indexOf('/routes/') !== -1 || path.indexOf('/middleware/') !== -1 || path.indexOf('/db/') !== -1 || path.indexOf('/database/') !== -1) return 'backend';
      if (path.indexOf('/types/') !== -1 || path.indexOf('/schemas/') !== -1 || path.indexOf('/constants/') !== -1 || path.indexOf('/utils/') !== -1 || path.indexOf('/lib/') !== -1 || path.indexOf('/shared/') !== -1 || path.indexOf('/common/') !== -1) return 'shared';
      return 'unknown';
    }
    var CLUSTER_OPTIONS = ${JSON.stringify(clusterOptions)};
    function renderNodes(data) {
      const list = document.getElementById('nodeList');
      const empty = document.getElementById('emptyState');
      if (!data || !data.nodes || data.nodes.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      list.innerHTML = data.nodes.map(function(n) {
        var typeColor = NODE_COLORS[n.node_type] || '#9ca3af';
        var cluster = n.cluster || detectCluster(n.file_path);
        var clusterColor = CLUSTER_COLORS[cluster] || CLUSTER_COLORS.unknown || '#6b7280';
        var summary = n.summary ? '<p class="node-summary">' + escapeHtml(n.summary) + '</p><div class="node-divider"></div>' : '';
        var fileLine = (n.file_path || '').split('/').pop() + ':' + (n.start_line || 0);
        var optionsHtml = CLUSTER_OPTIONS.map(function(c) {
          return '<option value="' + c + '"' + (c === cluster ? ' selected' : '') + '>' + c + '</option>';
        }).join('');
        return '<div class="node-card" data-file="' + escapeAttr(n.file_path) + '" data-line="' + (n.start_line || 0) + '" data-node-id="' + escapeAttr(n.stable_id) + '" style="border-color:' + clusterColor + '40;background:' + clusterColor + '12;">' +
          summary +
          '<div class="node-header">' +
            '<span class="node-type-dot" style="background:' + typeColor + '"></span>' +
            '<span class="node-name" title="' + escapeAttr(n.name) + '">' + escapeHtml(n.name) + '</span>' +
            '<span class="node-type-badge" style="color:' + typeColor + ';background:' + typeColor + '25">' + (n.node_type || 'other') + '</span>' +
          '</div>' +
          '<div class="node-footer">' + escapeHtml(fileLine) + '</div>' +
          '<div class="node-cluster"><label>Cluster</label><select class="node-cluster-select">' + optionsHtml + '</select></div>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.node-card').forEach(function(el) {
        var card = el;
        var file = card.getAttribute('data-file');
        var line = parseInt(card.getAttribute('data-line') || '1', 10);
        var nodeId = card.getAttribute('data-node-id');
        card.onclick = function(evt) {
          if (evt.target && evt.target.classList && evt.target.classList.contains('node-cluster-select')) return;
          if (file) vscode.postMessage({ type: 'openFile', filePath: file, line: line });
        };
        var sel = card.querySelector('.node-cluster-select');
        if (sel && nodeId) {
          sel.onclick = function(e) { e.stopPropagation(); };
          sel.onchange = function(e) {
            e.stopPropagation();
            var cluster = sel.value;
            if (cluster) vscode.postMessage({ type: 'updateNodeCluster', nodeId: nodeId, cluster: cluster });
          };
        }
      });
    }
    function escapeHtml(s) {
      if (s === null || s === undefined) return '';
      var div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }
    function escapeAttr(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    vscode.postMessage({ type: 'getGraphData' });
    window.addEventListener('message', function(e) {
      var d = e.data;
      if (d.type === 'graphData') renderNodes(d.data);
    });
  </script>
</body>
</html>`;
  }

  public updateGraph(_data: unknown) {}
  public showLoading(_message: string) {}
  public showError(_message: string) {}
}
