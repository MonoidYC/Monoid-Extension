import * as vscode from 'vscode';

// Default dashboard URL
const DEFAULT_DASHBOARD_URL = 'https://monoid-dashboard.vercel.app';

/**
 * Opens a webview panel (full editor tab) that embeds the Monoid dashboard
 */
export class GraphPanelManager {
  private static panel: vscode.WebviewPanel | undefined;
  private static currentVersionId: string | undefined;

  /**
   * Opens or focuses the graph panel
   */
  static openPanel(
    extensionUri: vscode.Uri,
    workspaceSlug: string,
    repoSlug: string,
    versionId?: string
  ): void {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const dashboardUrl = config.get<string>('webAppUrl') || DEFAULT_DASHBOARD_URL;
    const graphUrl = versionId ? `${dashboardUrl}/graph/${versionId}` : dashboardUrl;

    // Log webview details
    console.log('[Monoid WebView] Opening panel:');
    console.log(`  Dashboard Base URL: ${dashboardUrl}`);
    console.log(`  Full Graph URL: ${graphUrl}`);
    console.log(`  Version ID: ${versionId || '(none)'}`);
    console.log(`  Workspace: ${workspaceSlug}, Repo: ${repoSlug}`);

    // If panel exists and version changed, update the URL
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      if (versionId && versionId !== this.currentVersionId) {
        console.log(`[Monoid WebView] Updating to new version: ${versionId}`);
        this.currentVersionId = versionId;
        this.panel.webview.html = this.getWebviewContent(dashboardUrl, workspaceSlug, repoSlug, versionId);
      }
      return;
    }

    this.currentVersionId = versionId;

    // Create new panel
    this.panel = vscode.window.createWebviewPanel(
      'monoid-visualize.graphPanel',
      '🔮 Monoid Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep the iframe loaded when switching tabs
        localResourceRoots: [extensionUri]
      }
    );

    // Set the HTML content
    this.panel.webview.html = this.getWebviewContent(dashboardUrl, workspaceSlug, repoSlug, versionId);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'openFile':
          await this.openFile(message.filePath, message.line);
          break;
        case 'refresh':
          vscode.commands.executeCommand('monoid-visualize.visualizeAllCode');
          break;
        case 'openExternal':
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;
      }
    });

    // Clean up when panel is closed
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.currentVersionId = undefined;
    });
  }

  /**
   * Update the panel to show a new version
   */
  static updateVersion(versionId: string): void {
    if (!this.panel) { return; }
    
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const dashboardUrl = config.get<string>('webAppUrl') || DEFAULT_DASHBOARD_URL;
    
    this.currentVersionId = versionId;
    this.panel.webview.postMessage({ type: 'navigate', url: `${dashboardUrl}/graph/${versionId}` });
  }

  /**
   * Send a message to refresh the embedded app
   */
  static refreshPanel(): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'refresh' });
    }
  }

  /**
   * Show loading state
   */
  static showLoading(message: string): void {
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'loading', message });
    }
  }

  /**
   * Open a file in the editor
   */
  private static async openFile(filePath: string, line: number): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return; }

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

  /**
   * Generate the webview HTML with embedded iframe
   */
  private static getWebviewContent(
    dashboardUrl: string,
    workspaceSlug: string,
    repoSlug: string,
    versionId?: string
  ): string {
    // Build the graph URL - the dashboard uses /graph/[versionId] format
    // Add ?vscode=true to bypass authentication (proof of concept)
    const graphUrl = versionId 
      ? `${dashboardUrl}/graph/${versionId}?vscode=true`
      : `${dashboardUrl}?vscode=true`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${dashboardUrl} https://*.vercel.app https://*.supabase.co https://github.com https://*.github.com http://localhost:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Monoid Graph</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #08080a;
    }
    
    .container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: #0c0c0e;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      flex-shrink: 0;
    }
    
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .toolbar-title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .toolbar-title::before {
      content: '';
      width: 8px;
      height: 8px;
      background: linear-gradient(135deg, #a78bfa, #8b5cf6);
      border-radius: 50%;
      box-shadow: 0 0 8px rgba(167, 139, 250, 0.5);
    }
    
    .toolbar-info {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 11px;
      color: #6b7280;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 4px;
    }
    
    .toolbar-actions {
      display: flex;
      gap: 8px;
    }
    
    .btn {
      padding: 6px 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      font-weight: 500;
      color: #e5e5e5;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    
    .btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(167, 139, 250, 0.3);
    }
    
    .btn-primary {
      background: linear-gradient(135deg, rgba(167, 139, 250, 0.2), rgba(139, 92, 246, 0.2));
      border-color: rgba(167, 139, 250, 0.3);
    }
    
    .btn-primary:hover {
      background: linear-gradient(135deg, rgba(167, 139, 250, 0.3), rgba(139, 92, 246, 0.3));
      border-color: rgba(167, 139, 250, 0.5);
    }
    
    .iframe-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    
    iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #08080a;
    }
    
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(8, 8, 10, 0.95);
      z-index: 100;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    
    .loading-overlay.visible {
      opacity: 1;
      pointer-events: all;
    }
    
    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255, 255, 255, 0.1);
      border-top-color: #a78bfa;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .loading-text {
      margin-top: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: #6b7280;
    }

    .empty-state {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #08080a;
      text-align: center;
      padding: 40px;
    }

    .empty-state.visible {
      display: flex;
    }

    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .empty-title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 18px;
      font-weight: 600;
      color: #e5e5e5;
      margin-bottom: 8px;
    }

    .empty-desc {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      color: #6b7280;
      max-width: 400px;
      line-height: 1.5;
      margin-bottom: 24px;
    }

    .empty-state .btn {
      padding: 10px 20px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">Monoid Graph</span>
        <span class="toolbar-info">${workspaceSlug}/${repoSlug}</span>
        ${versionId ? `<span class="toolbar-info" style="color: #a78bfa;">${versionId.slice(0, 8)}...</span>` : ''}
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary" id="refreshBtn" title="Re-analyze and refresh">↻ Analyze</button>
        <button class="btn" id="reloadBtn" title="Reload dashboard">⟳ Reload</button>
        <button class="btn" id="openExternalBtn" title="Open in browser">↗ External</button>
      </div>
    </div>
    
    <div class="iframe-container">
      ${versionId ? `
      <iframe 
        id="graphFrame" 
        src="${graphUrl}"
        allow="clipboard-read; clipboard-write"
      ></iframe>
      ` : ''}
      
      <div class="loading-overlay ${versionId ? 'visible' : ''}" id="loading">
        <div class="loading-spinner"></div>
        <div class="loading-text" id="loadingText">Loading graph...</div>
      </div>

      <div class="empty-state ${!versionId ? 'visible' : ''}" id="emptyState">
        <div class="empty-icon">🔮</div>
        <div class="empty-title">No Graph Yet</div>
        <div class="empty-desc">
          Run "Visualize All Code" to analyze your codebase and generate a graph visualization.
        </div>
        <button class="btn btn-primary" id="analyzeBtn">
          ✨ Visualize All Code
        </button>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('graphFrame');
    const loadingEl = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const emptyState = document.getElementById('emptyState');
    
    const graphUrl = '${graphUrl}';
    const dashboardUrl = '${dashboardUrl}';
    const hasVersion = ${versionId ? 'true' : 'false'};
    
    // Show loading initially if we have a version
    if (hasVersion && iframe) {
      loadingEl.classList.add('visible');
      
      // Hide loading when iframe loads
      iframe.addEventListener('load', () => {
        loadingEl.classList.remove('visible');
      });
      
      // Handle iframe errors - show after timeout
      setTimeout(() => {
        if (loadingEl.classList.contains('visible')) {
          loadingText.textContent = 'Still loading... The dashboard may take a moment.';
        }
      }, 5000);
    }
    
    // Toolbar buttons
    document.getElementById('refreshBtn').addEventListener('click', () => {
      loadingEl.classList.add('visible');
      loadingText.textContent = 'Analyzing codebase...';
      emptyState.classList.remove('visible');
      vscode.postMessage({ type: 'refresh' });
    });
    
    document.getElementById('reloadBtn')?.addEventListener('click', () => {
      if (iframe) {
        loadingEl.classList.add('visible');
        loadingText.textContent = 'Reloading...';
        iframe.src = graphUrl;
      }
    });
    
    document.getElementById('openExternalBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openExternal', url: graphUrl });
    });

    document.getElementById('analyzeBtn')?.addEventListener('click', () => {
      loadingEl.classList.add('visible');
      loadingText.textContent = 'Analyzing codebase...';
      emptyState.classList.remove('visible');
      vscode.postMessage({ type: 'refresh' });
    });
    
    // Listen for messages from the embedded dashboard
    window.addEventListener('message', (event) => {
      const data = event.data;
      
      // Handle messages from VS Code extension
      if (data.type === 'loading') {
        loadingEl.classList.add('visible');
        loadingText.textContent = data.message;
        emptyState.classList.remove('visible');
      } else if (data.type === 'navigate') {
        if (iframe) {
          loadingEl.classList.add('visible');
          loadingText.textContent = 'Loading new version...';
          iframe.src = data.url;
          emptyState.classList.remove('visible');
        }
      } else if (data.type === 'refresh') {
        if (iframe) {
          iframe.contentWindow?.postMessage({ type: 'refreshData' }, '*');
        }
      }
      
      // Handle messages from the dashboard iframe
      if (data.type === 'openFile') {
        vscode.postMessage({
          type: 'openFile',
          filePath: data.filePath,
          line: data.line
        });
      } else if (data.type === 'ready') {
        loadingEl.classList.remove('visible');
      } else if (data.type === 'openExternalUrl') {
        // Allow the embedded app to request opening external URLs
        if (data.url) {
          vscode.postMessage({ type: 'openExternal', url: data.url });
        }
      }
    });

    // Notify iframe that it's in a VS Code webview
    if (iframe) {
      iframe.addEventListener('load', () => {
        setTimeout(() => {
          iframe.contentWindow?.postMessage({ type: 'vscodeWebview', isWebview: true }, '*');
        }, 500);
      });
    }
  </script>
</body>
</html>`;
  }
}

// Legacy provider for backward compatibility (sidebar view)
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
      localResourceRoots: [this._extensionUri]
    };

    // Show a simple message directing to use the panel
    webviewView.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 20px;
      color: #e5e5e5;
      background: #08080a;
    }
    .icon { font-size: 32px; margin-bottom: 16px; }
    h3 { margin-bottom: 8px; font-size: 14px; }
    p { color: #6b7280; font-size: 12px; line-height: 1.5; }
    button {
      margin-top: 16px;
      padding: 10px 16px;
      background: linear-gradient(135deg, rgba(167, 139, 250, 0.2), rgba(139, 92, 246, 0.2));
      color: #e5e5e5;
      border: 1px solid rgba(167, 139, 250, 0.3);
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    button:hover { 
      background: linear-gradient(135deg, rgba(167, 139, 250, 0.3), rgba(139, 92, 246, 0.3));
      border-color: rgba(167, 139, 250, 0.5);
    }
  </style>
</head>
<body>
  <div class="icon">🔮</div>
  <h3>Monoid Graph</h3>
  <p>Click below to open the full graph visualization in a new tab.</p>
  <button onclick="openPanel()">Open Graph Panel</button>
  <script>
    const vscode = acquireVsCodeApi();
    function openPanel() {
      vscode.postMessage({ type: 'openPanel' });
    }
  </script>
</body>
</html>`;

    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'openPanel') {
        vscode.commands.executeCommand('monoid-visualize.openGraphPanel');
      }
    });
  }

  public updateGraph(_data: any) {
    // No-op for sidebar, use panel instead
  }

  public showLoading(_message: string) {
    // No-op for sidebar
  }

  public showError(_message: string) {
    // No-op for sidebar
  }
}
