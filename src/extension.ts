import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CodeAnalyzer } from './analyzer';
import { SupabaseService } from './supabase/client';
import { GraphViewProvider, GraphPanelManager } from './webview/graphViewProvider';
import { testVSCodeLM } from './analyzer/llmAnalyzer';
import { GitHubInfo } from './types';
import { getGitHubInfoFromGit } from './utils/gitUtils';

let supabaseService: SupabaseService;
let analyzer: CodeAnalyzer;

export function activate(context: vscode.ExtensionContext) {
  console.log('Monoid Visualize extension is now active!');

  supabaseService = new SupabaseService();
  analyzer = new CodeAnalyzer();

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

  const helloWorldCommand = vscode.commands.registerCommand(
    'monoid-visualize.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello World from monoid-visualize!');
    }
  );

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
  const repoSlug = workspaceSlug;

  // Try to open latest version (if any)
  let versionId: string | undefined;
  try {
    const versions = await supabaseService.getAllVersionsForWorkspace(workspaceSlug);
    if (versions.length > 0) {
      versionId = versions[0].version.id;
    }
  } catch {
    // ignore
  }

  GraphPanelManager.openPanel(extensionUri, workspaceSlug, repoSlug, versionId);
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

        // Phase 2: Save to Supabase
        GraphPanelManager.showLoading('Saving to Supabase...');
        progress.report({ message: 'Saving to Supabase...', increment: 60 });

        try {
          const workspaceName = workspaceFolder.name;
          const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);
          const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          // Ensure an organization exists (dashboard groups repos by organization)
          const organizationSlug = detectedOwner || workspaceSlug || 'local';
          const organizationName = detectedOwner || workspaceName || 'Local';
          const organization = await supabaseService.getOrCreateOrganization(organizationName, organizationSlug);
          const organizationId = organization.id;

          const repoOwner = detectedOwner || 'local';
          const repoName = detectedRepo || workspaceName;
          const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);
          const repoSlug = workspaceSlug;

          const commitSha = generateCommitSha();
          const version = await supabaseService.createVersion(repo.id, commitSha, detectedBranch);

          progress.report({ message: 'Saving nodes...', increment: 70 });
          const stableIdToId = await supabaseService.saveNodes(version.id, analysisResult.nodes);

          progress.report({ message: 'Saving edges...', increment: 85 });
          await supabaseService.saveEdges(version.id, analysisResult.edges, stableIdToId);

          await supabaseService.updateVersionCounts(version.id, nodeCount, edgeCount);

          progress.report({ message: 'Opening graph...', increment: 95 });
          GraphPanelManager.openPanel(extensionUri, workspaceSlug, repoSlug, version.id);

          vscode.window.showInformationMessage(
            `Visualized ${nodeCount} nodes and ${edgeCount} edges from ${workspaceName}`
          );
        } catch (supabaseError: any) {
          console.error('Supabase error:', supabaseError);
          vscode.window.showErrorMessage(`Supabase sync failed: ${supabaseError.message}`);
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

