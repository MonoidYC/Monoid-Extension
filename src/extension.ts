import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CodeAnalyzer } from './analyzer';
import { SupabaseService } from './supabase/client';
import { GraphViewProvider, GraphPanelManager } from './webview/graphViewProvider';
import { testVSCodeLM } from './analyzer/llmAnalyzer';

let supabaseService: SupabaseService;
let analyzer: CodeAnalyzer;

export function activate(context: vscode.ExtensionContext) {
  console.log('Monoid Visualize extension is now active!');

  // Initialize services
  supabaseService = new SupabaseService();
  analyzer = new CodeAnalyzer();

  // Register the sidebar view (shows "Open Panel" button)
  const sidebarProvider = new GraphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GraphViewProvider.viewType,
      sidebarProvider
    )
  );

  // Register command to open the graph panel
  const openPanelCommand = vscode.commands.registerCommand(
    'monoid-visualize.openGraphPanel',
    async () => {
      await openGraphPanel(context.extensionUri);
    }
  );

  // Register the main visualization command
  const visualizeCommand = vscode.commands.registerCommand(
    'monoid-visualize.visualizeAllCode',
    async () => {
      await visualizeAllCode(context.extensionUri);
    }
  );

  // Register refresh command
  const refreshCommand = vscode.commands.registerCommand(
    'monoid-visualize.refreshGraph',
    async () => {
      GraphPanelManager.refreshPanel();
    }
  );

  // Keep the hello world command for testing
  const helloWorldCommand = vscode.commands.registerCommand(
    'monoid-visualize.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello World from monoid-visualize!');
    }
  );

  // Test VS Code Language Model API
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
    helloWorldCommand,
    testLMCommand
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
  const repoSlug = workspaceSlug; // Same as workspace for now

  // Try to get the latest version ID
  let versionId: string | undefined;
  try {
    const versions = await supabaseService.getAllVersionsForWorkspace(workspaceSlug);
    if (versions.length > 0) {
      versionId = versions[0].version.id;
    }
  } catch (err) {
    // No existing version, that's okay
  }

  GraphPanelManager.openPanel(extensionUri, workspaceSlug, repoSlug, versionId);
}

async function visualizeAllCode(extensionUri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  try {
    // Show progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Visualizing Code',
        cancellable: false
      },
      async (progress) => {
        // Phase 1: Analyze code
        GraphPanelManager.showLoading('Analyzing codebase...');
        progress.report({ message: 'Analyzing codebase...', increment: 0 });

        const analysisResult = await analyzer.analyzeWorkspace(workspaceFolder, progress);
        
        const nodeCount = analysisResult.nodes.length;
        const edgeCount = analysisResult.edges.length;
        
        if (nodeCount === 0) {
          vscode.window.showWarningMessage('No code elements found to visualize');
          return;
        }

        progress.report({ message: `Found ${nodeCount} nodes, ${edgeCount} edges`, increment: 50 });

        // Phase 2: Save to Supabase
        GraphPanelManager.showLoading('Saving to Supabase...');
        progress.report({ message: 'Saving to Supabase...', increment: 60 });

        try {
          // Create or get workspace
          const workspaceName = workspaceFolder.name;
          const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);
          const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          // Create or get repo
          const repoName = workspaceName;
          const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName);
          const repoSlug = workspaceSlug;

          // Create new version with unique commit sha
          const commitSha = generateCommitSha();
          const version = await supabaseService.createVersion(repo.id, commitSha);

          progress.report({ message: 'Saving nodes...', increment: 70 });

          // Save nodes and get ID mapping
          const stableIdToId = await supabaseService.saveNodes(version.id, analysisResult.nodes);

          progress.report({ message: 'Saving edges...', increment: 85 });

          // Save edges
          await supabaseService.saveEdges(version.id, analysisResult.edges, stableIdToId);

          // Update version counts
          await supabaseService.updateVersionCounts(version.id, nodeCount, edgeCount);

          progress.report({ message: 'Opening graph...', increment: 95 });

          // Open the panel with the new version
          GraphPanelManager.openPanel(extensionUri, workspaceSlug, repoSlug, version.id);

          vscode.window.showInformationMessage(
            `Visualized ${nodeCount} nodes and ${edgeCount} edges from ${workspaceName}`
          );
        } catch (supabaseError: any) {
          console.error('Supabase error:', supabaseError);
          vscode.window.showErrorMessage(
            `Supabase sync failed: ${supabaseError.message}`
          );
        }
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
