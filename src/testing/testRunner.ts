import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { spawn, ChildProcess } from 'child_process';
import { TestStatus, TestStatusUpdate } from './types';
import { TestTreeProvider } from './testTreeProvider';
import { SupabaseService } from '../supabase/client';
import { getGitHubInfoFromGit } from '../utils/gitUtils';

/**
 * Playwright JSON reporter result structure
 * See: https://playwright.dev/docs/test-reporters#json-reporter
 */
interface PlaywrightTestResultEntry {
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  duration: number;
  error?: { message: string; stack?: string };
  errors?: Array<{ message: string }>;
}

interface PlaywrightTest {
  title: string;
  results: PlaywrightTestResultEntry[];
}

interface PlaywrightSpec {
  title: string;
  file: string;
  line: number;
  tests: PlaywrightTest[];
}

interface PlaywrightSuite {
  title: string;
  file?: string;
  specs: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

interface PlaywrightReport {
  suites: PlaywrightSuite[];
}

// Our normalized test result
interface ParsedTestResult {
  title: string;
  status: string;
  duration: number;
  errors?: Array<{ message: string }>;
  filePath: string;
}

/**
 * Test runner that executes Playwright tests with real-time output
 */
export class TestRunner {
  private outputChannel: vscode.OutputChannel;
  private terminal: vscode.Terminal | undefined;
  private treeProvider: TestTreeProvider;
  private supabaseService: SupabaseService;
  private runningTests: Map<string, { startTime: Date; testNodeId?: string }> = new Map();
  private currentProcess: ChildProcess | undefined;

  constructor(treeProvider: TestTreeProvider, supabaseService: SupabaseService) {
    this.outputChannel = vscode.window.createOutputChannel('Playwright Tests');
    this.treeProvider = treeProvider;
    this.supabaseService = supabaseService;

    // Listen for terminal close
    vscode.window.onDidCloseTerminal(closedTerminal => {
      if (closedTerminal === this.terminal) {
        this.terminal = undefined;
      }
    });
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  /**
   * Check if the test server is running at the configured base URL
   */
  private async checkServerRunning(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const baseUrl = config.get<string>('testBaseUrl') || 'http://localhost:3000';

    this.log(`Checking if server is running at ${baseUrl}...`);

    return new Promise((resolve) => {
      const url = new URL(baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;
      const timeout = 5000; // 5 second timeout

      const req = protocol.get(baseUrl, { timeout }, (res) => {
        // Any response means server is up (even 404, 500, etc.)
        this.log(`Server responded with status: ${res.statusCode}`);
        resolve(true);
      });

      req.on('error', (err: any) => {
        if (err.code === 'ECONNREFUSED') {
          this.log(`Server not running at ${baseUrl} (connection refused)`);
        } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
          this.log(`Server not responding at ${baseUrl} (timeout)`);
        } else {
          this.log(`Server check failed: ${err.message}`);
        }
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        this.log(`Server not responding at ${baseUrl} (timeout)`);
        resolve(false);
      });
    });
  }

  /**
   * Prompt user when server is not running
   */
  private async promptServerNotRunning(): Promise<'start' | 'continue' | 'cancel'> {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const baseUrl = config.get<string>('testBaseUrl') || 'http://localhost:3000';

    const result = await vscode.window.showWarningMessage(
      `Server is not running at ${baseUrl}. Tests will fail without a running server.`,
      { modal: true },
      'Start Server (npm run dev)',
      'Run Tests Anyway',
      'Cancel'
    );

    if (result === 'Start Server (npm run dev)') {
      return 'start';
    } else if (result === 'Run Tests Anyway') {
      return 'continue';
    }
    return 'cancel';
  }

  /**
   * Start the dev server in a new terminal
   */
  private startDevServer(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    
    const serverTerminal = vscode.window.createTerminal({
      name: 'Dev Server',
      cwd: workspaceFolder?.uri.fsPath,
      iconPath: new vscode.ThemeIcon('server')
    });

    serverTerminal.show();
    serverTerminal.sendText('npm run dev');

    vscode.window.showInformationMessage(
      'Starting dev server... Please wait for it to be ready, then run your tests again.'
    );
  }

  /**
   * Ensure server is running before tests, return false if tests should not proceed
   */
  private async ensureServerRunning(): Promise<boolean> {
    const serverRunning = await this.checkServerRunning();
    
    if (!serverRunning) {
      const action = await this.promptServerNotRunning();
      
      if (action === 'start') {
        this.startDevServer();
        return false; // User needs to run tests again after server starts
      } else if (action === 'cancel') {
        this.log('Test run cancelled - server not running');
        return false;
      }
      // 'continue' - user wants to run anyway
      this.log('Running tests despite server being down (user choice)');
    }
    
    return true;
  }

  /**
   * Get or create the Playwright terminal
   */
  private getTerminal(): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      return this.terminal;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    
    this.terminal = vscode.window.createTerminal({
      name: 'Playwright Tests',
      cwd: workspaceFolder?.uri.fsPath,
      iconPath: new vscode.ThemeIcon('beaker')
    });

    return this.terminal;
  }

  /**
   * Run all tests
   */
  async runAllTests(headed: boolean = true): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const testDir = config.get<string>('testOutputDir') || 'e2e';
    const testDirPath = path.join(workspaceFolder.uri.fsPath, testDir);

    if (!fs.existsSync(testDirPath)) {
      vscode.window.showErrorMessage(`Test directory not found: ${testDir}`);
      return;
    }

    // Check if Playwright is installed
    if (!await this.checkPlaywrightInstalled(workspaceFolder.uri.fsPath)) {
      return;
    }

    // Check if server is running
    if (!await this.ensureServerRunning()) {
      return;
    }

    // Mark all tests as running
    const testFiles = this.treeProvider.getTestFiles();
    for (const file of testFiles) {
      this.treeProvider.setFileTestsStatus(file.filePath, 'running');
      for (const test of file.tests) {
        this.runningTests.set(test.id, { startTime: new Date(), testNodeId: test.supabaseId });
      }
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const resultsDir = path.join(workspacePath, 'test-results');
    const resultsFile = path.join(resultsDir, 'results.json');
    
    // Create results directory
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    // Build args
    const args = ['playwright', 'test', testDir, '--reporter=list', '--reporter=json'];
    if (headed) {
      args.push('--headed');
    }

    this.log('');
    this.log('='.repeat(60));
    this.log(`Running all tests`);
    this.log(`Command: npx ${args.join(' ')}`);
    this.log(`Working directory: ${workspacePath}`);
    this.log(`Results will be written to: ${resultsFile}`);
    this.log('='.repeat(60));
    this.outputChannel.show(true);

    // Run with spawn to get direct callback when done
    await this.runPlaywrightProcess(args, workspacePath, resultsFile);
  }

  /**
   * Run Playwright using spawn and parse results when done
   */
  private async runPlaywrightProcess(args: string[], workspacePath: string, resultsFile: string): Promise<void> {
    return new Promise((resolve) => {
      // Kill any existing process
      if (this.currentProcess) {
        this.currentProcess.kill();
      }

      this.log(`[Process] Starting: npx ${args.join(' ')}`);

      // Spawn npx playwright
      const process = spawn('npx', args, {
        cwd: workspacePath,
        env: {
          ...globalThis.process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile,
          FORCE_COLOR: '1' // Enable colored output
        },
        shell: true
      });

      this.currentProcess = process;

      // Stream stdout to output channel
      process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.log(text.trimEnd());
      });

      // Stream stderr to output channel
      process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.log(text.trimEnd());
      });

      // Handle process completion
      process.on('close', async (code) => {
        this.log('');
        this.log('='.repeat(60));
        this.log(`[Process] Playwright finished with exit code: ${code}`);
        this.log('='.repeat(60));

        this.currentProcess = undefined;

        // Parse and update results
        await this.parseAndUpdateResults(workspacePath, resultsFile);

        resolve();
      });

      process.on('error', (err) => {
        this.log(`[Process] Error: ${err.message}`);
        this.currentProcess = undefined;
        resolve();
      });
    });
  }

  /**
   * Run a specific test file
   */
  async runTestFile(filePath: string, headed: boolean = true): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const absolutePath = path.join(workspaceFolder.uri.fsPath, filePath);
    if (!fs.existsSync(absolutePath)) {
      vscode.window.showErrorMessage(`Test file not found: ${filePath}`);
      return;
    }

    // Check if Playwright is installed
    if (!await this.checkPlaywrightInstalled(workspaceFolder.uri.fsPath)) {
      return;
    }

    // Check if server is running
    if (!await this.ensureServerRunning()) {
      return;
    }

    // Mark tests as running
    this.treeProvider.setFileTestsStatus(filePath, 'running');
    const tests = this.treeProvider.getTestsForFile(filePath);
    for (const test of tests) {
      this.runningTests.set(test.id, { startTime: new Date(), testNodeId: test.supabaseId });
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const resultsDir = path.join(workspacePath, 'test-results');
    const resultsFile = path.join(resultsDir, 'results.json');
    
    // Create results directory
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    // Build args
    const args = ['playwright', 'test', filePath, '--reporter=list', '--reporter=json'];
    if (headed) {
      args.push('--headed');
    }

    this.log('');
    this.log('='.repeat(60));
    this.log(`Running test file: ${filePath}`);
    this.log(`Command: npx ${args.join(' ')}`);
    this.log(`Results will be written to: ${resultsFile}`);
    this.log('='.repeat(60));
    this.outputChannel.show(true);

    // Run with spawn
    await this.runPlaywrightProcess(args, workspacePath, resultsFile);
  }

  /**
   * Run a specific test by name
   */
  async runTest(filePath: string, testName: string, headed: boolean = true): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const absolutePath = path.join(workspaceFolder.uri.fsPath, filePath);
    if (!fs.existsSync(absolutePath)) {
      vscode.window.showErrorMessage(`Test file not found: ${filePath}`);
      return;
    }

    // Check if Playwright is installed
    if (!await this.checkPlaywrightInstalled(workspaceFolder.uri.fsPath)) {
      return;
    }

    // Check if server is running
    if (!await this.ensureServerRunning()) {
      return;
    }

    // Mark test as running
    this.treeProvider.updateTestStatus(filePath, testName, 'running');
    const testId = `${filePath}::${testName}`;
    this.runningTests.set(testId, { startTime: new Date() });

    const workspacePath = workspaceFolder.uri.fsPath;
    const resultsDir = path.join(workspacePath, 'test-results');
    const resultsFile = path.join(resultsDir, 'results.json');
    
    // Create results directory
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    // Build args with grep to filter specific test
    const escapedTestName = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const args = ['playwright', 'test', filePath, '-g', escapedTestName, '--reporter=list', '--reporter=json'];
    if (headed) {
      args.push('--headed');
    }

    this.log('');
    this.log('='.repeat(60));
    this.log(`Running test: ${testName}`);
    this.log(`File: ${filePath}`);
    this.log(`Command: npx ${args.join(' ')}`);
    this.log(`Results will be written to: ${resultsFile}`);
    this.log('='.repeat(60));
    this.outputChannel.show(true);

    // Run with spawn
    await this.runPlaywrightProcess(args, workspacePath, resultsFile);
  }

  /**
   * Update test status after execution (to be called from terminal watcher or manually)
   */
  async updateTestResult(
    filePath: string,
    testName: string,
    status: TestStatus,
    error?: string
  ): Promise<void> {
    const testId = `${filePath}::${testName}`;
    const runInfo = this.runningTests.get(testId);

    // Update tree view
    this.treeProvider.updateTestStatus(filePath, testName, status);

    // Update Supabase if we have a test node ID
    if (runInfo?.testNodeId) {
      const duration = runInfo ? Date.now() - runInfo.startTime.getTime() : undefined;
      
      const statusUpdate: TestStatusUpdate = {
        last_status: status,
        last_run_at: new Date().toISOString(),
        last_duration_ms: duration,
        last_error: error || null
      };

      try {
        await this.supabaseService.updateTestStatus(runInfo.testNodeId, statusUpdate);
        this.log(`Updated test status in Supabase: ${testName} -> ${status}`);
      } catch (err: any) {
        this.log(`Failed to update Supabase: ${err.message}`);
      }
    }

    // Clean up
    this.runningTests.delete(testId);
  }

  /**
   * Mark all running tests with a status (e.g., when terminal closes)
   */
  markAllRunningAs(status: TestStatus): void {
    for (const [testId, runInfo] of this.runningTests) {
      const [filePath, testName] = testId.split('::');
      if (filePath && testName) {
        this.treeProvider.updateTestStatus(filePath, testName, status);
      }
    }
    this.runningTests.clear();
  }

  /**
   * Check if Playwright is installed
   */
  private async checkPlaywrightInstalled(workspacePath: string): Promise<boolean> {
    const packageJsonPath = path.join(workspacePath, 'package.json');
    
    if (!fs.existsSync(packageJsonPath)) {
      const install = await vscode.window.showWarningMessage(
        'No package.json found. Would you like to initialize Playwright?',
        'Initialize Playwright',
        'Cancel'
      );

      if (install === 'Initialize Playwright') {
        await this.initializePlaywright();
      }
      return false;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (!deps['@playwright/test']) {
        const install = await vscode.window.showWarningMessage(
          'Playwright is not installed. Would you like to install it?',
          'Install Playwright',
          'Cancel'
        );

        if (install === 'Install Playwright') {
          await this.initializePlaywright();
          return false; // Let user run again after installation
        }
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Initialize Playwright in the workspace
   */
  private async initializePlaywright(): Promise<void> {
    const terminal = this.getTerminal();
    terminal.show();
    terminal.sendText('npm init playwright@latest');

    vscode.window.showInformationMessage(
      'Initializing Playwright. Please follow the prompts in the terminal.'
    );
  }

  /**
   * Open Playwright UI mode
   */
  async openUIMode(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    if (!await this.checkPlaywrightInstalled(workspaceFolder.uri.fsPath)) {
      return;
    }

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const testDir = config.get<string>('testOutputDir') || 'e2e';

    const command = `npx playwright test ${testDir} --ui`;

    this.log('');
    this.log('Opening Playwright UI Mode...');

    const terminal = this.getTerminal();
    terminal.show();
    terminal.sendText(command);
  }

  /**
   * Show Playwright test report
   */
  async showReport(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const terminal = this.getTerminal();
    terminal.show();
    terminal.sendText('npx playwright show-report');
  }

  /**
   * Debug a specific test
   */
  async debugTest(filePath: string, testName?: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    if (!await this.checkPlaywrightInstalled(workspaceFolder.uri.fsPath)) {
      return;
    }

    let command = `npx playwright test ${filePath} --debug`;
    if (testName) {
      const escapedTestName = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      command += ` -g "${escapedTestName}"`;
    }

    const terminal = this.getTerminal();
    terminal.show();
    terminal.sendText(command);
  }

  /**
   * Parse Playwright JSON results and update Supabase
   */
  private async parseAndUpdateResults(workspacePath: string, resultsFile: string): Promise<void> {
    this.log(`[ParseResults] ========================================`);
    this.log(`[ParseResults] Starting to parse results...`);
    this.log(`[ParseResults] Workspace: ${workspacePath}`);
    this.log(`[ParseResults] Results file: ${resultsFile}`);
    
    if (!fs.existsSync(resultsFile)) {
      this.log(`[ParseResults] ERROR: Results file does not exist at ${resultsFile}`);
      // List what's in the test-results directory
      const resultsDir = path.dirname(resultsFile);
      if (fs.existsSync(resultsDir)) {
        const files = fs.readdirSync(resultsDir);
        this.log(`[ParseResults] Files in ${resultsDir}: ${files.join(', ')}`);
      }
      return;
    }

    try {
      const resultsContent = fs.readFileSync(resultsFile, 'utf-8');
      this.log(`[ParseResults] Read file, size: ${resultsContent.length} bytes`);
      
      // Log first 500 chars of content for debugging
      this.log(`[ParseResults] Content preview: ${resultsContent.substring(0, 500)}...`);
      
      const report: PlaywrightReport = JSON.parse(resultsContent);
      this.log(`[ParseResults] Parsed JSON, suites count: ${report.suites?.length || 0}`);

      // Extract all test results from the report
      const testResults = this.extractTestResults(report.suites || [], workspacePath);
      this.log(`[ParseResults] Extracted ${testResults.length} test results`);

      // Log each result
      for (const result of testResults) {
        this.log(`[ParseResults] Test: "${result.title}" in ${result.filePath} -> ${result.status}`);
      }

      // Get version ID for Supabase updates
      this.log(`[ParseResults] Getting version ID for Supabase...`);
      const versionId = await this.getVersionId(workspacePath);
      this.log(`[ParseResults] Version ID: ${versionId || 'NOT FOUND'}`);

      if (!versionId) {
        this.log(`[ParseResults] WARNING: No version ID found, skipping Supabase updates`);
      }

      // Update each test
      for (const result of testResults) {
        const status = this.mapPlaywrightStatus(result.status);
        
        // Update tree view
        this.treeProvider.updateTestStatus(result.filePath, result.title, status);

        // Update Supabase if we have version ID
        if (versionId) {
          await this.updateTestInSupabase(versionId, result);
        }
      }

      // Refresh the tree view
      this.treeProvider.refresh();

      // Show summary notification
      const passed = testResults.filter(t => t.status === 'passed').length;
      const failed = testResults.filter(t => t.status === 'failed').length;
      const skipped = testResults.filter(t => t.status === 'skipped').length;

      if (failed > 0) {
        vscode.window.showWarningMessage(
          `Tests completed: ${passed} passed, ${failed} failed, ${skipped} skipped`
        );
      } else if (passed > 0 || skipped > 0) {
        vscode.window.showInformationMessage(
          `Tests completed: ${passed} passed, ${skipped} skipped`
        );
      }

      this.log(`[ParseResults] Final results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
      this.log(`[ParseResults] ========================================`);

      // Clear running tests
      this.runningTests.clear();

    } catch (error: any) {
      this.log(`[ParseResults] ERROR parsing results: ${error.message}`);
      if (error.stack) {
        this.log(`[ParseResults] Stack: ${error.stack}`);
      }
    }
  }

  /**
   * Extract test results from Playwright report suites
   */
  private extractTestResults(
    suites: PlaywrightSuite[],
    workspacePath: string,
    results: ParsedTestResult[] = []
  ): ParsedTestResult[] {
    for (const suite of suites) {
      // Process specs in this suite
      for (const spec of suite.specs || []) {
        let filePath = spec.file || suite.file || '';
        
        // Normalize the file path
        // If it's an absolute path, make it relative to workspace
        // If it's already relative, use it as-is
        if (filePath) {
          if (path.isAbsolute(filePath)) {
            filePath = path.relative(workspacePath, filePath);
          }
          // Remove any leading ./ if present
          if (filePath.startsWith('./')) {
            filePath = filePath.slice(2);
          }
        }
        
        this.log(`[ExtractResults] File: ${spec.file} -> normalized: ${filePath}`);
        
        for (const test of spec.tests || []) {
          // In Playwright JSON, each test has a results array (one entry per retry)
          // We take the last result (final outcome after retries)
          const lastResult = test.results?.[test.results.length - 1];
          const status = lastResult?.status || 'pending';
          const duration = lastResult?.duration || 0;
          
          // Collect errors from the result
          const errors: Array<{ message: string }> = [];
          if (lastResult?.error) {
            errors.push({ message: lastResult.error.message || lastResult.error.stack || 'Unknown error' });
          }
          if (lastResult?.errors) {
            errors.push(...lastResult.errors);
          }
          
          this.log(`[ExtractResults] Test: "${test.title}" status: ${status}, duration: ${duration}ms`);
          
          results.push({
            title: test.title || spec.title,
            status,
            duration,
            errors: errors.length > 0 ? errors : undefined,
            filePath
          });
        }
      }

      // Recursively process nested suites
      if (suite.suites) {
        this.extractTestResults(suite.suites, workspacePath, results);
      }
    }

    return results;
  }

  /**
   * Map Playwright status to our TestStatus
   */
  private mapPlaywrightStatus(status: string): TestStatus {
    switch (status) {
      case 'passed':
        return 'passed';
      case 'failed':
      case 'timedOut':
      case 'interrupted':
        return 'failed';
      case 'skipped':
        return 'skipped';
      default:
        return 'pending';
    }
  }

  /**
   * Get the current version ID for Supabase
   */
  private async getVersionId(workspacePath: string): Promise<string | undefined> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this.log(`[GetVersionId] ERROR: No workspace folder`);
        return undefined;
      }

      const workspaceName = workspaceFolder.name;
      this.log(`[GetVersionId] Workspace name: ${workspaceName}`);
      
      const gitInfo = await getGitHubInfoFromGit(workspacePath);
      this.log(`[GetVersionId] Git info: ${gitInfo ? `${gitInfo.owner}/${gitInfo.repo}` : 'not found'}`);
      
      const repoOwner = gitInfo?.owner || 'local';
      const repoName = gitInfo?.repo || workspaceName;
      this.log(`[GetVersionId] Using repo: ${repoOwner}/${repoName}`);

      const workspace = await this.supabaseService.getOrCreateWorkspace(workspaceName);
      this.log(`[GetVersionId] Workspace ID: ${workspace.id}`);
      
      let organizationId: string | undefined;
      if (gitInfo?.owner) {
        const organization = await this.supabaseService.getOrCreateOrganization(gitInfo.owner);
        organizationId = organization.id;
        this.log(`[GetVersionId] Organization ID: ${organizationId}`);
      }

      const repo = await this.supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);
      this.log(`[GetVersionId] Repo ID: ${repo.id}`);
      
      const version = await this.supabaseService.getLatestVersion(repo.id);
      this.log(`[GetVersionId] Version: ${version ? version.id : 'NOT FOUND'}`);
      
      return version?.id;
    } catch (error: any) {
      this.log(`[GetVersionId] ERROR: ${error.message}`);
      if (error.stack) {
        this.log(`[GetVersionId] Stack: ${error.stack}`);
      }
      return undefined;
    }
  }

  /**
   * Update a test's status in Supabase
   */
  private async updateTestInSupabase(
    versionId: string,
    result: ParsedTestResult
  ): Promise<void> {
    try {
      const stableId = `${result.filePath}::${result.title}`;
      this.log(`[UpdateSupabase] Looking for test with stableId: ${stableId}`);
      this.log(`[UpdateSupabase] Version ID: ${versionId}`);
      
      // Try to find the test node by stable_id
      const testNode = await this.supabaseService.getTestNodeByStableId(versionId, stableId);
      
      if (testNode) {
        this.log(`[UpdateSupabase] Found test node: ${testNode.id}`);
        const status = this.mapPlaywrightStatus(result.status);
        const errorMessage = result.errors?.map(e => e.message).join('\n') || null;

        const statusUpdate: TestStatusUpdate = {
          last_status: status,
          last_run_at: new Date().toISOString(),
          last_duration_ms: result.duration,
          last_error: errorMessage
        };

        this.log(`[UpdateSupabase] Updating status to: ${JSON.stringify(statusUpdate)}`);
        await this.supabaseService.updateTestStatus(testNode.id, statusUpdate);
        this.log(`[UpdateSupabase] SUCCESS: ${result.title} -> ${status}`);
      } else {
        this.log(`[UpdateSupabase] WARNING: Test node NOT FOUND for stableId: ${stableId}`);
        this.log(`[UpdateSupabase] This means the test was not saved to Supabase during generation`);
      }
    } catch (error: any) {
      this.log(`[UpdateSupabase] ERROR: ${error.message}`);
      if (error.stack) {
        this.log(`[UpdateSupabase] Stack: ${error.stack}`);
      }
    }
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.terminal?.dispose();
    this.outputChannel.dispose();
    this.currentProcess?.kill();
  }
}
