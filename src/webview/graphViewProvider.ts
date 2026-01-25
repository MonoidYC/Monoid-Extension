import * as vscode from 'vscode';

/**
 * Opens a webview panel (full editor tab) that embeds the Monoid web app
 */
export class GraphPanelManager {
  private static panel: vscode.WebviewPanel | undefined;

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
    const webAppUrl = config.get<string>('webAppUrl') || 'http://localhost:3000';

    // If panel exists, just reveal it
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.updatePanelUrl(webAppUrl, workspaceSlug, repoSlug, versionId);
      return;
    }

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
    this.panel.webview.html = this.getWebviewContent(webAppUrl, workspaceSlug, repoSlug, versionId);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'openFile':
          await this.openFile(message.filePath, message.line);
          break;
        case 'refresh':
          vscode.commands.executeCommand('monoid-visualize.visualizeAllCode');
          break;
      }
    });

    // Clean up when panel is closed
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  /**
   * Update the panel's URL (e.g., after a new visualization)
   */
  static updatePanelUrl(
    webAppUrl: string,
    workspaceSlug: string,
    repoSlug: string,
    versionId?: string
  ): void {
    if (!this.panel) { return; }
    this.panel.webview.html = this.getWebviewContent(webAppUrl, workspaceSlug, repoSlug, versionId);
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
    webAppUrl: string,
    workspaceSlug: string,
    repoSlug: string,
    versionId?: string
  ): string {
    // Build the URL with query params
    const params = new URLSearchParams({
      workspace: workspaceSlug,
      repo: repoSlug,
      embedded: 'true', // Tell the web app it's embedded in VS Code
      ...(versionId && { version: versionId })
    });
    
    const embedUrl = `${webAppUrl}/graph?${params.toString()}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${webAppUrl} http://localhost:* https://*.vercel.app https://*.monoid.so; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
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
      background: #0d1117;
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
      background: #161b22;
      border-bottom: 1px solid #30363d;
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
      color: #c9d1d9;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .toolbar-title::before {
      content: '';
      width: 8px;
      height: 8px;
      background: #58a6ff;
      border-radius: 50%;
      box-shadow: 0 0 8px #58a6ff;
    }
    
    .toolbar-info {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 11px;
      color: #8b949e;
      padding: 4px 8px;
      background: #21262d;
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
      color: #c9d1d9;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    
    .btn:hover {
      background: #30363d;
      border-color: #58a6ff;
    }
    
    .btn-primary {
      background: #238636;
      border-color: #238636;
    }
    
    .btn-primary:hover {
      background: #2ea043;
      border-color: #2ea043;
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
      background: #0d1117;
    }
    
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(13, 17, 23, 0.95);
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
      border: 3px solid #30363d;
      border-top-color: #58a6ff;
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
      color: #8b949e;
    }

    .error-banner {
      display: none;
      padding: 12px 16px;
      background: #21262d;
      border-bottom: 1px solid #f8514966;
      color: #f85149;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      align-items: center;
      gap: 8px;
    }

    .error-banner.visible {
      display: flex;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="toolbar-title">Monoid Graph</span>
        <span class="toolbar-info">${workspaceSlug}/${repoSlug}</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn" id="refreshBtn" title="Refresh graph data">↻ Refresh</button>
        <button class="btn" id="reloadBtn" title="Reload web app">⟳ Reload</button>
        <button class="btn" id="openExternalBtn" title="Open in browser">↗ Open External</button>
      </div>
    </div>
    
    <div class="error-banner" id="errorBanner">
      <span>⚠️</span>
      <span id="errorText">Could not connect to web app</span>
    </div>
    
    <div class="iframe-container">
      <iframe 
        id="graphFrame" 
        src="${embedUrl}"
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      ></iframe>
      
      <div class="loading-overlay" id="loading">
        <div class="loading-spinner"></div>
        <div class="loading-text" id="loadingText">Loading graph...</div>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('graphFrame');
    const loadingEl = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const errorBanner = document.getElementById('errorBanner');
    const errorText = document.getElementById('errorText');
    
    const embedUrl = '${embedUrl}';
    const webAppUrl = '${webAppUrl}';
    
    // Show loading initially
    loadingEl.classList.add('visible');
    
    // Hide loading when iframe loads
    iframe.addEventListener('load', () => {
      loadingEl.classList.remove('visible');
      errorBanner.classList.remove('visible');
    });
    
    // Handle iframe errors
    iframe.addEventListener('error', () => {
      loadingEl.classList.remove('visible');
      errorBanner.classList.add('visible');
      errorText.textContent = 'Could not connect to ' + webAppUrl;
    });
    
    // Toolbar buttons
    document.getElementById('refreshBtn').addEventListener('click', () => {
      loadingEl.classList.add('visible');
      loadingText.textContent = 'Refreshing graph...';
      vscode.postMessage({ type: 'refresh' });
    });
    
    document.getElementById('reloadBtn').addEventListener('click', () => {
      loadingEl.classList.add('visible');
      loadingText.textContent = 'Reloading...';
      iframe.src = embedUrl;
    });
    
    document.getElementById('openExternalBtn').addEventListener('click', () => {
      // Open URL in default browser - the embedded app should handle this
      window.open(embedUrl.replace('embedded=true', 'embedded=false'), '_blank');
    });
    
    // Listen for messages from the embedded web app
    window.addEventListener('message', (event) => {
      // Only accept messages from our web app origin
      if (!event.origin.startsWith(webAppUrl.replace(/\\/$/, ''))) {
        return;
      }
      
      const data = event.data;
      
      switch (data.type) {
        case 'openFile':
          // Forward to VS Code extension
          vscode.postMessage({
            type: 'openFile',
            filePath: data.filePath,
            line: data.line
          });
          break;
          
        case 'ready':
          // Web app is ready
          loadingEl.classList.remove('visible');
          break;
      }
    });
    
    // Listen for messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      
      if (message.type === 'loading') {
        loadingEl.classList.add('visible');
        loadingText.textContent = message.message;
      } else if (message.type === 'refresh') {
        // Tell iframe to refresh its data
        iframe.contentWindow?.postMessage({ type: 'refreshData' }, '*');
      }
    });
  </script>
</body>
</html>`;
  }
}

// Legacy provider for backward compatibility (sidebar view)
// Can be removed once fully migrated to panel
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
      color: #c9d1d9;
      background: #0d1117;
    }
    .icon { font-size: 32px; margin-bottom: 16px; }
    h3 { margin-bottom: 8px; font-size: 14px; }
    p { color: #8b949e; font-size: 12px; line-height: 1.5; }
    button {
      margin-top: 16px;
      padding: 8px 16px;
      background: #238636;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: #2ea043; }
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
