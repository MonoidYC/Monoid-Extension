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
  video?: string | { path: string };
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
  videoPath?: string;
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

    // Ensure playwright config has video settings
    await this.ensurePlaywrightConfig(workspacePath, config.get<string>('testVideoMode') || 'retain-on-failure');

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

    // Ensure playwright config has video settings
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    await this.ensurePlaywrightConfig(workspacePath, config.get<string>('testVideoMode') || 'retain-on-failure');

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

    // Ensure playwright config has video settings
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    await this.ensurePlaywrightConfig(workspacePath, config.get<string>('testVideoMode') || 'retain-on-failure');

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
   * Ensure playwright.config.ts exists with video settings
   */
  private async ensurePlaywrightConfig(workspacePath: string, videoMode: string): Promise<void> {
    const configPath = path.join(workspacePath, 'playwright.config.ts');
    const configPathJs = path.join(workspacePath, 'playwright.config.js');
    const configPathMjs = path.join(workspacePath, 'playwright.config.mjs');

    // Check which config file exists
    let configFile = '';
    if (fs.existsSync(configPath)) {
      configFile = configPath;
    } else if (fs.existsSync(configPathJs)) {
      configFile = configPathJs;
    } else if (fs.existsSync(configPathMjs)) {
      configFile = configPathMjs;
    }

    // Map video mode to Playwright's use.video option
    const videoValue = videoMode === 'off' ? 'off' : 
                       videoMode === 'on' ? 'on' :
                       videoMode === 'retain-on-failure' ? 'retain-on-failure' :
                       videoMode === 'on-first-retry' ? 'on-first-retry' : 'retain-on-failure';

    if (configFile) {
      // Update existing config file
      try {
        let content = fs.readFileSync(configFile, 'utf-8');
        
        // Check if video is already configured
        if (content.includes('use:') && content.includes('video:')) {
          // Update existing video setting
          const videoRegex = /video:\s*['"`](on|off|retain-on-failure|on-first-retry)['"`]/;
          if (videoRegex.test(content)) {
            content = content.replace(videoRegex, `video: '${videoValue}'`);
          } else {
            // Add video to existing use block
            content = content.replace(
              /(use:\s*\{[^}]*?)(\})/,
              `$1    video: '${videoValue}',\n  $2`
            );
          }
        } else if (content.includes('use:')) {
          // Add video to existing use block
          content = content.replace(
            /(use:\s*\{[^}]*?)(\})/,
            `$1    video: '${videoValue}',\n  $2`
          );
        } else {
          // Add use block with video
          if (content.includes('export default')) {
            content = content.replace(
              /(export default[^;]*?)(\})/,
              `$1  use: {\n    video: '${videoValue}',\n  },\n$2`
            );
          }
        }

        fs.writeFileSync(configFile, content, 'utf-8');
        this.log(`Updated ${configFile} with video setting: ${videoValue}`);
      } catch (error: any) {
        this.log(`Warning: Could not update ${configFile}: ${error.message}`);
      }
    } else {
      // Create a basic playwright.config.ts file
      const defaultConfig = `import { defineConfig, devices } from '@playwright/test';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like \`await page.goto('/')\`. */
    // baseURL: 'http://127.0.0.1:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    video: '${videoValue}',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://127.0.0.1:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
`;

      try {
        fs.writeFileSync(configPath, defaultConfig, 'utf-8');
        this.log(`Created ${configPath} with video setting: ${videoValue}`);
      } catch (error: any) {
        this.log(`Warning: Could not create ${configPath}: ${error.message}`);
      }
    }
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

      // Get version ID and repo info for Supabase updates
      this.log(`[ParseResults] Getting version ID for Supabase...`);
      const versionId = await this.getVersionId(workspacePath);
      this.log(`[ParseResults] Version ID: ${versionId || 'NOT FOUND'}`);

      // Get repo info for video uploads
      const gitInfo = await getGitHubInfoFromGit(workspacePath);
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const repoOwner = gitInfo?.owner || 'local';
      const repoName = gitInfo?.repo || workspaceFolder?.name || 'unknown';
      this.log(`[ParseResults] Repo: ${repoOwner}/${repoName}`);

      if (!versionId) {
        this.log(`[ParseResults] WARNING: No version ID found, skipping Supabase updates`);
      }

      // Update each test
      for (const result of testResults) {
        const status = this.mapPlaywrightStatus(result.status);
        
        // Update tree view
        this.treeProvider.updateTestStatus(result.filePath, result.title, status);

        // Update Supabase if we have version ID (includes video upload)
        if (versionId) {
          await this.updateTestInSupabase(versionId, result, workspacePath, repoOwner, repoName);
        }
      }

      // Refresh the tree view
      this.treeProvider.refresh();

      // Show summary notification
      const passed = testResults.filter(t => t.status === 'passed').length;
      const failed = testResults.filter(t => t.status === 'failed').length;
      const skipped = testResults.filter(t => t.status === 'skipped').length;
      const videosAvailable = testResults.filter(t => t.videoPath).length;

      if (failed > 0) {
        const actions = ['Insert Results into Chat'];
        if (videosAvailable > 0) {
          actions.push('View Videos');
        }
        const action = await vscode.window.showWarningMessage(
          `Tests completed: ${passed} passed, ${failed} failed, ${skipped} skipped${videosAvailable > 0 ? ` (${videosAvailable} video${videosAvailable > 1 ? 's' : ''} available)` : ''}`,
          ...actions
        );
        if (action === 'Insert Results into Chat') {
          await this.insertResultsIntoChat(resultsFile);
        } else if (action === 'View Videos') {
          await this.showTestVideos(testResults, workspacePath);
        }
      } else if (passed > 0 || skipped > 0) {
        const actions = ['Insert Results into Chat'];
        if (videosAvailable > 0) {
          actions.push('View Videos');
        }
        const action = await vscode.window.showInformationMessage(
          `Tests completed: ${passed} passed, ${skipped} skipped${videosAvailable > 0 ? ` (${videosAvailable} video${videosAvailable > 1 ? 's' : ''} available)` : ''}`,
          ...actions
        );
        if (action === 'Insert Results into Chat') {
          await this.insertResultsIntoChat(resultsFile);
        } else if (action === 'View Videos') {
          await this.showTestVideos(testResults, workspacePath);
        }
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
    // Get the configured test directory
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const testDir = config.get<string>('testOutputDir') || 'e2e';
    
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
          
          // If the file path is just a filename (no directory), prepend the test directory
          // This handles cases where Playwright returns just "page.spec.ts" instead of "e2e/page.spec.ts"
          if (!filePath.includes('/') && !filePath.includes('\\')) {
            filePath = `${testDir}/${filePath}`;
          }
          // Also handle case where path doesn't start with test directory but should
          else if (!filePath.startsWith(testDir + '/') && !filePath.startsWith(testDir + '\\')) {
            // Check if it's a .spec.ts file that should be in the test directory
            if (filePath.includes('.spec.ts') || filePath.includes('.spec.js')) {
              // Check if file exists in test directory
              const fullPathWithTestDir = path.join(workspacePath, testDir, filePath);
              const fullPathWithoutTestDir = path.join(workspacePath, filePath);
              
              if (fs.existsSync(fullPathWithTestDir) && !fs.existsSync(fullPathWithoutTestDir)) {
                filePath = `${testDir}/${filePath}`;
              }
            }
          }
        }
        
        this.log(`[ExtractResults] File: ${spec.file} -> normalized: ${filePath}`);
        
        for (const test of spec.tests || []) {
          // In Playwright JSON, each test has a results array (one entry per retry)
          // We take the last result (final outcome after retries)
          const lastResult = test.results?.[test.results.length - 1];
          const status = lastResult?.status || 'pending';
          const duration = lastResult?.duration || 0;
          
          // Collect errors from the result and strip ANSI codes
          const errors: Array<{ message: string }> = [];
          if (lastResult?.error) {
            const errorMsg = lastResult.error.message || lastResult.error.stack || 'Unknown error';
            errors.push({ message: this.stripAnsiCodes(errorMsg) });
          }
          if (lastResult?.errors) {
            errors.push(...lastResult.errors.map(e => ({ message: this.stripAnsiCodes(e.message) })));
          }
          
          // Extract video path - first try from JSON report, then search test-results directory
          let videoPath: string | undefined;
          if (lastResult?.video) {
            // Playwright video path can be in different formats
            const video = lastResult.video;
            if (typeof video === 'string') {
              videoPath = video;
            } else if (video && typeof video === 'object' && 'path' in video) {
              videoPath = (video as any).path;
            }
            
            // Make path relative to workspace if it's absolute
            if (videoPath && path.isAbsolute(videoPath)) {
              videoPath = path.relative(workspacePath, videoPath);
            }
          }
          
          // If no video in JSON report, search for it in test-results directory
          if (!videoPath) {
            videoPath = this.findVideoForTest(workspacePath, test.title || spec.title, filePath);
          }
          
          this.log(`[ExtractResults] Test: "${test.title}" status: ${status}, duration: ${duration}ms, video: ${videoPath || 'none'}`);
          
          results.push({
            title: test.title || spec.title,
            status,
            duration,
            errors: errors.length > 0 ? errors : undefined,
            filePath,
            videoPath
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
   * Strip ANSI escape codes from a string
   */
  private stripAnsiCodes(str: string): string {
    return str.replace(/\u001b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Find video file for a test in the test-results directory
   * Videos are stored as: test-results/{file}-{describe}-{test}-{browser}/video.webm
   * e.g., test-results/products-Products-Page-should-clear-filters-chromium/video.webm
   */
  private findVideoForTest(workspacePath: string, testTitle: string, filePath: string): string | undefined {
    const resultsDir = path.join(workspacePath, 'test-results');
    
    if (!fs.existsSync(resultsDir)) {
      this.log(`[FindVideo] Results directory not found: ${resultsDir}`);
      return undefined;
    }

    // List all directories in test-results
    const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
    const testDirs = entries.filter(e => e.isDirectory());
    
    this.log(`[FindVideo] Looking for video for test: "${testTitle}" in ${filePath}`);
    this.log(`[FindVideo] Found ${testDirs.length} test result directories`);

    // Build patterns to match against directory names
    // Playwright creates directories like: products-Products-Page-should-clear-filters-chromium
    const fileBaseName = path.basename(filePath, path.extname(filePath))
      .replace('.spec', '')
      .replace(/\./g, '-')
      .toLowerCase();
    
    // Normalize test title to match directory naming: "should clear filters" -> "should-clear-filters"
    const testTitleNormalized = testTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    this.log(`[FindVideo] Searching for fileBase="${fileBaseName}" and testTitle="${testTitleNormalized}"`);

    // Score each directory to find the best match
    let bestMatch: { dir: string; score: number } | null = null;

    for (const dir of testDirs) {
      const dirNameLower = dir.name.toLowerCase();
      let score = 0;
      
      // Check if directory starts with the file base name
      if (dirNameLower.startsWith(fileBaseName + '-')) {
        score += 10;
      } else if (dirNameLower.includes(fileBaseName)) {
        score += 5;
      }
      
      // Check for test title words in the directory name
      const testWords = testTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const matchingWords = testWords.filter(word => dirNameLower.includes(word));
      score += matchingWords.length * 2;
      
      // Bonus for matching the full normalized test title
      if (dirNameLower.includes(testTitleNormalized)) {
        score += 20;
      }
      
      // Only consider directories with video.webm
      if (score > 0) {
        const videoPath = path.join(resultsDir, dir.name, 'video.webm');
        if (fs.existsSync(videoPath)) {
          this.log(`[FindVideo] Candidate: ${dir.name} (score: ${score})`);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { dir: dir.name, score };
          }
        }
      }
    }

    if (bestMatch) {
      const videoPath = path.join(resultsDir, bestMatch.dir, 'video.webm');
      const relativePath = path.relative(workspacePath, videoPath);
      this.log(`[FindVideo] Best match: ${bestMatch.dir} (score: ${bestMatch.score})`);
      this.log(`[FindVideo] Video path: ${relativePath}`);
      return relativePath;
    }

    this.log(`[FindVideo] No video found for test: "${testTitle}"`);
    return undefined;
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
    result: ParsedTestResult,
    workspacePath: string,
    repoOwner: string,
    repoName: string
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

        // Strip ANSI codes from error message for cleaner logs
        const cleanErrorMessage = errorMessage ? this.stripAnsiCodes(errorMessage) : null;

        const statusUpdate: TestStatusUpdate = {
          last_status: status,
          last_run_at: new Date().toISOString(),
          last_duration_ms: result.duration,
          last_error: cleanErrorMessage,
          last_ran_video: null
        };

        // Upload video if available
        this.log(`[UpdateSupabase] Video path from results: ${result.videoPath || 'none'}`);
        
        if (result.videoPath) {
          const absoluteVideoPath = path.isAbsolute(result.videoPath) 
            ? result.videoPath 
            : path.join(workspacePath, result.videoPath);
          
          this.log(`[UpdateSupabase] Checking video file exists: ${absoluteVideoPath}`);
          
          if (fs.existsSync(absoluteVideoPath)) {
            const stats = fs.statSync(absoluteVideoPath);
            this.log(`[UpdateSupabase] Video file found, size: ${(stats.size / 1024).toFixed(2)} KB`);
            this.log(`[UpdateSupabase] Uploading video to Supabase Storage...`);
            
            const videoUrl = await this.supabaseService.uploadTestVideo(
              absoluteVideoPath,
              repoOwner,
              repoName,
              stableId
            );
            
            if (videoUrl) {
              statusUpdate.last_ran_video = videoUrl;
              this.log(`[UpdateSupabase] Video uploaded successfully!`);
              this.log(`[UpdateSupabase] Video URL: ${videoUrl}`);
              
              // Cleanup old videos in Supabase (keep only the most recent one)
              await this.supabaseService.cleanupOldTestVideos(repoOwner, repoName, stableId, 1);
              
              // Delete local video file to save storage
              try {
                fs.unlinkSync(absoluteVideoPath);
                this.log(`[UpdateSupabase] Deleted local video file: ${absoluteVideoPath}`);
              } catch (deleteErr: any) {
                this.log(`[UpdateSupabase] Warning: Could not delete local video: ${deleteErr.message}`);
              }
            } else {
              this.log(`[UpdateSupabase] Video upload failed - check Supabase Storage logs`);
            }
          } else {
            this.log(`[UpdateSupabase] Video file NOT found at: ${absoluteVideoPath}`);
          }
        } else {
          this.log(`[UpdateSupabase] No video available for this test`);
        }

        // Log the update (truncate error for readability)
        const logUpdate = {
          ...statusUpdate,
          last_error: cleanErrorMessage ? `${cleanErrorMessage.substring(0, 100)}...` : null
        };
        this.log(`[UpdateSupabase] Updating test node with: ${JSON.stringify(logUpdate)}`);
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
   * Insert test results into VS Code Chat window
   */
  private async insertResultsIntoChat(resultsFile: string): Promise<void> {
    try {
      if (!fs.existsSync(resultsFile)) {
        vscode.window.showErrorMessage(`Results file not found: ${resultsFile}`);
        return;
      }

      // Read the results.json file
      const resultsContent = fs.readFileSync(resultsFile, 'utf-8');
      let resultsData: any;
      
      try {
        resultsData = JSON.parse(resultsContent);
      } catch (parseError) {
        vscode.window.showErrorMessage(`Failed to parse results.json: ${parseError}`);
        return;
      }

      // Format the results for chat
      const formattedMessage = this.formatResultsForChat(resultsData);

      // Copy to clipboard
      await vscode.env.clipboard.writeText(formattedMessage);

      // Try to use chat API if available (VS Code 1.85+)
      try {
        // Check if chat namespace exists and has the method
        const vscodeAny = vscode as any;
        if (vscodeAny.chat && typeof vscodeAny.chat.requestChatAccess === 'function') {
          const chatAccess = await vscodeAny.chat.requestChatAccess('copilot');
          if (chatAccess && typeof chatAccess.addRequest === 'function') {
            await chatAccess.addRequest(
              formattedMessage,
              {
                command: 'inline',
                references: []
              }
            );
            vscode.window.showInformationMessage('Test results inserted into Chat');
            return;
          }
        }
      } catch (chatError: any) {
        this.log(`Chat API not available or failed: ${chatError.message}`);
      }

      // Fallback: Open chat and show message
      await vscode.commands.executeCommand('workbench.action.chat.open');
      
      // Small delay to ensure chat is open
      await new Promise(resolve => setTimeout(resolve, 500));
      
      vscode.window.showInformationMessage(
        'Test results copied to clipboard. The Chat window is open - paste (Cmd+V / Ctrl+V) to insert the results.'
      );
    } catch (error: any) {
      this.log(`Error inserting results into chat: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to insert results into chat: ${error.message}`);
    }
  }

  /**
   * Format test results for chat message
   */
  private formatResultsForChat(resultsData: any): string {
    const message = `Here are my Playwright test results. Please analyze the failures and help me fix them:

\`\`\`json
${JSON.stringify(resultsData, null, 2)}
\`\`\`

Please:
1. Identify which tests failed and why
2. Suggest fixes for the failing tests
3. Explain any patterns or common issues you notice`;

    return message;
  }

  /**
   * Show test videos in a quick pick menu
   */
  private async showTestVideos(testResults: ParsedTestResult[], workspacePath: string): Promise<void> {
    const videos = testResults.filter(t => t.videoPath);
    
    if (videos.length === 0) {
      vscode.window.showInformationMessage('No test videos available');
      return;
    }

    // Create quick pick items
    const items: vscode.QuickPickItem[] = videos.map(result => ({
      label: `$(play) ${result.title}`,
      description: `${result.filePath} - ${result.status}`,
      detail: result.videoPath,
      alwaysShow: true
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select a test video to open (${videos.length} available)`,
      canPickMany: false
    });

    if (selected && selected.detail) {
      const videoPath = path.isAbsolute(selected.detail) 
        ? selected.detail 
        : path.join(workspacePath, selected.detail);
      
      if (fs.existsSync(videoPath)) {
        // Open video file in default application
        const uri = vscode.Uri.file(videoPath);
        await vscode.commands.executeCommand('vscode.open', uri);
        this.log(`Opened video: ${videoPath}`);
      } else {
        vscode.window.showErrorMessage(`Video file not found: ${videoPath}`);
        this.log(`Video file not found: ${videoPath}`);
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
