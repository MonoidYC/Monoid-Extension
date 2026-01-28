import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { CodeAnalyzer } from './analyzer';
import { SupabaseService } from './supabase/client';
import { GraphViewProvider, GraphPanelManager } from './webview/graphViewProvider';
import { TestPanelManager } from './webview/testViewProvider';
import { testVSCodeLM } from './analyzer/llmAnalyzer';
import { GitHubInfo, LocalNode, NodeType } from './types';
import { TestTreeProvider, TestTreeItem, TestGenerator, TestRunner } from './testing';
import { getGitHubInfoFromGit } from './utils/gitUtils';
import { initAuthService, getAuthService } from './auth';

let supabaseService: SupabaseService;
let analyzer: CodeAnalyzer;
let testTreeProvider: TestTreeProvider;
let testGenerator: TestGenerator;
let testRunner: TestRunner;

export function activate(context: vscode.ExtensionContext) {
  console.log('Monoid Visualize extension is now active!');

  // Initialize auth service first
  const authService = initAuthService(context);

  // Initialize services
  supabaseService = new SupabaseService();
  analyzer = new CodeAnalyzer();
  
  // Register URI handler for auth callback
  const uriHandler = vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
      console.log('[Monoid] Received URI:', uri.toString());
      
      if (uri.path === '/auth/callback') {
        authService.handleAuthCallback(uri).then(success => {
          if (success) {
            // Refresh panels to show authenticated state
            GraphPanelManager.refreshPanel();
            TestPanelManager.refreshPanel();
          }
        });
      }
    }
  });
  context.subscriptions.push(uriHandler);

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

  // Generate tests for entire app (filesystem-based)
  const generateAllTestsCommand = vscode.commands.registerCommand(
    'monoid-visualize.generateAllTests',
    async () => {
      const testPaths = await testGenerator.generateTestsForEntireApp();
      if (testPaths.length > 0) {
        testTreeProvider.refresh();
      }
    }
  );

  // Generate tests from code graph (code_nodes-based)
  const generateTestsFromCodeGraphCommand = vscode.commands.registerCommand(
    'monoid-visualize.generateTestsFromCodeGraph',
    async () => {
      const testPaths = await testGenerator.generateTestsFromCodeNodes();
      if (testPaths.length > 0) {
        testTreeProvider.refresh();
      }
    }
  );

  // Run benchmark comparison between filesystem and code_nodes methods
  const benchmarkTestGenerationCommand = vscode.commands.registerCommand(
    'monoid-visualize.benchmarkTestGeneration',
    async () => {
      await testGenerator.runBenchmarkComparison();
      testTreeProvider.refresh();
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

  // Sync existing tests to Supabase (without regenerating)
  const syncTestsCommand = vscode.commands.registerCommand(
    'monoid-visualize.syncTestsToSupabase',
    async () => {
      const count = await testGenerator.syncExistingTestsToSupabase();
      if (count > 0) {
        testTreeProvider.refresh();
        TestPanelManager.refreshPanel();
      }
    }
  );

  // Check if tests exist (used by webview)
  const checkTestsExistCommand = vscode.commands.registerCommand(
    'monoid-visualize.checkTestsExist',
    () => {
      return testGenerator.hasExistingTests();
    }
  );

  // Generate code node from natural language
  const generateCodeNodeCommand = vscode.commands.registerCommand(
    'monoid-visualize.generateCodeNode',
    async () => {
      await generateCodeNodeFromNaturalLanguage();
    }
  );

  // Generate test from natural language
  const generateTestFromNaturalLanguageCommand = vscode.commands.registerCommand(
    'monoid-visualize.generateTestFromNaturalLanguage',
    async () => {
      await generateTestFromNaturalLanguage();
    }
  );

  // ==================== Auth Commands ====================

  // Sign in command - opens browser for OAuth
  const signInCommand = vscode.commands.registerCommand(
    'monoid-visualize.signIn',
    async () => {
      await authService.startAuthFlow();
    }
  );

  // Sign out command
  const signOutCommand = vscode.commands.registerCommand(
    'monoid-visualize.signOut',
    async () => {
      await authService.signOut();
      GraphPanelManager.refreshPanel();
      TestPanelManager.refreshPanel();
    }
  );

  // Get auth session (used by webviews)
  const getAuthSessionCommand = vscode.commands.registerCommand(
    'monoid-visualize.getAuthSession',
    async () => {
      return await authService.getSession();
    }
  );

  // Check if authenticated
  const isAuthenticatedCommand = vscode.commands.registerCommand(
    'monoid-visualize.isAuthenticated',
    async () => {
      return await authService.isAuthenticated();
    }
  );

  // Paste session manually (for development/debugging when URI handler doesn't work)
  const pasteSessionCommand = vscode.commands.registerCommand(
    'monoid-visualize.pasteSession',
    async () => {
      const session = await vscode.window.showInputBox({
        prompt: 'Paste the session token from the browser (base64 encoded)',
        placeHolder: 'eyJhY2Nlc3NfdG9rZW4iOi4uLg==',
        ignoreFocusOut: true,
      });

      if (session) {
        const success = await authService.setSessionFromBase64(session);
        if (success) {
          GraphPanelManager.refreshPanel();
          TestPanelManager.refreshPanel();
        }
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
    generateTestsFromCodeGraphCommand,
    benchmarkTestGenerationCommand,
    openTestPanelCommand,
    deleteAllTestsCommand,
    syncTestsCommand,
    checkTestsExistCommand,
    generateCodeNodeCommand,
    generateTestFromNaturalLanguageCommand,
    signInCommand,
    signOutCommand,
    getAuthSessionCommand,
    isAuthenticatedCommand,
    pasteSessionCommand
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

        progress.report({ message: `Found ${nodeCount} nodes, ${edgeCount} edges`, increment: 40 });

        // Phase 2: Generate intelligent snippets AND summaries using Gemini
        GraphPanelManager.showLoading('Extracting snippets & summaries...');
        progress.report({ message: 'Extracting intelligent snippets with Gemini...', increment: 45 });

        const { getGeminiSummarizer } = await import('./analyzer/geminiSummarizer.js');
        const summarizer = getGeminiSummarizer();
        const snippetsAndSummaries = await summarizer.generateSnippetsAndSummaries(
          analysisResult.nodes, 
          workspaceFolder,
          progress
        );
        
        // Apply intelligent snippets AND summaries to nodes
        for (const node of analysisResult.nodes) {
          const result = snippetsAndSummaries.get(node.stable_id);
          if (result) {
            node.snippet = result.snippet;
            node.summary = result.summary;
          }
        }
        
        console.log(`[Monoid] Generated ${snippetsAndSummaries.size}/${nodeCount} intelligent snippets & summaries`);

        // Phase 3: Save to Supabase
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

/**
 * Generate a code node from natural language input using Gemini
 */
async function generateCodeNodeFromNaturalLanguage(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  // Get natural language input from user
  const description = await vscode.window.showInputBox({
    prompt: 'Describe the code you want to generate (e.g., "A React component that displays a user profile card")',
    placeHolder: 'Enter a natural language description of the code...',
    ignoreFocusOut: true,
  });

  if (!description) {
    return;
  }

  // Get file path where to create the code
  const filePath = await vscode.window.showInputBox({
    prompt: 'Enter the file path where to create the code (relative to workspace root)',
    placeHolder: 'e.g., components/UserProfile.tsx or app/api/users/route.ts',
    ignoreFocusOut: true,
  });

  if (!filePath) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating Code Node',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Generating code with Gemini...', increment: 0 });

        // Get Gemini API key
        const config = vscode.workspace.getConfiguration('monoid-visualize');
        const apiKey = config.get<string>('geminiApiKey');
        const model = config.get<string>('geminiModel') || 'gemini-3-flash-preview';

        if (!apiKey) {
          vscode.window.showErrorMessage('Gemini API key not configured. Set monoid-visualize.geminiApiKey in settings.');
          return;
        }

        // Generate code using Gemini
        const generatedCode = await callGeminiForCodeGeneration(apiKey, model, description, filePath);
        
        if (!generatedCode) {
          vscode.window.showErrorMessage('Failed to generate code from Gemini');
          return;
        }

        progress.report({ message: 'Extracting node information...', increment: 50 });

        // Extract node information from generated code
        const nodeInfo = extractNodeInfo(generatedCode, filePath);
        
        if (!nodeInfo) {
          vscode.window.showErrorMessage('Failed to extract node information from generated code');
          return;
        }

        progress.report({ message: 'Saving to Supabase...', increment: 75 });

        // Get or create workspace, repo, and version
        const workspaceName = workspaceFolder.name;
        const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);
        const workspaceSlug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Auto-detect GitHub info
        const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
        let organizationId: string | undefined;
        if (gitInfo?.owner) {
          const organization = await supabaseService.getOrCreateOrganization(gitInfo.owner);
          organizationId = organization.id;
        }

        const repoOwner = gitInfo?.owner || 'local';
        const repoName = gitInfo?.repo || workspaceName;
        const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);

        // Get or create version
        let version = await supabaseService.getLatestVersion(repo.id);
        if (!version) {
          const commitSha = generateCommitSha();
          version = await supabaseService.createVersion(repo.id, commitSha, gitInfo?.branch || 'main');
        }

        // Generate summary using Gemini
        progress.report({ message: 'Generating summary...', increment: 85 });
        const { getGeminiSummarizer } = await import('./analyzer/geminiSummarizer.js');
        const summarizer = getGeminiSummarizer();
        const summaryMap = await summarizer.generateSummaries([nodeInfo], progress);
        if (summaryMap.has(nodeInfo.stable_id)) {
          nodeInfo.summary = summaryMap.get(nodeInfo.stable_id);
        }

        // Save node to Supabase
        const stableIdToId = await supabaseService.saveNodes(version.id, [nodeInfo]);
        
        progress.report({ message: 'Complete!', increment: 100 });

        vscode.window.showInformationMessage(
          `Generated code node "${nodeInfo.name}" and saved to Supabase`
        );

        // Optionally create the file
        const createFile = await vscode.window.showQuickPick(
          ['Yes', 'No'],
          { placeHolder: 'Create the file in your workspace?' }
        );

        if (createFile === 'Yes') {
          const fullPath = path.join(workspaceFolder.uri.fsPath, filePath);
          const dir = path.dirname(fullPath);
          if (!require('fs').existsSync(dir)) {
            require('fs').mkdirSync(dir, { recursive: true });
          }
          require('fs').writeFileSync(fullPath, generatedCode, 'utf-8');
          const doc = await vscode.workspace.openTextDocument(fullPath);
          await vscode.window.showTextDocument(doc);
        }
      }
    );
  } catch (error: any) {
    console.error('Error generating code node:', error);
    vscode.window.showErrorMessage(`Failed to generate code node: ${error.message}`);
  }
}

/**
 * Generate a test from natural language input using Gemini
 */
async function generateTestFromNaturalLanguage(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  // Get natural language input from user
  const description = await vscode.window.showInputBox({
    prompt: 'Describe the test you want to generate (e.g., "Test that the login page validates email and password")',
    placeHolder: 'Enter a natural language description of the test...',
    ignoreFocusOut: true,
  });

  if (!description) {
    return;
  }

  // Get route/page to test
  const route = await vscode.window.showInputBox({
    prompt: 'Enter the route/page to test (e.g., /login or /dashboard)',
    placeHolder: '/login',
    ignoreFocusOut: true,
  });

  if (!route) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating Test',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Generating test with Gemini...', increment: 0 });

        // Get config
        const config = vscode.workspace.getConfiguration('monoid-visualize');
        const apiKey = config.get<string>('geminiApiKey');
        const model = config.get<string>('geminiModel') || 'gemini-3-flash-preview';
        const baseUrl = config.get<string>('testBaseUrl') || 'http://localhost:3000';
        const testOutputDir = config.get<string>('testOutputDir') || 'e2e';

        if (!apiKey) {
          vscode.window.showErrorMessage('Gemini API key not configured. Set monoid-visualize.geminiApiKey in settings.');
          return;
        }

        // Generate test using Gemini
        const testCode = await callGeminiForTestGeneration(apiKey, model, description, route, baseUrl);
        
        if (!testCode) {
          vscode.window.showErrorMessage('Failed to generate test from Gemini');
          return;
        }

        progress.report({ message: 'Saving test file...', increment: 50 });

        // Generate test file name from route
        const testFileName = route === '/' 
          ? 'homepage.spec.ts' 
          : `${route.replace(/^\//, '').replace(/\//g, '-')}.spec.ts`;
        const testFilePath = path.join(testOutputDir, testFileName);
        const absoluteTestPath = path.join(workspaceFolder.uri.fsPath, testFilePath);

        // Ensure test directory exists
        const testDirPath = path.dirname(absoluteTestPath);
        if (!require('fs').existsSync(testDirPath)) {
          require('fs').mkdirSync(testDirPath, { recursive: true });
        }

        // Write test file
        require('fs').writeFileSync(absoluteTestPath, testCode, 'utf-8');

        progress.report({ message: 'Saving to Supabase...', increment: 75 });

        // Get or create workspace, repo, and version
        const workspaceName = workspaceFolder.name;
        const workspace = await supabaseService.getOrCreateWorkspace(workspaceName);

        const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
        let organizationId: string | undefined;
        if (gitInfo?.owner) {
          const organization = await supabaseService.getOrCreateOrganization(gitInfo.owner);
          organizationId = organization.id;
        }

        const repoOwner = gitInfo?.owner || 'local';
        const repoName = gitInfo?.repo || workspaceName;
        const repo = await supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);

        // Get or create version
        let version = await supabaseService.getLatestVersion(repo.id);
        if (!version) {
          const commitSha = generateCommitSha();
          version = await supabaseService.createVersion(repo.id, commitSha, gitInfo?.branch || 'main');
        }

        // Parse test names from the generated code
        const testPattern = /test\s*\(\s*['"`]([^'"`]+)['"`]/g;
        const tests: any[] = [];
        const lines = testCode.split('\n');
        let match;

        for (let i = 0; i < lines.length; i++) {
          const lineMatch = lines[i].match(/test\s*\(\s*['"`]([^'"`]+)['"`]/);
          if (lineMatch) {
            tests.push({
              stable_id: `${testFilePath}::${lineMatch[1]}`,
              name: lineMatch[1],
              description: `E2E test: ${lineMatch[1]}`,
              test_type: 'e2e',
              source_type: 'generated',
              file_path: testFilePath,
              start_line: i + 1,
              runner: 'playwright',
              command: `npx playwright test ${testFilePath} -g "${lineMatch[1]}"`,
              metadata: {
                route: route,
                generatedFrom: 'natural-language',
                description: description
              }
            });
          }
        }

        if (tests.length > 0) {
          await supabaseService.saveTestNodes(version.id, tests);
          testTreeProvider.refresh();
        }

        progress.report({ message: 'Complete!', increment: 100 });

        vscode.window.showInformationMessage(
          `Generated test with ${tests.length} test case(s) and saved to Supabase`
        );

        // Open the test file
        const doc = await vscode.workspace.openTextDocument(absoluteTestPath);
        await vscode.window.showTextDocument(doc);
      }
    );
  } catch (error: any) {
    console.error('Error generating test:', error);
    vscode.window.showErrorMessage(`Failed to generate test: ${error.message}`);
  }
}

/**
 * Call Gemini API to generate code from natural language
 */
async function callGeminiForCodeGeneration(
  apiKey: string,
  model: string,
  description: string,
  filePath: string
): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  // Determine language and type from file path
  const isTypeScript = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
  const isComponent = filePath.includes('components/') || filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
  const isApiRoute = filePath.includes('/api/') || filePath.includes('/route.');
  const language = isTypeScript ? 'TypeScript' : 'JavaScript';

  let codeType = 'function';
  if (isComponent) {
    codeType = 'React component';
  } else if (isApiRoute) {
    codeType = 'API route handler';
  }

  const prompt = `Generate a ${codeType} in ${language} based on this description:

${description}

File path: ${filePath}

Requirements:
1. Generate complete, production-ready code
2. Include proper imports and exports
3. Follow best practices for ${codeType}
4. Include TypeScript types if applicable
5. Add helpful comments where appropriate

Generate ONLY the code, no explanations or markdown. The code should be ready to use.`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      // Extract code from markdown code block if present
      const codeBlockMatch = text.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
      return codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();
    }

    return null;
  } catch (error: any) {
    console.error('Gemini API error:', error);
    throw error;
  }
}

/**
 * Call Gemini API to generate test from natural language
 */
async function callGeminiForTestGeneration(
  apiKey: string,
  model: string,
  description: string,
  route: string,
  baseUrl: string
): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const prompt = `Generate a comprehensive Playwright E2E test based on this description:

${description}

Route: ${route}
Base URL: ${baseUrl}

Requirements:
1. Use Playwright's @playwright/test package
2. Use semantic selectors: getByRole, getByText, getByLabel, getByTestId
3. Test the functionality described: ${description}
4. Include proper assertions (expect statements)
5. Handle async operations with proper waits
6. Add meaningful test descriptions
7. Include a test.describe block with the route name
8. Start with a test that verifies the page loads correctly

Generate ONLY the TypeScript test code, no explanations or markdown. The code should be ready to run with Playwright.
Format: Start with imports, then test.describe block containing multiple test() blocks.`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      // Extract code from markdown code block if present
      let code = text;
      const codeBlockMatch = text.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        code = codeBlockMatch[1];
      }

      // Ensure it has the necessary imports
      if (!code.includes('@playwright/test')) {
        code = `import { test, expect } from '@playwright/test';\n\n${code}`;
      }

      return code.trim();
    }

    return null;
  } catch (error: any) {
    console.error('Gemini API error:', error);
    throw error;
  }
}

/**
 * Extract node information from generated code (similar to extract-node route)
 */
function extractNodeInfo(code: string, filePath: string): LocalNode | null {
  // Node type detection patterns
  const NODE_TYPE_PATTERNS: Array<{ type: string; patterns: RegExp[] }> = [
    { type: 'component', patterns: [/^(export\s+)?(default\s+)?function\s+[A-Z]/, /^const\s+[A-Z]\w+\s*[=:]\s*\(?\s*\{?.*\)?\s*=>/] },
    { type: 'hook', patterns: [/^(export\s+)?(const|function)\s+use[A-Z]/] },
    { type: 'class', patterns: [/^(export\s+)?(abstract\s+)?class\s+\w+/] },
    { type: 'interface', patterns: [/^(export\s+)?interface\s+\w+/] },
    { type: 'type', patterns: [/^(export\s+)?type\s+\w+/] },
    { type: 'endpoint', patterns: [/^(export\s+)?(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)/] },
    { type: 'handler', patterns: [/handler|Handler/, /^(export\s+)?(async\s+)?function\s+handle[A-Z]/] },
    { type: 'middleware', patterns: [/middleware|Middleware/, /^(export\s+)?(async\s+)?function\s+\w+Middleware/] },
    { type: 'constant', patterns: [/^(export\s+)?const\s+[A-Z_]+\s*=/] },
    { type: 'function', patterns: [/^(export\s+)?(async\s+)?function\s+\w+/, /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/] },
  ];

  function detectNodeType(code: string): string {
    const lines = code.split('\n');
    const firstNonEmptyLine = lines.find(line => line.trim().length > 0)?.trim() || '';

    for (const { type, patterns } of NODE_TYPE_PATTERNS) {
      if (patterns.some(pattern => pattern.test(firstNonEmptyLine) || pattern.test(code))) {
        return type;
      }
    }

    return 'other';
  }

  function extractName(code: string): string {
    const patterns = [
      /function\s+([A-Za-z_$][\w$]*)/,
      /class\s+([A-Za-z_$][\w$]*)/,
      /const\s+([A-Za-z_$][\w$]*)\s*[=:]/,
      /interface\s+([A-Za-z_$][\w$]*)/,
      /type\s+([A-Za-z_$][\w$]*)/,
      /export\s+default\s+function\s+([A-Za-z_$][\w$]*)/,
    ];

    for (const pattern of patterns) {
      const match = code.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return 'UnnamedNode';
  }

  function extractSignature(code: string, nodeType: string): string | null {
    const lines = code.split('\n');
    
    if (['function', 'method', 'handler', 'endpoint', 'hook', 'component'].includes(nodeType)) {
      for (const line of lines) {
        if (/function\s+\w+|const\s+\w+\s*=|=>\s*{/.test(line)) {
          return line.trim();
        }
      }
    }

    if (nodeType === 'class') {
      const match = code.match(/class\s+\w+[^{]*/);
      return match ? match[0].trim() : null;
    }

    if (nodeType === 'interface' || nodeType === 'type') {
      const match = code.match(/(interface|type)\s+\w+[^{=]*/);
      return match ? match[0].trim() : null;
    }

    return null;
  }

  const nodeType = detectNodeType(code) as NodeType;
  const name = extractName(code);
  const signature = extractSignature(code, nodeType);
  const lines = code.split('\n');
  const startLine = 1;
  const endLine = lines.length;

  return {
    stable_id: `${filePath}::${name}`,
    name,
    qualified_name: `${filePath}::${name}`,
    node_type: nodeType,
    language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
    file_path: filePath,
    start_line: startLine,
    end_line: endLine,
    snippet: code.substring(0, 1000),
    signature: signature || undefined,
    metadata: {
      generated: true,
      generatedFrom: 'natural-language'
    }
  };
}

export function deactivate() {}
