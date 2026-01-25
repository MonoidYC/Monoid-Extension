import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import { LocalTestNode, LocalTestCoverageEdge, GeneratedTest, TestGenerationContext } from './types';
import { SupabaseService } from '../supabase/client';
import { getGitHubInfoFromGit } from '../utils/gitUtils';

/**
 * AI-powered Playwright test generator using VS Code Language Model API
 */
export class TestGenerator {
  private outputChannel: vscode.OutputChannel;
  private supabaseService: SupabaseService;

  constructor(supabaseService: SupabaseService) {
    this.outputChannel = vscode.window.createOutputChannel('Monoid Test Generator');
    this.supabaseService = supabaseService;
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  /**
   * Generate an E2E test for a given file
   */
  async generateTestForFile(fileUri: vscode.Uri): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return null;
    }

    this.outputChannel.show(true);
    this.log('='.repeat(60));
    this.log('Generating E2E Test');
    this.log('='.repeat(60));

    const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath);
    this.log(`Source file: ${relativePath}`);

    const result = await this.generateTestForFileInternal(fileUri, true);
    
    if (result) {
      this.log(`Test file written: ${result}`);
      this.log('');
      this.log('Test generation complete!');
      this.log('='.repeat(60));
    }

    return result;
  }

  /**
   * Extract context from source file for test generation
   */
  private extractContext(pageSource: string, pagePath: string, baseUrl: string): TestGenerationContext {
    // Extract data-testid attributes
    const dataTestIds: string[] = [];
    const testIdPattern = /data-testid=["']([^"']+)["']/g;
    let match;
    while ((match = testIdPattern.exec(pageSource)) !== null) {
      dataTestIds.push(match[1]);
    }

    // Extract component names used
    const components: string[] = [];
    const componentPattern = /<([A-Z][a-zA-Z0-9]*)/g;
    while ((match = componentPattern.exec(pageSource)) !== null) {
      if (!components.includes(match[1])) {
        components.push(match[1]);
      }
    }

    // Extract API endpoints called
    const endpoints: string[] = [];
    const fetchPattern = /fetch\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = fetchPattern.exec(pageSource)) !== null) {
      if (match[1].startsWith('/api')) {
        endpoints.push(match[1]);
      }
    }

    return {
      pageSource,
      pagePath,
      baseUrl,
      dataTestIds,
      components,
      endpoints
    };
  }

  /**
   * Generate test using configured LLM provider
   */
  private async generateWithLLM(context: TestGenerationContext): Promise<GeneratedTest | null> {
    this.log('');
    this.log('Generating test with AI...');

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const provider = config.get<string>('llmProvider') || 'gemini';

    this.log(`Using LLM provider: ${provider}`);

    if (provider === 'gemini') {
      return this.generateWithGemini(context);
    } else {
      return this.generateWithCopilot(context);
    }
  }

  /**
   * Generate test using Google Gemini API
   */
  private async generateWithGemini(context: TestGenerationContext): Promise<GeneratedTest | null> {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const apiKey = config.get<string>('geminiApiKey');
    const model = config.get<string>('geminiModel') || 'gemini-2.0-flash';

    if (!apiKey) {
      this.log('ERROR: Gemini API key not configured. Set monoid-visualize.geminiApiKey in settings.');
      throw new Error('Gemini API key not configured. Go to Settings and set monoid-visualize.geminiApiKey');
    }

    try {
      this.log(`Using Gemini model: ${model}`);

      // Determine the route from file path
      const route = this.inferRouteFromPath(context.pagePath);

      // Build the prompt
      const prompt = this.buildPrompt(context, route);
      this.log(`Generated prompt for route: ${route}`);

      this.log('Sending request to Gemini...');

      const responseText = await this.callGeminiAPI(apiKey, model, prompt);

      if (!responseText || responseText.trim().length === 0) {
        this.log('ERROR: Empty response from Gemini');
        return null;
      }

      this.log(`Received response (${responseText.length} chars)`);

      // Parse the response
      const result = this.parseGeneratedTest(responseText, context);
      if (!result) {
        this.log('ERROR: Failed to parse Gemini response');
      }
      return result;
    } catch (error: any) {
      this.log(`ERROR in generateWithGemini: ${error.message}`);
      if (error.stack) {
        this.log(`Stack: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Call Google Gemini API
   */
  private callGeminiAPI(apiKey: string, model: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const requestBody = JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
        }
      });

      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (response.error) {
              reject(new Error(`Gemini API error: ${response.error.message}`));
              return;
            }

            if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
              resolve(response.candidates[0].content.parts[0].text);
            } else {
              this.log(`Unexpected Gemini response structure: ${JSON.stringify(response).substring(0, 500)}`);
              reject(new Error('Unexpected response structure from Gemini'));
            }
          } catch (e: any) {
            reject(new Error(`Failed to parse Gemini response: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Gemini request failed: ${e.message}`));
      });

      req.write(requestBody);
      req.end();
    });
  }

  /**
   * Generate test using VS Code Language Model API (Copilot)
   */
  private async generateWithCopilot(context: TestGenerationContext): Promise<GeneratedTest | null> {
    try {
      // Get available models
      let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
      }
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      }
      if (models.length === 0) {
        this.log('ERROR: No language models available. Make sure GitHub Copilot is installed and signed in.');
        throw new Error('No language models available. Make sure GitHub Copilot is installed and signed in.');
      }

      const model = models[0];
      this.log(`Using model: ${model.id}`);

      // Determine the route from file path
      const route = this.inferRouteFromPath(context.pagePath);

      // Build the prompt
      const prompt = this.buildPrompt(context, route);
      this.log(`Generated prompt for route: ${route}`);

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      
      this.log('Sending request to Copilot...');
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      // Collect response
      let responseText = '';
      for await (const chunk of response.text) {
        responseText += chunk;
      }

      if (!responseText || responseText.trim().length === 0) {
        this.log('ERROR: Empty response from Copilot');
        return null;
      }

      this.log(`Received response (${responseText.length} chars)`);

      // Parse the response
      const result = this.parseGeneratedTest(responseText, context);
      if (!result) {
        this.log('ERROR: Failed to parse Copilot response');
      }
      return result;
    } catch (error: any) {
      this.log(`ERROR in generateWithCopilot: ${error.message}`);
      if (error.stack) {
        this.log(`Stack: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Build the prompt for test generation
   */
  private buildPrompt(context: TestGenerationContext, route: string): string {
    const testIdList = context.dataTestIds && context.dataTestIds.length > 0
      ? `\nAvailable data-testid selectors:\n${context.dataTestIds.map(id => `- ${id}`).join('\n')}`
      : '\nNo data-testid attributes found. Use semantic selectors like getByRole, getByText, etc.';

    const endpointList = context.endpoints && context.endpoints.length > 0
      ? `\nAPI endpoints called by this page:\n${context.endpoints.map(ep => `- ${ep}`).join('\n')}`
      : '';

    return `Generate a comprehensive Playwright E2E test for this React page.

Page: ${context.pagePath}
Route: ${route}
Base URL: ${context.baseUrl}
${testIdList}
${endpointList}

Source code:
\`\`\`javascript
${context.pageSource.substring(0, 8000)}
\`\`\`

Requirements:
1. Use Playwright's @playwright/test package
2. Use data-testid selectors where available (preferred): page.getByTestId('...')
3. For elements without data-testid, use semantic selectors: getByRole, getByText, getByLabel
4. Test key user interactions visible on the page
5. Include proper assertions (expect statements)
6. Handle async operations with proper waits
7. Add meaningful test descriptions
8. Include a test.describe block with the page name
9. Start with a test that verifies the page loads correctly

Generate ONLY the TypeScript test code, no explanations. The code should be ready to run with Playwright.
Format: Start with imports, then test.describe block containing multiple test() blocks.`;
  }

  /**
   * Parse the LLM response into a GeneratedTest object
   */
  private parseGeneratedTest(response: string, context: TestGenerationContext): GeneratedTest | null {
    // Extract code from markdown code block if present
    let code = response;
    const codeBlockMatch = response.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      code = codeBlockMatch[1];
    }

    // Clean up the code
    code = code.trim();

    // Ensure it has the necessary imports
    if (!code.includes('@playwright/test')) {
      code = `import { test, expect } from '@playwright/test';\n\n${code}`;
    }

    // Extract test names for description
    const testNames: string[] = [];
    const testPattern = /test\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    while ((match = testPattern.exec(code)) !== null) {
      testNames.push(match[1]);
    }

    const description = testNames.length > 0
      ? `Tests: ${testNames.slice(0, 3).join(', ')}${testNames.length > 3 ? '...' : ''}`
      : 'E2E test for ' + path.basename(context.pagePath);

    return {
      name: path.basename(context.pagePath, path.extname(context.pagePath)),
      description,
      code,
      coveredComponents: context.components || [],
      coveredEndpoints: context.endpoints || []
    };
  }

  /**
   * Infer the route from file path
   */
  private inferRouteFromPath(filePath: string): string {
    // Handle Next.js app router patterns
    // app/page.js -> /
    // app/about/page.js -> /about
    // app/dashboard/page.js -> /dashboard
    
    let route = filePath
      .replace(/^app\//, '/')
      .replace(/\/page\.(js|jsx|ts|tsx)$/, '')
      .replace(/^src\/app\//, '/')
      .replace(/^pages\//, '/')
      .replace(/\/index\.(js|jsx|ts|tsx)$/, '');

    if (route === '' || route === '/app') {
      route = '/';
    }

    return route;
  }

  /**
   * Generate test file name from source file path
   */
  private generateTestFileName(sourcePath: string): string {
    // Extract meaningful name from path
    // app/dashboard/page.js -> dashboard.spec.ts
    // app/page.js -> homepage.spec.ts
    // pages/about.js -> about.spec.ts

    let name = sourcePath
      .replace(/^app\//, '')
      .replace(/^src\/app\//, '')
      .replace(/^pages\//, '')
      .replace(/\/page\.(js|jsx|ts|tsx)$/, '')
      .replace(/\.(js|jsx|ts|tsx)$/, '')
      .replace(/\/index$/, '')
      .replace(/\//g, '-');

    if (!name || name === '-') {
      name = 'homepage';
    }

    return `${name}.spec.ts`;
  }

  /**
   * Generate a unique commit SHA for versioning
   */
  private generateCommitSha(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString();
    return crypto.createHash('sha1').update(timestamp + random).digest('hex').substring(0, 40);
  }

  /**
   * Save generated test to Supabase
   */
  private async saveToSupabase(
    workspaceName: string,
    testFilePath: string,
    generatedTest: GeneratedTest,
    context: TestGenerationContext
  ): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this.log('No workspace folder, skipping Supabase save');
        return;
      }

      // Auto-detect GitHub info from git remote (same as visualizer pipeline)
      const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
      const detectedOwner = gitInfo?.owner;
      const detectedRepo = gitInfo?.repo;
      const detectedBranch = gitInfo?.branch || 'main';

      // Get or create workspace
      const workspace = await this.supabaseService.getOrCreateWorkspace(workspaceName);

      // Create or get organization if GitHub owner is detected
      let organizationId: string | undefined;
      if (detectedOwner) {
        const organization = await this.supabaseService.getOrCreateOrganization(detectedOwner);
        organizationId = organization.id;
        this.log(`Using organization: ${detectedOwner} (${organizationId})`);
      }

      // Create or get repo with proper owner and organization (same as visualizer)
      const repoOwner = detectedOwner || 'local';
      const repoName = detectedRepo || workspaceName;
      const repo = await this.supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);
      
      this.log(`Using repo: ${repoOwner}/${repoName} (${repo.id})`);

      // Get existing version or create a new one for tests
      let version = await this.supabaseService.getLatestVersion(repo.id);

      if (!version) {
        // Create a new version specifically for tests
        this.log('No existing version found, creating new version for tests...');
        const commitSha = this.generateCommitSha();
        version = await this.supabaseService.createVersion(repo.id, commitSha, detectedBranch);
        this.log(`Created new version: ${version.id}`);
      }

      // Parse test names from the generated code
      const testPattern = /test\s*\(\s*['"`]([^'"`]+)['"`]/g;
      const tests: LocalTestNode[] = [];
      let match;
      let lineNum = 1;

      const lines = generatedTest.code.split('\n');
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
              route: this.inferRouteFromPath(context.pagePath),
              generatedFrom: context.pagePath
            }
          });
        }
      }

      if (tests.length > 0) {
        const testIdMap = await this.supabaseService.saveTestNodes(version.id, tests);
        this.log(`Saved ${tests.length} test(s) to Supabase`);

        // Create coverage edges if we have code nodes
        const codeIdMap = await this.supabaseService.getCodeNodeIdMap(version.id);
        if (codeIdMap.size > 0) {
          const coverageEdges: LocalTestCoverageEdge[] = [];

          // Link tests to covered components
          for (const test of tests) {
            for (const component of generatedTest.coveredComponents) {
              // Find matching code node
              for (const [stableId, _] of codeIdMap) {
                if (stableId.includes(`::${component}`)) {
                  coverageEdges.push({
                    test_stable_id: test.stable_id,
                    code_stable_id: stableId,
                    coverage_type: 'covers'
                  });
                  break;
                }
              }
            }

            // Link tests to covered endpoints
            for (const endpoint of generatedTest.coveredEndpoints) {
              for (const [stableId, _] of codeIdMap) {
                if (stableId.includes(endpoint)) {
                  coverageEdges.push({
                    test_stable_id: test.stable_id,
                    code_stable_id: stableId,
                    coverage_type: 'tests_endpoint'
                  });
                  break;
                }
              }
            }
          }

          if (coverageEdges.length > 0) {
            await this.supabaseService.saveTestCoverageEdges(version.id, coverageEdges, testIdMap, codeIdMap);
            this.log(`Saved ${coverageEdges.length} coverage edge(s)`);
          }
        }
      }
    } catch (error: any) {
      this.log(`Supabase error: ${error.message}`);
    }
  }

  /**
   * Generate tests for the entire app by finding all page files
   */
  async generateTestsForEntireApp(): Promise<string[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return [];
    }

    this.outputChannel.show(true);
    this.log('='.repeat(60));
    this.log('Generating E2E Tests for Entire App');
    this.log('='.repeat(60));

    // Find all page files (Next.js app router and pages router patterns)
    const pagePatterns = [
      '**/app/**/page.js',
      '**/app/**/page.jsx',
      '**/app/**/page.ts',
      '**/app/**/page.tsx',
      '**/pages/**/*.js',
      '**/pages/**/*.jsx',
      '**/pages/**/*.ts',
      '**/pages/**/*.tsx'
    ];

    // Simple exclude pattern - just the main directories
    const excludePattern = '{**/node_modules/**,**/.next/**,**/dist/**,**/build/**}';

    const pageFiles: vscode.Uri[] = [];

    for (const pattern of pagePatterns) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, pattern),
        excludePattern
      );
      pageFiles.push(...files);
    }

    // Filter out API routes and special Next.js files
    const filteredFiles = pageFiles.filter(file => {
      const filePath = file.fsPath;
      const fileName = path.basename(filePath);
      
      // Exclude API routes
      if (filePath.includes('/api/') || filePath.includes('\\api\\')) {
        return false;
      }
      
      // Exclude special Next.js files
      const excludedFiles = ['_app', '_document', '_error', 'layout', 'loading', 'error', 'not-found'];
      const baseName = fileName.replace(/\.(js|jsx|ts|tsx)$/, '');
      if (excludedFiles.includes(baseName)) {
        return false;
      }
      
      return true;
    });

    // Remove duplicates
    const uniqueFiles = [...new Map(filteredFiles.map(f => [f.fsPath, f])).values()];

    if (uniqueFiles.length === 0) {
      vscode.window.showWarningMessage('No page files found in the workspace');
      return [];
    }

    this.log(`Found ${uniqueFiles.length} page file(s) to generate tests for:`);
    uniqueFiles.forEach(f => {
      const relativePath = path.relative(workspaceFolder.uri.fsPath, f.fsPath);
      this.log(`  - ${relativePath}`);
    });
    this.log('');

    const generatedTests: string[] = [];
    let successCount = 0;
    let failCount = 0;

    // Generate tests with progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating E2E Tests',
        cancellable: true
      },
      async (progress, token) => {
        for (let i = 0; i < uniqueFiles.length; i++) {
          if (token.isCancellationRequested) {
            this.log('Test generation cancelled by user');
            break;
          }

          const file = uniqueFiles[i];
          const relativePath = path.relative(workspaceFolder.uri.fsPath, file.fsPath);
          const progressPercent = ((i + 1) / uniqueFiles.length) * 100;

          progress.report({
            message: `(${i + 1}/${uniqueFiles.length}) ${relativePath}`,
            increment: (1 / uniqueFiles.length) * 100
          });

          this.log(`[${i + 1}/${uniqueFiles.length}] Generating test for: ${relativePath}`);

          try {
            const testPath = await this.generateTestForFileInternal(file, false); // Don't show individual notifications
            if (testPath) {
              generatedTests.push(testPath);
              successCount++;
              this.log(`  ✓ Generated: ${testPath}`);
            } else {
              failCount++;
              this.log(`  ✗ Failed to generate test`);
            }
          } catch (error: any) {
            failCount++;
            this.log(`  ✗ Error: ${error.message}`);
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    );

    this.log('');
    this.log('='.repeat(60));
    this.log(`Test Generation Complete!`);
    this.log(`  Success: ${successCount}`);
    this.log(`  Failed: ${failCount}`);
    this.log(`  Total: ${uniqueFiles.length}`);
    this.log('='.repeat(60));

    if (successCount > 0) {
      vscode.window.showInformationMessage(
        `Generated ${successCount} test file(s)${failCount > 0 ? ` (${failCount} failed)` : ''}`
      );
    } else {
      vscode.window.showErrorMessage('Failed to generate any tests');
    }

    return generatedTests;
  }

  /**
   * Internal method for generating test without showing notification
   */
  private async generateTestForFileInternal(fileUri: vscode.Uri, showNotification: boolean = true): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    try {
      // Read the source file
      const document = await vscode.workspace.openTextDocument(fileUri);
      const pageSource = document.getText();
      const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath);

      // Get config
      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const baseUrl = config.get<string>('testBaseUrl') || 'http://localhost:3000';
      const testOutputDir = config.get<string>('testOutputDir') || 'e2e';

      // Extract context from the source file
      const context = this.extractContext(pageSource, relativePath, baseUrl);

      // Generate test using LLM
      const generatedTest = await this.generateWithLLM(context);
      if (!generatedTest) {
        return null;
      }

      // Ensure test directory exists
      const testDirPath = path.join(workspaceFolder.uri.fsPath, testOutputDir);
      if (!fs.existsSync(testDirPath)) {
        fs.mkdirSync(testDirPath, { recursive: true });
      }

      // Generate test file name based on source file
      const testFileName = this.generateTestFileName(relativePath);
      const testFilePath = path.join(testOutputDir, testFileName);
      const absoluteTestPath = path.join(workspaceFolder.uri.fsPath, testFilePath);

      // Write the test file
      fs.writeFileSync(absoluteTestPath, generatedTest.code, 'utf-8');

      // Try to save to Supabase (non-blocking)
      this.saveToSupabase(workspaceFolder.name, testFilePath, generatedTest, context).catch(() => {});

      if (showNotification) {
        vscode.window.showInformationMessage(`Generated test: ${testFileName}`);
      }

      return testFilePath;
    } catch (error: any) {
      this.log(`ERROR generating test: ${error.message}`);
      if (error.stack) {
        this.log(`Stack: ${error.stack}`);
      }
      if (showNotification) {
        vscode.window.showErrorMessage(`Failed to generate test: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Regenerate a test for an existing test file
   */
  async regenerateTest(testFilePath: string): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    // Try to find the original source file
    // e2e/dashboard.spec.ts -> app/dashboard/page.js or similar

    const testName = path.basename(testFilePath, '.spec.ts');
    const possiblePaths = [
      `app/${testName}/page.js`,
      `app/${testName}/page.tsx`,
      `app/${testName}/page.jsx`,
      `src/app/${testName}/page.js`,
      `src/app/${testName}/page.tsx`,
      `pages/${testName}.js`,
      `pages/${testName}.tsx`
    ];

    if (testName === 'homepage') {
      possiblePaths.unshift('app/page.js', 'app/page.tsx', 'src/app/page.js', 'pages/index.js');
    }

    for (const possiblePath of possiblePaths) {
      const fullPath = path.join(workspaceFolder.uri.fsPath, possiblePath);
      if (fs.existsSync(fullPath)) {
        return this.generateTestForFile(vscode.Uri.file(fullPath));
      }
    }

    vscode.window.showErrorMessage(`Could not find source file for ${testFilePath}`);
    return null;
  }
}
