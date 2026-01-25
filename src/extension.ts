import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { CodeAnalyzer } from './analyzer';
import { SupabaseService } from './supabase/client';
import { GraphViewProvider, GraphPanelManager } from './webview/graphViewProvider';
import { TestPanelManager } from './webview/testViewProvider';
import { testVSCodeLM } from './analyzer/llmAnalyzer';
import { GitHubInfo } from './types';
import { TestTreeProvider, TestTreeItem, TestGenerator, TestRunner } from './testing';
import { getGitHubInfoFromGit } from './utils/gitUtils';

let supabaseService: SupabaseService;
let analyzer: CodeAnalyzer;
let testTreeProvider: TestTreeProvider;
let testGenerator: TestGenerator;
let testRunner: TestRunner;

export function activate(context: vscode.ExtensionContext) {
  console.log('Monoid Visualize extension is now active!');

  // Initialize services
  supabaseService = new SupabaseService();
  analyzer = new CodeAnalyzer();

  // Initialize testing components
  testTreeProvider = new TestTreeProvider();
  testGenerator = new TestGenerator(supabaseService);
  testRunner = new TestRunner(testTreeProvider, supabaseService);

  // Register the sidebar view (shows "Open Panel" button)
  const sidebarProvider = new GraphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GraphViewProvider.viewType,
      sidebarProvider
    )
  );

  // Register the Playwright Tests tree view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      'monoid-visualize.playwrightTests',
      testTreeProvider
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

  // ==================== Test Commands ====================

  // Generate E2E test for current file
  const generateTestCommand = vscode.commands.registerCommand(
    'monoid-visualize.generateTest',
    async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showErrorMessage('No file is currently open');
        return;
      }
      const testPath = await testGenerator.generateTestForFile(activeEditor.document.uri);
      if (testPath) {
        testTreeProvider.addTestFile(testPath);
      }
    }
  );

  // Run all tests
  const runAllTestsCommand = vscode.commands.registerCommand(
    'monoid-visualize.runAllTests',
    async (headedArg?: boolean) => {
      // Use argument if provided, otherwise fall back to config
      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const headed = headedArg !== undefined ? headedArg : (config.get<boolean>('testHeadedMode') ?? true);
      await testRunner.runAllTests(headed);
    }
  );

  // Run a specific test file
  const runTestFileCommand = vscode.commands.registerCommand(
    'monoid-visualize.runTestFile',
    async (item?: TestTreeItem) => {
      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const headed = config.get<boolean>('testHeadedMode') ?? true;
      
      if (item && item.testData?.filePath) {
        await testRunner.runTestFile(item.testData.filePath, headed);
      } else {
        // If no item provided, try to get from active editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.fsPath.endsWith('.spec.ts')) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            const relativePath = path.relative(workspaceFolder.uri.fsPath, activeEditor.document.uri.fsPath);
            await testRunner.runTestFile(relativePath, headed);
          }
        }
      }
    }
  );

  // Run a specific test
  const runTestCommand = vscode.commands.registerCommand(
    'monoid-visualize.runTest',
    async (item?: TestTreeItem) => {
      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const headed = config.get<boolean>('testHeadedMode') ?? true;
      
      if (item && item.testData?.filePath && item.testData?.testName) {
        await testRunner.runTest(item.testData.filePath, item.testData.testName, headed);
      }
    }
  );

  // Debug a test
  const debugTestCommand = vscode.commands.registerCommand(
    'monoid-visualize.debugTest',
    async (item?: TestTreeItem) => {
      if (item && item.testData?.filePath) {
        await testRunner.debugTest(item.testData.filePath, item.testData.testName);
      }
    }
  );

  // Refresh tests
  const refreshTestsCommand = vscode.commands.registerCommand(
    'monoid-visualize.refreshTests',
    () => {
      testTreeProvider.refresh();
    }
  );

  // Open test file at specific line
  const openTestFileCommand = vscode.commands.registerCommand(
    'monoid-visualize.openTestFile',
    async (filePath: string, line: number) => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) { return; }

      try {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(doc);
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } catch (err) {
        console.error('Could not open test file:', err);
      }
    }
  );

  // Open Playwright UI mode
  const openPlaywrightUICommand = vscode.commands.registerCommand(
    'monoid-visualize.openPlaywrightUI',
    async () => {
      await testRunner.openUIMode();
    }
  );

  // Show test report
  const showTestReportCommand = vscode.commands.registerCommand(
    'monoid-visualize.showTestReport',
    async () => {
      await testRunner.showReport();
    }
  );

  // Regenerate test
  const regenerateTestCommand = vscode.commands.registerCommand(
    'monoid-visualize.regenerateTest',
    async (item?: TestTreeItem) => {
      if (item && item.testData?.filePath) {
        const testPath = await testGenerator.regenerateTest(item.testData.filePath);
        if (testPath) {
          testTreeProvider.refresh();
        }
      }
    }
  );

  // Generate tests for entire app
  const generateAllTestsCommand = vscode.commands.registerCommand(
    'monoid-visualize.generateAllTests',
    async () => {
      const testPaths = await testGenerator.generateTestsForEntireApp();
      if (testPaths.length > 0) {
        testTreeProvider.refresh();
      }
    }
  );

  // Open test panel webview
  const openTestPanelCommand = vscode.commands.registerCommand(
    'monoid-visualize.openTestPanel',
    async () => {
      await openTestPanel(context.extensionUri);
    }
  );

  // Delete all tests for current version
  const deleteAllTestsCommand = vscode.commands.registerCommand(
    'monoid-visualize.deleteAllTests',
    async () => {
      const versionId = TestPanelManager.getCurrentVersionId();
      if (!versionId) {
        vscode.window.showErrorMessage('No version selected. Open the test panel first.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete all tests for this version? This will remove all test data from Supabase and cannot be undone.`,
        { modal: true },
        'Delete All Tests'
      );

      if (confirm !== 'Delete All Tests') {
        return;
      }

      try {
        const result = await supabaseService.deleteAllTestsForVersion(versionId);
        vscode.window.showInformationMessage(`Deleted ${result.deleted} tests from Supabase.`);
        
        // Refresh the tree view and test panel
        testTreeProvider.refresh();
        TestPanelManager.refreshPanel();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to delete tests: ${error.message}`);
      }
    }
  );

  context.subscriptions.push(
    openPanelCommand,
    visualizeCommand,
    refreshCommand,
    helloWorldCommand,
    testLMCommand,
    generateTestCommand,
    runAllTestsCommand,
    runTestFileCommand,
    runTestCommand,
    debugTestCommand,
    refreshTestsCommand,
    openTestFileCommand,
    openPlaywrightUICommand,
    showTestReportCommand,
    regenerateTestCommand,
    generateAllTestsCommand,
    openTestPanelCommand,
    deleteAllTestsCommand
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

  // Log the panel opening details
  const config = vscode.workspace.getConfiguration('monoid-visualize');
  const dashboardUrl = config.get<string>('webAppUrl') || 'https://monoid-dashboard.vercel.app';
  const graphUrl = versionId ? `${dashboardUrl}/graph/${versionId}` : dashboardUrl;
  
  console.log('[Monoid] Opening graph panel:');
  console.log(`  Dashboard URL: ${dashboardUrl}`);
  console.log(`  Graph URL: ${graphUrl}`);
  console.log(`  Version ID: ${versionId || '(none - will show empty state)'}`);
  console.log(`  Workspace: ${workspaceSlug}`);
  console.log(`  Repo: ${repoSlug}`);

  GraphPanelManager.openPanel(extensionUri, workspaceSlug, repoSlug, versionId);
}

async function openTestPanel(extensionUri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const workspaceName = workspaceFolder.name;

  // Auto-detect GitHub info from git remote
  const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
  const repoOwner = gitInfo?.owner || 'local';
  const repoName = gitInfo?.repo || workspaceName;

  // Try to get the latest version ID from the repo
  let versionId: string | undefined;
  try {
    const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);
    
    // Get organization if we have an owner
    let organizationId: string | undefined;
    if (gitInfo?.owner) {
      const organization = await supabaseService.getOrCreateOrganization(gitInfo.owner);
      organizationId = organization.id;
    }
    
    const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);
    const version = await supabaseService.getLatestVersion(repo.id);
    if (version) {
      versionId = version.id;
    }
  } catch (err) {
    // No existing version, that's okay
    console.log('[Monoid Tests] Could not fetch version:', err);
  }

  // Log the panel opening details
  const config = vscode.workspace.getConfiguration('monoid-visualize');
  const dashboardUrl = config.get<string>('webAppUrl') || 'https://monoid-dashboard.vercel.app';
  const testUrl = versionId ? `${dashboardUrl}/tests/${versionId}` : dashboardUrl;
  
  console.log('[Monoid] Opening test panel:');
  console.log(`  Dashboard URL: ${dashboardUrl}`);
  console.log(`  Test URL: ${testUrl}`);
  console.log(`  Version ID: ${versionId || '(none - will show empty state)'}`);
  console.log(`  Repo: ${repoOwner}/${repoName}`);

  TestPanelManager.openPanel(extensionUri, versionId);
}

async function visualizeAllCode(extensionUri: vscode.Uri): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  // Auto-detect GitHub info from git remote, fall back to config
  const config = vscode.workspace.getConfiguration('monoid-visualize');
  const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
  
  const detectedOwner = gitInfo?.owner || config.get<string>('githubOwner');
  const detectedRepo = gitInfo?.repo || config.get<string>('githubRepo');
  const detectedBranch = gitInfo?.branch || config.get<string>('githubBranch') || 'main';
  
  let githubInfo: GitHubInfo | undefined;
  if (detectedOwner && detectedRepo) {
    githubInfo = {
      owner: detectedOwner,
      repo: detectedRepo,
      branch: detectedBranch
    };
    console.log(`[Monoid] GitHub info: ${detectedOwner}/${detectedRepo} (${detectedBranch})`);
  } else {
    console.log('[Monoid] No GitHub info detected, using local mode');
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

        const analysisResult = await analyzer.analyzeWorkspace(workspaceFolder, progress, githubInfo);
        
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

          // Create or get organization if GitHub owner is detected/configured
          let organizationId: string | undefined;
          if (detectedOwner) {
            const organization = await supabaseService.getOrCreateOrganization(detectedOwner);
            organizationId = organization.id;
            console.log(`[Monoid] Using organization: ${detectedOwner} (${organizationId})`);
          }

          // Create or get repo with proper owner and organization
          const repoOwner = detectedOwner || 'local';
          const repoName = detectedRepo || workspaceName;
          const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);
          const repoSlug = workspaceSlug;

          // Create new version with unique commit sha
          const commitSha = generateCommitSha();
          const version = await supabaseService.createVersion(repo.id, commitSha);

          // Log the version being created
          console.log('='.repeat(60));
          console.log('[Monoid] Supabase Save Details:');
          console.log(`  Organization: ${detectedOwner || '(none)'} ${organizationId ? `(${organizationId})` : ''}`);
          console.log(`  Workspace: ${workspaceName} (${workspace.id})`);
          console.log(`  Repo: ${repoOwner}/${repoName} (${repo.id})`);
          console.log(`  Version ID: ${version.id}`);
          console.log(`  Commit SHA: ${commitSha}`);
          console.log('='.repeat(60));

          progress.report({ message: 'Saving nodes...', increment: 70 });

          // Save nodes and get ID mapping
          const stableIdToId = await supabaseService.saveNodes(version.id, analysisResult.nodes);
          console.log(`[Monoid] Saved ${stableIdToId.size} nodes to version ${version.id}`);

          progress.report({ message: 'Saving edges...', increment: 85 });

          // Save edges
          await supabaseService.saveEdges(version.id, analysisResult.edges, stableIdToId);
          console.log(`[Monoid] Saved ${analysisResult.edges.length} edges to version ${version.id}`);

          // Update version counts
          await supabaseService.updateVersionCounts(version.id, nodeCount, edgeCount);

          progress.report({ message: 'Opening graph...', increment: 95 });

          // Open the panel with the new version
          const dashboardUrl = config.get<string>('webAppUrl') || 'https://monoid-dashboard.vercel.app';
          const graphUrl = `${dashboardUrl}/graph/${version.id}`;
          
          console.log('[Monoid] Opening graph panel:');
          console.log(`  Dashboard URL: ${dashboardUrl}`);
          console.log(`  Graph URL: ${graphUrl}`);
          console.log(`  Version ID: ${version.id}`);
          
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
