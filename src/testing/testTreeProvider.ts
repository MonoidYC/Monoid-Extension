import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TestItem, TestFile, TestStatus } from './types';

/**
 * Tree item representing either a test file or an individual test
 */
export class TestTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: 'file' | 'test',
    public readonly testData?: {
      filePath: string;
      testName?: string;
      line?: number;
      status?: TestStatus;
      supabaseId?: string;
    }
  ) {
    super(label, collapsibleState);

    if (itemType === 'file') {
      this.contextValue = 'testFile';
      this.iconPath = new vscode.ThemeIcon('file-code');
      this.tooltip = testData?.filePath;
    } else {
      this.contextValue = 'test';
      this.iconPath = this.getStatusIcon(testData?.status || 'pending');
      this.tooltip = `${testData?.testName || label}\nStatus: ${testData?.status || 'pending'}`;
      
      // Allow clicking to navigate to test
      if (testData?.filePath && testData?.line) {
        this.command = {
          command: 'monoid-visualize.openTestFile',
          title: 'Open Test',
          arguments: [testData.filePath, testData.line]
        };
      }
    }
  }

  private getStatusIcon(status: TestStatus): vscode.ThemeIcon {
    switch (status) {
      case 'passed':
        return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
      case 'failed':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
      case 'running':
        return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconQueued'));
      case 'skipped':
        return new vscode.ThemeIcon('debug-step-over', new vscode.ThemeColor('testing.iconSkipped'));
      case 'pending':
      default:
        return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconUnset'));
    }
  }
}

/**
 * Tree data provider for the Playwright Tests sidebar
 */
export class TestTreeProvider implements vscode.TreeDataProvider<TestTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TestTreeItem | undefined | null | void> = new vscode.EventEmitter<TestTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TestTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private testFiles: TestFile[] = [];
  private testDir: string = 'e2e';
  private workspaceFolder: vscode.WorkspaceFolder | undefined;

  constructor() {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    this.loadTests();
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this.loadTests();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Update status for a specific test
   */
  updateTestStatus(filePath: string, testName: string, status: TestStatus): void {
    const file = this.testFiles.find(f => f.filePath === filePath);
    if (file) {
      const test = file.tests.find(t => t.name === testName);
      if (test) {
        test.status = status;
        this._onDidChangeTreeData.fire();
      }
    }
  }

  /**
   * Set all tests in a file to a specific status
   */
  setFileTestsStatus(filePath: string, status: TestStatus): void {
    const file = this.testFiles.find(f => f.filePath === filePath);
    if (file) {
      file.tests.forEach(test => {
        test.status = status;
      });
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: TestTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children of a tree item
   */
  getChildren(element?: TestTreeItem): Thenable<TestTreeItem[]> {
    if (!this.workspaceFolder) {
      return Promise.resolve([]);
    }

    if (!element) {
      // Root level - return test files
      return Promise.resolve(this.getTestFileItems());
    }

    // File level - return individual tests
    if (element.itemType === 'file' && element.testData?.filePath) {
      return Promise.resolve(this.getTestItems(element.testData.filePath));
    }

    return Promise.resolve([]);
  }

  /**
   * Get test file items for root level
   */
  private getTestFileItems(): TestTreeItem[] {
    return this.testFiles.map(file => {
      return new TestTreeItem(
        file.fileName,
        vscode.TreeItemCollapsibleState.Expanded,
        'file',
        { filePath: file.filePath }
      );
    });
  }

  /**
   * Get individual test items for a file
   */
  private getTestItems(filePath: string): TestTreeItem[] {
    const file = this.testFiles.find(f => f.filePath === filePath);
    if (!file) {
      return [];
    }

    return file.tests.map(test => {
      return new TestTreeItem(
        test.name,
        vscode.TreeItemCollapsibleState.None,
        'test',
        {
          filePath: test.filePath,
          testName: test.name,
          line: test.line,
          status: test.status,
          supabaseId: test.supabaseId
        }
      );
    });
  }

  /**
   * Load tests from the e2e directory
   */
  private loadTests(): void {
    this.testFiles = [];

    if (!this.workspaceFolder) {
      return;
    }

    // Get test directory from config
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    this.testDir = config.get<string>('testOutputDir') || 'e2e';

    const testDirPath = path.join(this.workspaceFolder.uri.fsPath, this.testDir);

    if (!fs.existsSync(testDirPath)) {
      return;
    }

    // Find all .spec.ts files
    const files = fs.readdirSync(testDirPath).filter(f => f.endsWith('.spec.ts'));

    for (const fileName of files) {
      const filePath = path.join(testDirPath, fileName);
      const relativePath = path.join(this.testDir, fileName);
      const tests = this.parseTestFile(filePath, relativePath);

      this.testFiles.push({
        filePath: relativePath,
        fileName,
        tests,
        lastModified: fs.statSync(filePath).mtime
      });
    }
  }

  /**
   * Parse a test file to extract individual test names
   */
  private parseTestFile(absolutePath: string, relativePath: string): TestItem[] {
    const tests: TestItem[] = [];

    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const lines = content.split('\n');

      // Match test() or it() calls
      const testPattern = /^\s*(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(testPattern);
        if (match) {
          const testName = match[1];
          tests.push({
            id: `${relativePath}::${testName}`,
            name: testName,
            filePath: relativePath,
            line: i + 1,
            status: 'pending'
          });
        }
      }
    } catch (error) {
      console.error(`Error parsing test file ${absolutePath}:`, error);
    }

    return tests;
  }

  /**
   * Get all test files
   */
  getTestFiles(): TestFile[] {
    return this.testFiles;
  }

  /**
   * Get tests for a specific file
   */
  getTestsForFile(filePath: string): TestItem[] {
    const file = this.testFiles.find(f => f.filePath === filePath);
    return file?.tests || [];
  }

  /**
   * Add a new test file after generation
   */
  addTestFile(filePath: string): void {
    if (!this.workspaceFolder) {
      return;
    }

    const absolutePath = path.join(this.workspaceFolder.uri.fsPath, filePath);
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    const fileName = path.basename(filePath);
    const tests = this.parseTestFile(absolutePath, filePath);

    // Check if file already exists and update it
    const existingIndex = this.testFiles.findIndex(f => f.filePath === filePath);
    if (existingIndex >= 0) {
      this.testFiles[existingIndex] = {
        filePath,
        fileName,
        tests,
        lastModified: fs.statSync(absolutePath).mtime
      };
    } else {
      this.testFiles.push({
        filePath,
        fileName,
        tests,
        lastModified: fs.statSync(absolutePath).mtime
      });
    }

    this._onDidChangeTreeData.fire();
  }
}
