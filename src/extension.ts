import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { CodeAnalyzer } from './analyzer';
import { SupabaseService } from './supabase/client';
import { GraphViewProvider } from './webview/graphViewProvider';
import { testVSCodeLM } from './analyzer/llmAnalyzer';

let graphViewProvider: GraphViewProvider;
let supabaseService: SupabaseService;
let analyzer: CodeAnalyzer;

export function activate(context: vscode.ExtensionContext) {
  console.log('Monoid Visualize extension is now active!');

  // Initialize services
  supabaseService = new SupabaseService();
  analyzer = new CodeAnalyzer();

  // Create and register the webview provider
  graphViewProvider = new GraphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GraphViewProvider.viewType,
      graphViewProvider
    )
  );

  // Register the main command
  const visualizeCommand = vscode.commands.registerCommand(
    'monoid-visualize.visualizeAllCode',
    async () => {
      await visualizeAllCode();
    }
  );

  // Register refresh command
  const refreshCommand = vscode.commands.registerCommand(
    'monoid-visualize.refreshGraph',
    async () => {
      await loadExistingGraph();
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

  context.subscriptions.push(visualizeCommand, refreshCommand, helloWorldCommand, testLMCommand);

  // Try to load existing graph data on activation
  loadExistingGraph();
}

async function visualizeAllCode(): Promise<void> {
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
        graphViewProvider.showLoading('Analyzing codebase...');
        progress.report({ message: 'Analyzing codebase...', increment: 0 });

        const analysisResult = await analyzer.analyzeWorkspace(workspaceFolder, progress);
        
        const nodeCount = analysisResult.nodes.length;
        const edgeCount = analysisResult.edges.length;
        
        if (nodeCount === 0) {
          vscode.window.showWarningMessage('No code elements found to visualize');
          graphViewProvider.updateGraph({ nodes: [], edges: [] });
          return;
        }

        progress.report({ message: `Found ${nodeCount} nodes, ${edgeCount} edges`, increment: 50 });

        // Phase 2: Save to Supabase
        graphViewProvider.showLoading('Saving to Supabase...');
        progress.report({ message: 'Saving to Supabase...', increment: 60 });

        try {
          // Create or get workspace
          const workspaceName = workspaceFolder.name;
          const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);

          // Create or get repo
          const repoName = workspaceName;
          const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName);

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

          progress.report({ message: 'Loading graph...', increment: 95 });

          // Load and display the graph
          const graphData = await supabaseService.getGraphData(version.id);
          graphViewProvider.updateGraph(graphData);

          vscode.window.showInformationMessage(
            `Visualized ${nodeCount} nodes and ${edgeCount} edges from ${workspaceName}`
          );
        } catch (supabaseError: any) {
          console.error('Supabase error:', supabaseError);
          
          // Still show local visualization even if Supabase fails
          const localGraphData = {
            nodes: analysisResult.nodes.map((node, index) => ({
              id: `local-${index}`,
              label: node.name,
              type: node.node_type,
              filePath: node.file_path,
              line: node.start_line
            })),
            edges: [] // Can't show edges without proper ID mapping for local
          };
          
          graphViewProvider.updateGraph(localGraphData);
          vscode.window.showWarningMessage(
            `Displayed ${nodeCount} nodes locally. Supabase sync failed: ${supabaseError.message}`
          );
        }
      }
    );
  } catch (error: any) {
    console.error('Visualization error:', error);
    graphViewProvider.showError(error.message);
    vscode.window.showErrorMessage(`Failed to visualize code: ${error.message}`);
  }
}

async function loadExistingGraph(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  try {
    graphViewProvider.showLoading('Loading existing graph...');

    const workspaceName = workspaceFolder.name;
    const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    const versions = await supabaseService.getAllVersionsForWorkspace(workspaceSlug);
    
    if (versions.length === 0) {
      graphViewProvider.updateGraph({ nodes: [], edges: [] });
      return;
    }

    // Get the most recent version
    const latestVersion = versions[0].version;
    const graphData = await supabaseService.getGraphData(latestVersion.id);
    
    graphViewProvider.updateGraph(graphData);
  } catch (error: any) {
    console.error('Failed to load existing graph:', error);
    graphViewProvider.updateGraph({ nodes: [], edges: [] });
  }
}

function generateCommitSha(): string {
  const timestamp = Date.now().toString();
  const random = Math.random().toString();
  return crypto.createHash('sha1').update(timestamp + random).digest('hex').substring(0, 40);
}

export function deactivate() {}
