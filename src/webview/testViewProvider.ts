import * as vscode from 'vscode';

// Default dashboard URL
const DEFAULT_DASHBOARD_URL = 'https://monoid-dashboard.vercel.app';

/**
 * Opens a webview panel (full editor tab) that embeds the Monoid test dashboard
 */
export class TestPanelManager {
  private static panel: vscode.WebviewPanel | undefined;
  private static currentVersionId: string | undefined;

  /**
   * Opens or focuses the test panel
   */
  static openPanel(
    extensionUri: vscode.Uri,
    versionId?: string
  ): void {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const dashboardUrl = config.get<string>('webAppUrl') || DEFAULT_DASHBOARD_URL;
    const testUrl = versionId ? `${dashboardUrl}/tests/${versionId}` : dashboardUrl;

    // Log webview details
    console.log('[Monoid TestView] Opening panel:');
    console.log(`  Dashboard Base URL: ${dashboardUrl}`);
    console.log(`  Full Test URL: ${testUrl}`);
    console.log(`  Version ID: ${versionId || '(none)'}`);

    // If panel exists and version changed, update the URL
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      if (versionId && versionId !== this.currentVersionId) {
        console.log(`[Monoid TestView] Updating to new version: ${versionId}`);
        this.currentVersionId = versionId;
        this.panel.webview.html = this.getWebviewContent(dashboardUrl, versionId);
      }
      return;
    }

    this.currentVersionId = versionId;

    // Create new panel
    this.panel = vscode.window.createWebviewPanel(
      'monoid-visualize.testPanel',
      '🧪 Monoid Tests',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true, // Keep the iframe loaded when switching tabs
        localResourceRoots: [extensionUri]
      }
    );

    // Set the HTML content
    this.panel.webview.html = this.getWebviewContent(dashboardUrl, versionId);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'openFile':
          await this.openFile(message.filePath, message.line);
          break;
        case 'runTests':
          vscode.commands.executeCommand('monoid-visualize.runAllTests', message.headed);
          break;
        case 'generateTests':
          vscode.commands.executeCommand('monoid-visualize.generateAllTests');
          break;
        case 'deleteAllTests':
          vscode.commands.executeCommand('monoid-visualize.deleteAllTests');
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
    this.panel.webview.postMessage({ type: 'navigate', url: `${dashboardUrl}/tests/${versionId}` });
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
   * Get the current version ID
   */
  static getCurrentVersionId(): string | undefined {
    return this.currentVersionId;
  }

  /**
   * Check if panel is open
   */
  static isOpen(): boolean {
    return this.panel !== undefined;
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
    versionId?: string
  ): string {
    // Build the test URL - the dashboard uses /tests/[versionId] format
    const testUrl = versionId 
      ? `${dashboardUrl}/tests/${versionId}`
      : `${dashboardUrl}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${dashboardUrl} https://*.vercel.app https://*.supabase.co http://localhost:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Monoid Tests</title>
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
      background: linear-gradient(135deg, #34d399, #10b981);
      border-radius: 50%;
      box-shadow: 0 0 8px rgba(52, 211, 153, 0.5);
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
      border-color: rgba(52, 211, 153, 0.3);
    }
    
    .btn-primary {
      background: linear-gradient(135deg, rgba(52, 211, 153, 0.2), rgba(16, 185, 129, 0.2));
      border-color: rgba(52, 211, 153, 0.3);
    }
    
    .btn-primary:hover {
      background: linear-gradient(135deg, rgba(52, 211, 153, 0.3), rgba(16, 185, 129, 0.3));
      border-color: rgba(52, 211, 153, 0.5);
    }
    
    .btn-run {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(37, 99, 235, 0.2));
      border-color: rgba(59, 130, 246, 0.3);
    }
    
    .btn-run:hover {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(37, 99, 235, 0.3));
      border-color: rgba(59, 130, 246, 0.5);
    }
    
    .btn-danger {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.2));
      border-color: rgba(239, 68, 68, 0.3);
    }
    
    .btn-danger:hover {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.3), rgba(220, 38, 38, 0.3));
      border-color: rgba(239, 68, 68, 0.5);
    }
    
    .run-group {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .toggle-container {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    
    .toggle-container:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    
    .toggle-label {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px;
      color: #9ca3af;
      user-select: none;
    }
    
    .toggle-switch {
      position: relative;
      width: 32px;
      height: 18px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 9px;
      transition: all 0.2s ease;
    }
    
    .toggle-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      background: #6b7280;
      border-radius: 50%;
      transition: all 0.2s ease;
    }
    
    .toggle-container.active .toggle-switch {
      background: rgba(59, 130, 246, 0.3);
    }
    
    .toggle-container.active .toggle-switch::after {
      left: 16px;
      background: #3b82f6;
    }
    
    .toggle-container.active .toggle-label {
      color: #3b82f6;
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
      border-top-color: #34d399;
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
        <span class="toolbar-title">Monoid Tests</span>
        ${versionId ? `<span class="toolbar-info" style="color: #34d399;">${versionId.slice(0, 8)}...</span>` : ''}
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary" id="generateBtn" title="Generate tests for the app">✨ Generate</button>
        <div class="run-group">
          <button class="btn btn-run" id="runBtn" title="Run all tests">▶ Run Tests</button>
          <div class="toggle-container active" id="headedToggle" title="Toggle headed/headless mode">
            <span class="toggle-label">Headed</span>
            <div class="toggle-switch"></div>
          </div>
        </div>
        <button class="btn" id="reloadBtn" title="Reload dashboard">⟳ Reload</button>
        <button class="btn" id="openExternalBtn" title="Open in browser">↗ External</button>
        ${versionId ? '<button class="btn btn-danger" id="deleteAllBtn" title="Delete all tests for this version">🗑 Delete All</button>' : ''}
      </div>
    </div>
    
    <div class="iframe-container">
      ${versionId ? `
      <iframe 
        id="testFrame" 
        src="${testUrl}"
        allow="clipboard-read; clipboard-write"
      ></iframe>
      ` : ''}
      
      <div class="loading-overlay ${versionId ? 'visible' : ''}" id="loading">
        <div class="loading-spinner"></div>
        <div class="loading-text" id="loadingText">Loading tests...</div>
      </div>

      <div class="empty-state ${!versionId ? 'visible' : ''}" id="emptyState">
        <div class="empty-icon">🧪</div>
        <div class="empty-title">No Tests Yet</div>
        <div class="empty-desc">
          Run "Generate All Tests" to automatically create E2E tests for your application using Playwright.
        </div>
        <button class="btn btn-primary" id="generateAllBtn">
          ✨ Generate All Tests
        </button>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('testFrame');
    const loadingEl = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const emptyState = document.getElementById('emptyState');
    
    const testUrl = '${testUrl}';
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
    
    // Headed mode toggle state
    let headedMode = true;
    const headedToggle = document.getElementById('headedToggle');
    const toggleLabel = headedToggle.querySelector('.toggle-label');
    
    headedToggle.addEventListener('click', () => {
      headedMode = !headedMode;
      if (headedMode) {
        headedToggle.classList.add('active');
        toggleLabel.textContent = 'Headed';
      } else {
        headedToggle.classList.remove('active');
        toggleLabel.textContent = 'Headless';
      }
    });
    
    // Toolbar buttons
    document.getElementById('generateBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'generateTests' });
    });
    
    document.getElementById('runBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'runTests', headed: headedMode });
    });
    
    document.getElementById('reloadBtn')?.addEventListener('click', () => {
      if (iframe) {
        loadingEl.classList.add('visible');
        loadingText.textContent = 'Reloading...';
        iframe.src = testUrl;
      }
    });
    
    document.getElementById('openExternalBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'openExternal', url: testUrl });
    });

    document.getElementById('generateAllBtn')?.addEventListener('click', () => {
      loadingEl.classList.add('visible');
      loadingText.textContent = 'Generating tests...';
      emptyState.classList.remove('visible');
      vscode.postMessage({ type: 'generateTests' });
    });

    document.getElementById('deleteAllBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteAllTests' });
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
          loadingText.textContent = 'Loading tests...';
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
      }
    });
  </script>
</body>
</html>`;
  }
}
