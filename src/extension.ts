import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CodeAnalyzer } from './analyzer';
import { SupabaseService } from './supabase/client';
import { GraphViewProvider, GraphPanelManager } from './webview/graphViewProvider';
import { testVSCodeLM } from './analyzer/llmAnalyzer';
import { GitHubInfo } from './types';
import { getGitHubInfoFromGit } from './utils/gitUtils';
import { writeLocalGraph, readLocalGraph } from './utils/localGraph';

let supabaseService: SupabaseService;
let analyzer: CodeAnalyzer;

export function activate(context: vscode.ExtensionContext) {
  console.log('Monoid Visualize extension is now active!');

  supabaseService = new SupabaseService(context.secrets);
  analyzer = new CodeAnalyzer();

  // Handle vscode://monoid.monoid-visualize/auth-callback?code=...&state=...
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        try {
          const handled = await supabaseService.handleAuthCallbackUri(uri);
          if (handled) {
            vscode.window.showInformationMessage('Monoid: Signed in successfully.');
          }
        } catch (err: any) {
          console.error('[Monoid] Auth callback error:', err);
          vscode.window.showErrorMessage(`Monoid sign-in failed: ${err?.message ?? String(err)}`);
        }
      },
    })
  );

  // Sidebar entry (shows “Open Graph Panel”)
  const sidebarProvider = new GraphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphViewProvider.viewType, sidebarProvider)
  );

  const openPanelCommand = vscode.commands.registerCommand(
    'monoid-visualize.openGraphPanel',
    async () => {
      await openGraphPanel(context.extensionUri);
    }
  );

  const visualizeCommand = vscode.commands.registerCommand(
    'monoid-visualize.visualizeAllCode',
    async () => {
      await visualizeAllCode(context.extensionUri);
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    'monoid-visualize.refreshGraph',
    async () => {
      GraphPanelManager.refreshPanel();
    }
  );

  const pushToSupabaseCommand = vscode.commands.registerCommand(
    'monoid-visualize.pushToSupabase',
    async () => {
      await pushLocalGraphToSupabase();
    }
  );

  const helloWorldCommand = vscode.commands.registerCommand(
    'monoid-visualize.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello World from monoid-visualize!');
    }
  );

  const signInCommand = vscode.commands.registerCommand(
    'monoid-visualize.signIn',
    async () => {
      await openAuthPanel(context.extensionUri);
    }
  );

  const signOutCommand = vscode.commands.registerCommand('monoid-visualize.signOut', async () => {
    await supabaseService.signOut();
    vscode.window.showInformationMessage('Monoid: Signed out.');
  });

  const testLMCommand = vscode.commands.registerCommand(
    'monoid-visualize.testLM',
    async () => {
      await testVSCodeLM();
    }
  );

  context.subscriptions.push(
    openPanelCommand,
    visualizeCommand,
    refreshCommand,
    pushToSupabaseCommand,
    helloWorldCommand,
    testLMCommand,
    signInCommand,
    signOutCommand
  );
}

async function openGraphPanel(extensionUri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const workspaceName = workspaceFolder.name;
  const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const repoSlug = workspaceSlug;

  // Load graph from local .monoid/graph.json (no auth / no dashboard)
  const localGraph = await readLocalGraph(workspaceFolder);
  GraphPanelManager.openPanel(extensionUri, workspaceSlug, repoSlug, localGraph);
}

async function pushLocalGraphToSupabase(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const localGraph = await readLocalGraph(workspaceFolder);
  if (!localGraph || localGraph.nodes.length === 0) {
    vscode.window.showWarningMessage('No local graph found. Run "Visualize All Code" first to save to .monoid/graph.json');
    return;
  }

  const authStatus = await supabaseService.checkAuthentication();
  if (!authStatus.authenticated) {
    const action = await vscode.window.showWarningMessage(
      'Sign in required to push to cloud.',
      'Sign In',
      'Cancel'
    );
    if (action === 'Sign In') {
      await vscode.commands.executeCommand('monoid-visualize.signIn');
    }
    return;
  }

  const config = vscode.workspace.getConfiguration('monoid-visualize');
  const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
  const detectedOwner = gitInfo?.owner || config.get<string>('githubOwner');
  const detectedRepo = gitInfo?.repo || config.get<string>('githubRepo');
  const detectedBranch = gitInfo?.branch || config.get<string>('githubBranch') || 'main';
  const workspaceName = workspaceFolder.name;
  const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    GraphPanelManager.showLoading('Pushing to cloud...');
    const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);
    const organizationSlug = detectedOwner || workspaceSlug || 'local';
    const organizationName = detectedOwner || workspaceName || 'Local';
    const organization = await supabaseService.getOrCreateOrganization(organizationName, organizationSlug);
    const organizationId = organization.id;
    const repoOwner = detectedOwner || 'local';
    const repoName = detectedRepo || workspaceName;
    const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);
    const commitSha = generateCommitSha();
    const version = await supabaseService.createVersion(repo.id, commitSha, detectedBranch);
    const stableIdToId = await supabaseService.saveNodes(version.id, localGraph.nodes);
    await supabaseService.saveEdges(version.id, localGraph.edges, stableIdToId);
    await supabaseService.updateVersionCounts(version.id, localGraph.nodes.length, localGraph.edges.length);
    GraphPanelManager.showLoading('');
    vscode.window.showInformationMessage(
      `Pushed ${localGraph.nodes.length} nodes and ${localGraph.edges.length} edges to cloud.`
    );
  } catch (err: any) {
    console.error('Push to Supabase error:', err);
    vscode.window.showErrorMessage(`Push failed: ${err?.message ?? String(err)}`);
  }
}

async function visualizeAllCode(extensionUri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  // Auto-detect GitHub info from git remote, fall back to config
  const config = vscode.workspace.getConfiguration('monoid-visualize');
  const enableLlmEnrichment = config.get<boolean>('enableLlmEnrichment') ?? false;
  const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);

  const detectedOwner = gitInfo?.owner || config.get<string>('githubOwner');
  const detectedRepo = gitInfo?.repo || config.get<string>('githubRepo');
  const detectedBranch = gitInfo?.branch || config.get<string>('githubBranch') || 'main';

  let githubInfo: GitHubInfo | undefined;
  if (detectedOwner && detectedRepo) {
    githubInfo = { owner: detectedOwner, repo: detectedRepo, branch: detectedBranch };
    console.log(`[Monoid] GitHub info: ${detectedOwner}/${detectedRepo} (${detectedBranch})`);
  } else {
    console.log('[Monoid] No GitHub info detected, using local mode');
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Visualizing Code',
        cancellable: false,
      },
      async (progress) => {
        // Phase 1: Analyze code
        GraphPanelManager.showLoading('Analyzing codebase...');
        progress.report({ message: 'Analyzing codebase...', increment: 0 });

        const analysisResult = await analyzer.analyzeWorkspace(workspaceFolder, progress, githubInfo, {
          enableLlm: enableLlmEnrichment,
        });
        const nodeCount = analysisResult.nodes.length;
        const edgeCount = analysisResult.edges.length;

        if (nodeCount === 0) {
          vscode.window.showWarningMessage('No code elements found to visualize');
          return;
        }

        progress.report({ message: `Found ${nodeCount} nodes, ${edgeCount} edges`, increment: 40 });

        // Optional: LLM snippets/summaries (off by default)
        if (enableLlmEnrichment) {
          const apiKey = config.get<string>('geminiApiKey');
          if (apiKey) {
            GraphPanelManager.showLoading('Extracting snippets & summaries (Gemini)...');
            progress.report({ message: 'Extracting snippets & summaries (Gemini)...', increment: 10 });

            const { getGeminiSummarizer } = await import('./analyzer/geminiSummarizer.js');
            const summarizer = getGeminiSummarizer();
            const snippetsAndSummaries = await summarizer.generateSnippetsAndSummaries(
              analysisResult.nodes,
              workspaceFolder,
              progress
            );

            for (const node of analysisResult.nodes) {
              const result = snippetsAndSummaries.get(node.stable_id);
              if (result) {
                node.snippet = result.snippet;
                node.summary = result.summary;
              }
            }
          }
        }

        // Save to local .monoid/graph.json only (no Supabase push here)
        progress.report({ message: 'Saving graph locally...', increment: 55 });
        GraphPanelManager.showLoading('Saving graph...');
        await writeLocalGraph(workspaceFolder, analysisResult);
        const workspaceName = workspaceFolder.name;
        const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        progress.report({ message: 'Opening graph...', increment: 95 });
        GraphPanelManager.openPanel(extensionUri, workspaceSlug, workspaceSlug, analysisResult);

        vscode.window.showInformationMessage(
          `Visualized ${nodeCount} nodes and ${edgeCount} edges from ${workspaceName}`
        );
      }
    );
  } catch (error: any) {
    console.error('Visualization error:', error);
    vscode.window.showErrorMessage(`Failed to visualize code: ${error.message}`);
  }
}

function generateCommitSha(): string {
  const timestamp = Date.now().toString();
  const random = Math.random().toString();
  return crypto.createHash('sha1').update(timestamp + random).digest('hex').substring(0, 40);
}

export function deactivate() {}

async function openAuthPanel(extensionUri: vscode.Uri): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'monoid-visualize.auth',
    'Monoid: Sign In',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    }
  );

  const config = vscode.workspace.getConfiguration('monoid-visualize');
  const webAppUrl = config.get<string>('webAppUrl') || 'https://monoid-dashboard.vercel.app';
  const authRedirectOverride = config.get<string>('authRedirectUrl') || '';
  const authRedirectUrl = authRedirectOverride || `${webAppUrl.replace(/\/$/, '')}/auth/callback`;

  panel.webview.html = getAuthHtml(panel.webview, authRedirectUrl);

  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === 'signInWithPassword') {
        const email = String(message.email ?? '');
        const password = String(message.password ?? '');
        const result = await supabaseService.signInWithPassword(email, password);
        panel.webview.postMessage({ type: 'signedIn', userId: result.userId });
        vscode.window.showInformationMessage('Monoid: Signed in successfully.');
        panel.dispose();
        return;
      }

      if (message?.type === 'sendMagicLink') {
        const email = String(message.email ?? '');
        await supabaseService.startPkceSignIn(email, authRedirectUrl);
        await vscode.env.openExternal(vscode.Uri.parse(authRedirectUrl));
        panel.webview.postMessage({ type: 'magicLinkSent' });
        return;
      }

      if (message?.type === 'openCallback') {
        await vscode.env.openExternal(vscode.Uri.parse(authRedirectUrl));
        return;
      }
    } catch (err: any) {
      console.error('[Monoid] Auth UI error:', err);
      panel.webview.postMessage({ type: 'error', message: err?.message ?? String(err) });
    }
  });
}

function getAuthHtml(webview: vscode.Webview, callbackUrl: string): string {
  const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Monoid Sign In</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 0; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
      .card { max-width: 520px; margin: 0 auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 12px; padding: 16px; background: var(--vscode-editorWidget-background); }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
      label { display: block; font-size: 12px; margin-top: 10px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
      input { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
      .row { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
      button { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
      button.secondary { background: transparent; border-color: var(--vscode-button-background); color: var(--vscode-button-background); }
      .status { margin-top: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 16px; }
      .error { color: var(--vscode-errorForeground); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Sign in to Monoid</h1>
      <p>Use email + password (no magic-link rate limits). If you prefer, you can still use a magic link.</p>

      <label>Email</label>
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com" />

      <label>Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="••••••••" />

      <div class="row">
        <button id="signIn">Sign in</button>
        <button id="magicLink" class="secondary">Send magic link</button>
        <button id="openCallback" class="secondary">Open callback page</button>
      </div>

      <div class="status" id="status"></div>

      <p style="margin-top: 12px;">
        Callback page: <code>${callbackUrl}</code>
      </p>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const $email = document.getElementById('email');
      const $password = document.getElementById('password');
      const $status = document.getElementById('status');
      const setStatus = (msg, isError=false) => {
        $status.textContent = msg || '';
        $status.className = 'status' + (isError ? ' error' : '');
      };

      document.getElementById('signIn').addEventListener('click', () => {
        const email = ($email.value || '').trim();
        const password = $password.value || '';
        if (!email || !password) {
          setStatus('Email and password are required.', true);
          return;
        }
        setStatus('Signing in…');
        vscode.postMessage({ type: 'signInWithPassword', email, password });
      });

      document.getElementById('magicLink').addEventListener('click', () => {
        const email = ($email.value || '').trim();
        if (!email) {
          setStatus('Email is required for magic link.', true);
          return;
        }
        setStatus('Sending magic link…');
        vscode.postMessage({ type: 'sendMagicLink', email });
      });

      document.getElementById('openCallback').addEventListener('click', () => {
        vscode.postMessage({ type: 'openCallback' });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'signedIn') {
          setStatus('Signed in. You can close this tab.');
        } else if (msg.type === 'magicLinkSent') {
          setStatus('Magic link sent. Check your email and click the link.');
        } else if (msg.type === 'error') {
          setStatus(msg.message || 'Unknown error', true);
        }
      });
    </script>
  </body>
</html>`;
}

