import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import { LocalTestNode, LocalTestCoverageEdge, GeneratedTest, TestGenerationContext, CodeNodeForTestGen } from './types';
import { SupabaseService } from '../supabase/client';
import { getGitHubInfoFromGit } from '../utils/gitUtils';

/**
 * Metrics for tracking test generation efficiency
 */
export interface GenerationMetrics {
  method: 'filesystem' | 'code_nodes';
  totalTimeMs: number;
  totalPromptTokens: number;
  totalResponseTokens: number;
  testsGenerated: number;
  testsFailed: number;
  avgPromptTokensPerTest: number;
  avgTimePerTestMs: number;
}

/**
 * Result from LLM generation including metrics
 */
interface LLMResult {
  test: GeneratedTest | null;
  promptTokens: number;
  responseTokens: number;
  timeMs: number;
}

/**
 * AI-powered Playwright test generator using VS Code Language Model API
 */
export class TestGenerator {
  private outputChannel: vscode.OutputChannel;
  private supabaseService: SupabaseService;
  
  // Metrics tracking
  private currentPromptTokens: number = 0;
  private currentResponseTokens: number = 0;
  private lastFilesystemMetrics: GenerationMetrics | null = null;
  private lastCodeNodesMetrics: GenerationMetrics | null = null;

  constructor(supabaseService: SupabaseService) {
    this.outputChannel = vscode.window.createOutputChannel('Monoid Test Generator');
    this.supabaseService = supabaseService;
  }
  
  /**
   * Get the last metrics for both generation methods
   */
  getMetricsComparison(): { filesystem: GenerationMetrics | null; codeNodes: GenerationMetrics | null } {
    return {
      filesystem: this.lastFilesystemMetrics,
      codeNodes: this.lastCodeNodesMetrics
    };
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
    
    if (result.testPath) {
      this.log(`Test file written: ${result.testPath}`);
      this.log(`Tokens used - Prompt: ${result.promptTokens}, Response: ${result.responseTokens}`);
      this.log('');
      this.log('Test generation complete!');
      this.log('='.repeat(60));
    }

    return result.testPath;
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
   * Returns both the test and metrics about the generation
   */
  private async generateWithLLM(context: TestGenerationContext): Promise<LLMResult> {
    this.log('');
    this.log('Generating test with AI...');

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const provider = config.get<string>('llmProvider') || 'gemini';

    this.log(`Using LLM provider: ${provider}`);

    const startTime = Date.now();
    let result: LLMResult;

    if (provider === 'gemini') {
      result = await this.generateWithGemini(context);
    } else {
      result = await this.generateWithCopilot(context);
    }

    result.timeMs = Date.now() - startTime;
    return result;
  }

  /**
   * Generate test using Google Gemini API
   */
  private async generateWithGemini(context: TestGenerationContext): Promise<LLMResult> {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const apiKey = config.get<string>('geminiApiKey');
    const model = config.get<string>('geminiModel') || 'gemini-3-flash-preview';

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
      
      // Estimate prompt tokens (rough estimate: ~4 chars per token)
      const estimatedPromptTokens = Math.ceil(prompt.length / 4);
      this.log(`Estimated prompt tokens: ${estimatedPromptTokens}`);

      this.log('Sending request to Gemini...');

      const apiResult = await this.callGeminiAPI(apiKey, model, prompt);

      if (!apiResult.text || apiResult.text.trim().length === 0) {
        this.log('ERROR: Empty response from Gemini');
        return {
          test: null,
          promptTokens: apiResult.promptTokens || estimatedPromptTokens,
          responseTokens: apiResult.responseTokens || 0,
          timeMs: 0
        };
      }

      this.log(`Received response (${apiResult.text.length} chars)`);
      this.log(`Actual tokens - Prompt: ${apiResult.promptTokens}, Response: ${apiResult.responseTokens}`);

      // Parse the response
      const test = this.parseGeneratedTest(apiResult.text, context);
      if (!test) {
        this.log('ERROR: Failed to parse Gemini response');
      }
      
      return {
        test,
        promptTokens: apiResult.promptTokens || estimatedPromptTokens,
        responseTokens: apiResult.responseTokens || Math.ceil(apiResult.text.length / 4),
        timeMs: 0
      };
    } catch (error: any) {
      this.log(`ERROR in generateWithGemini: ${error.message}`);
      if (error.stack) {
        this.log(`Stack: ${error.stack}`);
      }
      throw error;
    }
  }

  /**
   * Result from Gemini API call including token usage
   */
  private callGeminiAPI(apiKey: string, model: string, prompt: string): Promise<{ text: string; promptTokens: number; responseTokens: number }> {
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

            // Extract token usage from response
            const usageMetadata = response.usageMetadata || {};
            const promptTokens = usageMetadata.promptTokenCount || Math.ceil(prompt.length / 4);
            const responseTokens = usageMetadata.candidatesTokenCount || 0;

            if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
              resolve({
                text: response.candidates[0].content.parts[0].text,
                promptTokens,
                responseTokens
              });
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
  private async generateWithCopilot(context: TestGenerationContext): Promise<LLMResult> {
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
      
      // Estimate prompt tokens (rough estimate: ~4 chars per token)
      const estimatedPromptTokens = Math.ceil(prompt.length / 4);
      this.log(`Estimated prompt tokens: ${estimatedPromptTokens}`);

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
        return {
          test: null,
          promptTokens: estimatedPromptTokens,
          responseTokens: 0,
          timeMs: 0
        };
      }

      this.log(`Received response (${responseText.length} chars)`);
      
      // Estimate response tokens
      const estimatedResponseTokens = Math.ceil(responseText.length / 4);
      this.log(`Estimated tokens - Prompt: ${estimatedPromptTokens}, Response: ${estimatedResponseTokens}`);

      // Parse the response
      const test = this.parseGeneratedTest(responseText, context);
      if (!test) {
        this.log('ERROR: Failed to parse Copilot response');
      }
      
      return {
        test,
        promptTokens: estimatedPromptTokens,
        responseTokens: estimatedResponseTokens,
        timeMs: 0
      };
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
   * Optimized to use code_node data when available to reduce token usage
   */
  private buildPrompt(context: TestGenerationContext, route: string): string {
    const testIdList = context.dataTestIds && context.dataTestIds.length > 0
      ? `\nAvailable data-testid selectors:\n${context.dataTestIds.map(id => `- ${id}`).join('\n')}`
      : '\nNo data-testid attributes found. Use semantic selectors like getByRole, getByText, etc.';

    // Combine endpoint info from regex parsing and code_nodes (deduplicated)
    const allEndpoints = new Set<string>();
    context.endpoints?.forEach(ep => allEndpoints.add(ep));
    context.endpointNodes?.forEach(n => {
      // Extract route from endpoint name like "GET /api/users/route"
      const routeMatch = n.name.match(/(\/api[^\s]*)/);
      if (routeMatch) {
        allEndpoints.add(routeMatch[1]);
      }
    });
    
    const endpointList = allEndpoints.size > 0
      ? `\nAPI endpoints called by this page:\n${Array.from(allEndpoints).map(ep => `- ${ep}`).join('\n')}`
      : '';

    // For code_nodes method: use snippet from code_node (pre-computed during Visualize)
    // Snippets are ~100-150 chars vs ~5000+ chars for full files = major token savings
    let sourceCode: string;
    if (context.codeNode?.snippet) {
      // Use pre-computed snippet - this is the KEY optimization
      sourceCode = context.codeNode.snippet;
    } else {
      // Fallback: use pageSource but truncate aggressively
      console.warn('Using pageSource instead of codeNode snippet');
      sourceCode = context.pageSource.substring(0, 4000);
    }

    // Build minimal code_node context (only essential fields)
    let codeNodeContext = '';
    if (context.codeNode) {
      const summaryLine = context.codeNode.summary 
        ? `\nComponent Purpose: ${context.codeNode.summary}` 
        : '';
      codeNodeContext = `\nComponent: ${context.codeNode.name} (${context.codeNode.node_type})${summaryLine}`;
    }

    // Only include related components that are actually imported/used (limit to 5)
    let relatedComponentsContext = '';
    if (context.relatedNodes && context.relatedNodes.length > 0) {
      const componentNodes = context.relatedNodes
        .filter(n => n.node_type === 'component')
        .slice(0, 5); // Limit to prevent token bloat
      
      if (componentNodes.length > 0) {
        relatedComponentsContext = `\nUses components: ${componentNodes.map(n => n.name).join(', ')}`;
      }
    }

    return `Generate a Playwright E2E test for this React page.

Page: ${context.pagePath}
Route: ${route}
Base URL: ${context.baseUrl}${codeNodeContext}${relatedComponentsContext}
${testIdList}${endpointList}

Source:
\`\`\`javascript
${sourceCode}
\`\`\`

Requirements:
1. Use @playwright/test
2. Prefer data-testid selectors: page.getByTestId('...')
3. Fallback to semantic selectors: getByRole, getByText
4. Test key user interactions
5. Include proper assertions
6. Handle async with proper waits
7. Include test.describe block

Generate ONLY TypeScript test code, no explanations.`;
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
   * Generate tests for the entire app by finding all page files (filesystem iteration)
   */
  async generateTestsForEntireApp(): Promise<string[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return [];
    }

    // Start timing
    const startTime = Date.now();
    let totalPromptTokens = 0;
    let totalResponseTokens = 0;

    this.outputChannel.show(true);
    this.log('='.repeat(60));
    this.log('Generating E2E Tests for Entire App (Filesystem Method)');
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
            const result = await this.generateTestForFileInternal(file, false); // Don't show individual notifications
            totalPromptTokens += result.promptTokens;
            totalResponseTokens += result.responseTokens;
            
            if (result.testPath) {
              generatedTests.push(result.testPath);
              successCount++;
              this.log(`  ✓ Generated: ${result.testPath} (${result.promptTokens} prompt tokens, ${result.timeMs}ms)`);
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

    const totalTimeMs = Date.now() - startTime;
    
    // Calculate and store metrics
    this.lastFilesystemMetrics = {
      method: 'filesystem',
      totalTimeMs,
      totalPromptTokens,
      totalResponseTokens,
      testsGenerated: successCount,
      testsFailed: failCount,
      avgPromptTokensPerTest: successCount > 0 ? Math.round(totalPromptTokens / successCount) : 0,
      avgTimePerTestMs: successCount > 0 ? Math.round(totalTimeMs / successCount) : 0
    };

    this.log('');
    this.log('='.repeat(60));
    this.log(`Test Generation Complete! (Filesystem Method)`);
    this.log(`  Success: ${successCount}`);
    this.log(`  Failed: ${failCount}`);
    this.log(`  Total: ${uniqueFiles.length}`);
    this.log('');
    this.log('📊 METRICS (Filesystem Method):');
    this.log(`  Total Time: ${(totalTimeMs / 1000).toFixed(2)}s`);
    this.log(`  Total Prompt Tokens: ${totalPromptTokens.toLocaleString()}`);
    this.log(`  Total Response Tokens: ${totalResponseTokens.toLocaleString()}`);
    this.log(`  Avg Prompt Tokens/Test: ${this.lastFilesystemMetrics.avgPromptTokensPerTest.toLocaleString()}`);
    this.log(`  Avg Time/Test: ${this.lastFilesystemMetrics.avgTimePerTestMs}ms`);
    this.log('='.repeat(60));

    if (successCount > 0) {
      vscode.window.showInformationMessage(
        `Generated ${successCount} test file(s)${failCount > 0 ? ` (${failCount} failed)` : ''} - ${totalPromptTokens.toLocaleString()} tokens, ${(totalTimeMs / 1000).toFixed(1)}s`
      );
    } else {
      vscode.window.showErrorMessage('Failed to generate any tests');
    }

    return generatedTests;
  }

  /**
   * Generate tests based on code_nodes from Supabase instead of filesystem iteration.
   * This uses the code graph to understand component relationships and generate more targeted tests.
   */
  async generateTestsFromCodeNodes(): Promise<string[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return [];
    }

    // Start timing
    const startTime = Date.now();
    let totalPromptTokens = 0;
    let totalResponseTokens = 0;

    this.outputChannel.show(true);
    this.log('='.repeat(60));
    this.log('Generating E2E Tests from Code Graph (code_nodes Method)');
    this.log('='.repeat(60));

    try {
      // Get workspace and repo info
      const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
      const workspace = await this.supabaseService.getOrCreateWorkspace(workspaceFolder.name);
      
      let organizationId: string | undefined;
      if (gitInfo?.owner) {
        const organization = await this.supabaseService.getOrCreateOrganization(gitInfo.owner);
        organizationId = organization.id;
      }

      const repoOwner = gitInfo?.owner || 'local';
      const repoName = gitInfo?.repo || workspaceFolder.name;
      const repo = await this.supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);

      // Get the latest version
      const version = await this.supabaseService.getLatestVersion(repo.id);
      if (!version) {
        this.log('ERROR: No code graph version found. Run "Visualize Codebase" first to analyze your code.');
        vscode.window.showErrorMessage('No code graph found. Run "Visualize Codebase" first to analyze your code.');
        return [];
      }

      this.log(`Using version: ${version.id} (${version.commit_sha.substring(0, 8)})`);

      // Query code_nodes for components (these are the testable units)
      const componentNodes = await this.supabaseService.getCodeNodesByType(version.id, ['component']);
      
      // Filter to only PAGE components (same as filesystem method for fair comparison)
      // This excludes shared components like Button, Card, Modal, etc.
      const testableNodes = componentNodes.filter(node => {
        const fileName = path.basename(node.file_path);
        const baseName = fileName.replace(/\.(js|jsx|ts|tsx)$/, '');
        
        // Exclude layout, loading, error, etc.
        const excludedNames = ['layout', 'loading', 'error', 'not-found', '_app', '_document', '_error', 'RootLayout'];
        if (excludedNames.includes(baseName) || excludedNames.includes(node.name)) {
          return false;
        }
        
        // ONLY include page components (from app router) - same as filesystem method
        // This means the file must be named "page.js/tsx" or be in a pages directory
        const isPageFile = fileName.startsWith('page.');
        const isInPagesDir = node.file_path.includes('/pages/');
        
        return isPageFile || isInPagesDir;
      });

      if (testableNodes.length === 0) {
        this.log('No testable components found in code graph.');
        vscode.window.showWarningMessage('No testable components found in code graph.');
        return [];
      }

      this.log(`Found ${testableNodes.length} testable component(s) from code graph:`);
      testableNodes.forEach(node => {
        this.log(`  - ${node.name} (${node.file_path})`);
      });
      this.log('');

      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const baseUrl = config.get<string>('testBaseUrl') || 'http://localhost:3000';
      const testOutputDir = config.get<string>('testOutputDir') || 'e2e';

      // Ensure test directory exists
      const testDirPath = path.join(workspaceFolder.uri.fsPath, testOutputDir);
      if (!fs.existsSync(testDirPath)) {
        fs.mkdirSync(testDirPath, { recursive: true });
      }

      const generatedTests: string[] = [];
      let successCount = 0;
      let failCount = 0;

      // Generate tests with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating E2E Tests from Code Graph',
          cancellable: true
        },
        async (progress, token) => {
          for (let i = 0; i < testableNodes.length; i++) {
            if (token.isCancellationRequested) {
              this.log('Test generation cancelled by user');
              break;
            }

            const codeNode = testableNodes[i];
            
            progress.report({
              message: `(${i + 1}/${testableNodes.length}) ${codeNode.name}`,
              increment: (1 / testableNodes.length) * 100
            });

            this.log(`[${i + 1}/${testableNodes.length}] Generating test for: ${codeNode.name} (${codeNode.file_path})`);

            try {
              const result = await this.generateTestForCodeNode(
                codeNode,
                version.id,
                workspaceFolder.uri.fsPath,
                baseUrl,
                testOutputDir
              );
              
              totalPromptTokens += result.promptTokens;
              totalResponseTokens += result.responseTokens;
              
              if (result.testPath) {
                generatedTests.push(result.testPath);
                successCount++;
                this.log(`  ✓ Generated: ${result.testPath} (${result.promptTokens} prompt tokens, ${result.timeMs}ms)`);
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

      const totalTimeMs = Date.now() - startTime;
      
      // Calculate and store metrics
      this.lastCodeNodesMetrics = {
        method: 'code_nodes',
        totalTimeMs,
        totalPromptTokens,
        totalResponseTokens,
        testsGenerated: successCount,
        testsFailed: failCount,
        avgPromptTokensPerTest: successCount > 0 ? Math.round(totalPromptTokens / successCount) : 0,
        avgTimePerTestMs: successCount > 0 ? Math.round(totalTimeMs / successCount) : 0
      };

      this.log('');
      this.log('='.repeat(60));
      this.log(`Test Generation from Code Graph Complete!`);
      this.log(`  Success: ${successCount}`);
      this.log(`  Failed: ${failCount}`);
      this.log(`  Total: ${testableNodes.length}`);
      this.log('');
      this.log('📊 METRICS (Code Nodes Method):');
      this.log(`  Total Time: ${(totalTimeMs / 1000).toFixed(2)}s`);
      this.log(`  Total Prompt Tokens: ${totalPromptTokens.toLocaleString()}`);
      this.log(`  Total Response Tokens: ${totalResponseTokens.toLocaleString()}`);
      this.log(`  Avg Prompt Tokens/Test: ${this.lastCodeNodesMetrics.avgPromptTokensPerTest.toLocaleString()}`);
      this.log(`  Avg Time/Test: ${this.lastCodeNodesMetrics.avgTimePerTestMs}ms`);
      
      // Compare with filesystem method if available
      if (this.lastFilesystemMetrics) {
        this.log('');
        this.log('📈 COMPARISON (Code Nodes vs Filesystem):');
        const tokenSavings = this.lastFilesystemMetrics.totalPromptTokens - totalPromptTokens;
        const tokenSavingsPercent = this.lastFilesystemMetrics.totalPromptTokens > 0 
          ? ((tokenSavings / this.lastFilesystemMetrics.totalPromptTokens) * 100).toFixed(1)
          : '0';
        const timeSavings = this.lastFilesystemMetrics.totalTimeMs - totalTimeMs;
        const timeSavingsPercent = this.lastFilesystemMetrics.totalTimeMs > 0
          ? ((timeSavings / this.lastFilesystemMetrics.totalTimeMs) * 100).toFixed(1)
          : '0';
        
        this.log(`  Token Savings: ${tokenSavings.toLocaleString()} tokens (${tokenSavingsPercent}% ${tokenSavings >= 0 ? 'saved' : 'more'})`);
        this.log(`  Time Savings: ${(timeSavings / 1000).toFixed(2)}s (${timeSavingsPercent}% ${timeSavings >= 0 ? 'faster' : 'slower'})`);
        this.log(`  Filesystem Avg Tokens/Test: ${this.lastFilesystemMetrics.avgPromptTokensPerTest.toLocaleString()}`);
        this.log(`  Code Nodes Avg Tokens/Test: ${this.lastCodeNodesMetrics.avgPromptTokensPerTest.toLocaleString()}`);
      }
      this.log('='.repeat(60));

      if (successCount > 0) {
        vscode.window.showInformationMessage(
          `Generated ${successCount} test file(s) from code graph${failCount > 0 ? ` (${failCount} failed)` : ''} - ${totalPromptTokens.toLocaleString()} tokens, ${(totalTimeMs / 1000).toFixed(1)}s`
        );
      } else {
        vscode.window.showErrorMessage('Failed to generate any tests from code graph');
      }

      return generatedTests;
    } catch (error: any) {
      this.log(`ERROR: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to generate tests from code graph: ${error.message}`);
      return [];
    }
  }

  /**
   * Run both generation methods and compare their efficiency.
   * This generates tests using filesystem iteration first, then using code_nodes,
   * and provides a detailed comparison of time and token usage.
   */
  async runBenchmarkComparison(): Promise<void> {
    this.outputChannel.show(true);
    this.log('');
    this.log('╔'.padEnd(60, '═') + '╗');
    this.log('║ BENCHMARK: Filesystem vs Code Nodes Test Generation'.padEnd(59) + '║');
    this.log('╚'.padEnd(60, '═') + '╝');
    this.log('');

    // Reset metrics
    this.lastFilesystemMetrics = null;
    this.lastCodeNodesMetrics = null;

    // Run filesystem method first
    this.log('>>> Phase 1: Running Filesystem Method...');
    this.log('');
    const filesystemTests = await this.generateTestsForEntireApp();
    
    this.log('');
    this.log('>>> Phase 2: Running Code Nodes Method...');
    this.log('');
    
    // Clear generated tests to re-generate with code_nodes method
    // (In production you might want to use different output dirs)
    const codeNodesTests = await this.generateTestsFromCodeNodes();

    // Final comparison summary
    this.log('');
    this.log('╔'.padEnd(60, '═') + '╗');
    this.log('║ FINAL BENCHMARK RESULTS'.padEnd(59) + '║');
    this.log('╠'.padEnd(60, '═') + '╣');
    
    if (this.lastFilesystemMetrics && this.lastCodeNodesMetrics) {
      const fsMetrics = this.lastFilesystemMetrics as GenerationMetrics;
      const cnMetrics = this.lastCodeNodesMetrics as GenerationMetrics;
      
      this.log(`║ Filesystem Method:`.padEnd(59) + '║');
      this.log(`║   Tests: ${fsMetrics.testsGenerated} generated, ${fsMetrics.testsFailed} failed`.padEnd(59) + '║');
      this.log(`║   Time: ${(fsMetrics.totalTimeMs / 1000).toFixed(2)}s (${fsMetrics.avgTimePerTestMs}ms/test)`.padEnd(59) + '║');
      this.log(`║   Tokens: ${fsMetrics.totalPromptTokens.toLocaleString()} prompt, ${fsMetrics.totalResponseTokens.toLocaleString()} response`.padEnd(59) + '║');
      this.log('╠'.padEnd(60, '─') + '╣');
      this.log(`║ Code Nodes Method:`.padEnd(59) + '║');
      this.log(`║   Tests: ${cnMetrics.testsGenerated} generated, ${cnMetrics.testsFailed} failed`.padEnd(59) + '║');
      this.log(`║   Time: ${(cnMetrics.totalTimeMs / 1000).toFixed(2)}s (${cnMetrics.avgTimePerTestMs}ms/test)`.padEnd(59) + '║');
      this.log(`║   Tokens: ${cnMetrics.totalPromptTokens.toLocaleString()} prompt, ${cnMetrics.totalResponseTokens.toLocaleString()} response`.padEnd(59) + '║');
      this.log('╠'.padEnd(60, '─') + '╣');
      
      // Calculate differences
      const tokenDiff = fsMetrics.totalPromptTokens - cnMetrics.totalPromptTokens;
      const tokenDiffPercent = fsMetrics.totalPromptTokens > 0 ? ((tokenDiff / fsMetrics.totalPromptTokens) * 100).toFixed(1) : '0';
      const timeDiff = fsMetrics.totalTimeMs - cnMetrics.totalTimeMs;
      const timeDiffPercent = fsMetrics.totalTimeMs > 0 ? ((timeDiff / fsMetrics.totalTimeMs) * 100).toFixed(1) : '0';
      
      this.log(`║ EFFICIENCY GAINS (Code Nodes vs Filesystem):`.padEnd(59) + '║');
      if (tokenDiff >= 0) {
        this.log(`║   ✓ Token Savings: ${tokenDiff.toLocaleString()} tokens (${tokenDiffPercent}%)`.padEnd(59) + '║');
      } else {
        this.log(`║   ✗ Token Increase: ${Math.abs(tokenDiff).toLocaleString()} tokens (${Math.abs(parseFloat(tokenDiffPercent))}%)`.padEnd(59) + '║');
      }
      if (timeDiff >= 0) {
        this.log(`║   ✓ Time Savings: ${(timeDiff / 1000).toFixed(2)}s (${timeDiffPercent}%)`.padEnd(59) + '║');
      } else {
        this.log(`║   ✗ Time Increase: ${(Math.abs(timeDiff) / 1000).toFixed(2)}s (${Math.abs(parseFloat(timeDiffPercent))}%)`.padEnd(59) + '║');
      }
    } else {
      this.log(`║ Unable to compare - one or both methods failed`.padEnd(59) + '║');
    }
    
    this.log('╚'.padEnd(60, '═') + '╝');
    
    vscode.window.showInformationMessage('Benchmark comparison complete. Check the output channel for detailed results.');
  }

  /**
   * Generate a test for a specific code_node
   * Returns both the test path and metrics
   * 
   * OPTIMIZATION: Uses code_node snippet when available instead of reading full file
   * Snippets are pre-computed during "Visualize All Code" and stored in Supabase
   */
  private async generateTestForCodeNode(
    codeNode: CodeNodeForTestGen,
    versionId: string,
    workspacePath: string,
    baseUrl: string,
    testOutputDir: string
  ): Promise<{ testPath: string | null; promptTokens: number; responseTokens: number; timeMs: number }> {
    try {
      let pageSource: string;
      
      // OPTIMIZATION: Snippets are already stored in code_nodes from "Visualize All Code"
      // They're typically ~100-150 chars vs ~5000+ chars for full files
      if (codeNode.snippet) {
        this.log(`  Using pre-computed snippet (${codeNode.snippet.length} chars) instead of full file`);
        pageSource = codeNode.snippet;
      } else {
        // Fallback: Read the source file only if no snippet exists
        const absoluteFilePath = path.join(workspacePath, codeNode.file_path);
        if (!fs.existsSync(absoluteFilePath)) {
          this.log(`  Source file not found: ${absoluteFilePath}`);
          return { testPath: null, promptTokens: 0, responseTokens: 0, timeMs: 0 };
        }
        this.log(`  No snippet available, reading full file`);
        pageSource = fs.readFileSync(absoluteFilePath, 'utf-8');
      }

      // Get related nodes and endpoints from the code graph
      // These are pre-computed during "Visualize All Code" so it's just a DB query, not analysis
      const relatedNodes = await this.supabaseService.getRelatedCodeNodes(versionId, codeNode.file_path);
      const endpointNodes = await this.supabaseService.getEndpointsForComponent(versionId, codeNode.id);

      // Build enhanced context with code_node data
      const baseContext = this.extractContext(pageSource, codeNode.file_path, baseUrl);
      const context: TestGenerationContext = {
        ...baseContext,
        codeNode,
        relatedNodes,
        endpointNodes
      };

      // Generate test using LLM
      const llmResult = await this.generateWithLLM(context);
      if (!llmResult.test) {
        return { testPath: null, promptTokens: llmResult.promptTokens, responseTokens: llmResult.responseTokens, timeMs: llmResult.timeMs };
      }

      // Generate test file name based on code_node
      const testFileName = this.generateTestFileNameFromCodeNode(codeNode);
      const testFilePath = path.join(testOutputDir, testFileName);
      const absoluteTestPath = path.join(workspacePath, testFilePath);

      // Write the test file
      fs.writeFileSync(absoluteTestPath, llmResult.test.code, 'utf-8');

      // Save to Supabase with direct coverage edges to the code_node
      await this.saveTestFromCodeNode(
        versionId,
        testFilePath,
        llmResult.test,
        context,
        codeNode,
        endpointNodes
      );

      return { testPath: testFilePath, promptTokens: llmResult.promptTokens, responseTokens: llmResult.responseTokens, timeMs: llmResult.timeMs };
    } catch (error: any) {
      this.log(`  Error generating test for code_node: ${error.message}`);
      return { testPath: null, promptTokens: 0, responseTokens: 0, timeMs: 0 };
    }
  }

  /**
   * Generate test file name from a code_node
   */
  private generateTestFileNameFromCodeNode(codeNode: CodeNodeForTestGen): string {
    // Use the component name or derive from file path
    let name = codeNode.name;
    
    // For page components, use the directory structure
    if (codeNode.file_path.includes('/page.')) {
      name = codeNode.file_path
        .replace(/^app\//, '')
        .replace(/^src\/app\//, '')
        .replace(/\/page\.(js|jsx|ts|tsx)$/, '')
        .replace(/\//g, '-');
      
      if (!name || name === '-') {
        name = 'homepage';
      }
    } else {
      // For regular components, use the component name
      name = codeNode.name.toLowerCase();
    }

    return `${name}.spec.ts`;
  }

  /**
   * Save test to Supabase with direct coverage edges to the source code_node
   */
  private async saveTestFromCodeNode(
    versionId: string,
    testFilePath: string,
    generatedTest: GeneratedTest,
    context: TestGenerationContext,
    sourceCodeNode: CodeNodeForTestGen,
    endpointNodes: CodeNodeForTestGen[]
  ): Promise<void> {
    try {
      // Parse test names from the generated code
      const tests: LocalTestNode[] = [];
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
              generatedFrom: context.pagePath,
              sourceCodeNodeId: sourceCodeNode.id,
              sourceCodeNodeName: sourceCodeNode.name
            }
          });
        }
      }

      if (tests.length === 0) {
        return;
      }

      // Save test nodes
      const testIdMap = await this.supabaseService.saveTestNodes(versionId, tests);
      this.log(`  Saved ${tests.length} test(s) to Supabase`);

      // Create coverage edges directly linking tests to the source code_node
      const coverageEdges: LocalTestCoverageEdge[] = [];

      for (const test of tests) {
        // Direct coverage edge to the source component
        coverageEdges.push({
          test_stable_id: test.stable_id,
          code_stable_id: sourceCodeNode.stable_id,
          coverage_type: 'covers'
        });

        // Coverage edges to endpoints
        for (const endpoint of endpointNodes) {
          coverageEdges.push({
            test_stable_id: test.stable_id,
            code_stable_id: endpoint.stable_id,
            coverage_type: 'tests_endpoint'
          });
        }

        // Also link to related components found in context
        if (context.relatedNodes) {
          for (const relatedNode of context.relatedNodes) {
            if (relatedNode.node_type === 'component' && relatedNode.id !== sourceCodeNode.id) {
              coverageEdges.push({
                test_stable_id: test.stable_id,
                code_stable_id: relatedNode.stable_id,
                coverage_type: 'covers'
              });
            }
          }
        }
      }

      if (coverageEdges.length > 0) {
        // Get code node ID map for resolving stable_ids
        const codeIdMap = await this.supabaseService.getCodeNodeIdMap(versionId);
        await this.supabaseService.saveTestCoverageEdges(versionId, coverageEdges, testIdMap, codeIdMap);
        this.log(`  Saved ${coverageEdges.length} coverage edge(s)`);
      }
    } catch (error: any) {
      this.log(`  Supabase error: ${error.message}`);
    }
  }

  /**
   * Internal method for generating test without showing notification
   * Returns both the test path and metrics
   */
  private async generateTestForFileInternal(fileUri: vscode.Uri, showNotification: boolean = true): Promise<{ testPath: string | null; promptTokens: number; responseTokens: number; timeMs: number }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { testPath: null, promptTokens: 0, responseTokens: 0, timeMs: 0 };
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
      const llmResult = await this.generateWithLLM(context);
      if (!llmResult.test) {
        return { testPath: null, promptTokens: llmResult.promptTokens, responseTokens: llmResult.responseTokens, timeMs: llmResult.timeMs };
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
      fs.writeFileSync(absoluteTestPath, llmResult.test.code, 'utf-8');

      // Try to save to Supabase (non-blocking)
      this.saveToSupabase(workspaceFolder.name, testFilePath, llmResult.test, context).catch(() => {});

      if (showNotification) {
        vscode.window.showInformationMessage(`Generated test: ${testFileName}`);
      }

      return { testPath: testFilePath, promptTokens: llmResult.promptTokens, responseTokens: llmResult.responseTokens, timeMs: llmResult.timeMs };
    } catch (error: any) {
      this.log(`ERROR generating test: ${error.message}`);
      if (error.stack) {
        this.log(`Stack: ${error.stack}`);
      }
      if (showNotification) {
        vscode.window.showErrorMessage(`Failed to generate test: ${error.message}`);
      }
      return { testPath: null, promptTokens: 0, responseTokens: 0, timeMs: 0 };
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

  /**
   * Check if test files already exist in the e2e directory
   */
  hasExistingTests(): boolean {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return false;
    }

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const testOutputDir = config.get<string>('testOutputDir') || 'e2e';
    const testDirPath = path.join(workspaceFolder.uri.fsPath, testOutputDir);

    if (!fs.existsSync(testDirPath)) {
      return false;
    }

    const files = fs.readdirSync(testDirPath);
    return files.some(f => f.endsWith('.spec.ts') || f.endsWith('.spec.js'));
  }

  /**
   * Get list of existing test files
   */
  getExistingTestFiles(): string[] {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const testOutputDir = config.get<string>('testOutputDir') || 'e2e';
    const testDirPath = path.join(workspaceFolder.uri.fsPath, testOutputDir);

    if (!fs.existsSync(testDirPath)) {
      return [];
    }

    const files = fs.readdirSync(testDirPath);
    return files
      .filter(f => f.endsWith('.spec.ts') || f.endsWith('.spec.js'))
      .map(f => path.join(testOutputDir, f));
  }

  /**
   * Sync existing test files to Supabase without regenerating them
   */
  async syncExistingTestsToSupabase(): Promise<number> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return 0;
    }

    this.outputChannel.show(true);
    this.log('='.repeat(60));
    this.log('Syncing Existing Tests to Supabase');
    this.log('='.repeat(60));

    const testFiles = this.getExistingTestFiles();
    if (testFiles.length === 0) {
      this.log('No existing test files found');
      vscode.window.showInformationMessage('No test files found in e2e directory');
      return 0;
    }

    this.log(`Found ${testFiles.length} test file(s)`);

    // Get or create version (same logic as saveToSupabase)
    const gitInfo = await getGitHubInfoFromGit(workspaceFolder.uri.fsPath);
    const workspace = await this.supabaseService.getOrCreateWorkspace(workspaceFolder.name);

    let organizationId: string | undefined;
    if (gitInfo?.owner) {
      const organization = await this.supabaseService.getOrCreateOrganization(gitInfo.owner);
      organizationId = organization.id;
    }

    const repoOwner = gitInfo?.owner || 'local';
    const repoName = gitInfo?.repo || workspaceFolder.name;
    const repo = await this.supabaseService.getOrCreateRepo(workspace.id, repoName, repoOwner, organizationId);

    let version = await this.supabaseService.getLatestVersion(repo.id);
    if (!version) {
      const commitSha = this.generateCommitSha();
      version = await this.supabaseService.createVersion(repo.id, commitSha, gitInfo?.branch || 'main');
      this.log(`Created new version: ${version.id}`);
    } else {
      this.log(`Using existing version: ${version.id}`);
    }

    // Parse and save all test files
    const allTests: LocalTestNode[] = [];

    for (const testFilePath of testFiles) {
      const absolutePath = path.join(workspaceFolder.uri.fsPath, testFilePath);
      const content = fs.readFileSync(absolutePath, 'utf-8');
      
      this.log(`Parsing: ${testFilePath}`);
      
      // Parse test names from the file
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineMatch = lines[i].match(/test\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (lineMatch) {
          const testName = lineMatch[1];
          allTests.push({
            stable_id: `${testFilePath}::${testName}`,
            name: testName,
            description: `E2E test: ${testName}`,
            test_type: 'e2e',
            source_type: 'synced',
            file_path: testFilePath,
            start_line: i + 1,
            runner: 'playwright',
            command: `npx playwright test ${testFilePath} -g "${testName}"`,
            metadata: {
              syncedAt: new Date().toISOString()
            }
          });
          this.log(`  Found test: ${testName}`);
        }
      }
    }

    if (allTests.length === 0) {
      this.log('No tests found in the test files');
      vscode.window.showWarningMessage('No test() calls found in the test files');
      return 0;
    }

    // Save to Supabase
    this.log(`Saving ${allTests.length} test(s) to Supabase...`);
    await this.supabaseService.saveTestNodes(version.id, allTests);

    this.log('');
    this.log(`Successfully synced ${allTests.length} tests to Supabase`);
    this.log('='.repeat(60));

    vscode.window.showInformationMessage(`Synced ${allTests.length} tests to Supabase`);
    return allTests.length;
  }
}
