import * as vscode from 'vscode';
import { LocalNode, LocalEdge } from '../types';

/**
 * LLM-based analyzer for detecting complex relationships between nodes
 * 
 * Strategy:
 * 1. Run heuristics to generate initial API call guesses
 * 2. Send guesses + code + all endpoints to LLM
 * 3. LLM validates guesses AND discovers additional calls heuristics missed
 * 4. If LLM fails, the entire edge detection fails (no silent fallback)
 */

interface GuessedApiCall {
  componentName: string;
  componentStableId: string;
  endpoint: string;
  endpointStableId: string;
  method: string;
  matchedPath: string;
  confidence: 'high' | 'medium' | 'low';
}

export class LLMAnalyzer {
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  /**
   * Analyze frontend-backend relationships using heuristics + LLM
   */
  async analyzeApiRelationships(
    nodes: LocalNode[],
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<LocalEdge[]> {
    // Separate components and endpoints
    const components = nodes.filter(n => 
      n.node_type === 'component' || n.node_type === 'hook' || n.node_type === 'function'
    );
    const endpoints = nodes.filter(n => n.node_type === 'endpoint');

    if (endpoints.length === 0) {
      this.log('No API endpoints found - skipping frontend-backend analysis');
      return [];
    }

    this.log('');
    this.log('='.repeat(60));
    this.log('Phase 3: Analyzing frontend → backend relationships...');
    this.log('='.repeat(60));
    this.log(`Components to analyze: ${components.length}`);
    this.log(`Known endpoints: ${endpoints.map(e => e.name).join(', ')}`);
    this.log('');

    // Step 1: Run heuristics to generate guesses
    this.log('Step 1: Running heuristics to generate initial guesses...');
    const guesses = await this.generateHeuristicGuesses(components, endpoints, workspaceFolder);
    
    this.log(`  Found ${guesses.length} potential API calls from heuristics`);
    if (guesses.length > 0) {
      for (const guess of guesses) {
        this.log(`    • ${guess.componentName} → ${guess.endpoint} (${guess.confidence}, path: ${guess.matchedPath})`);
      }
    }

    // Step 2: Use LLM to validate guesses AND discover additional calls
    this.log('');
    this.log('Step 2: Using LLM to validate and discover API calls...');
    
    try {
      const edges = await this.analyzeWithLLM(guesses, components, endpoints, workspaceFolder);
      this.log('');
      this.log(`Frontend → Backend edges found: ${edges.length}`);
      return edges;
    } catch (error) {
      this.log(`  ❌ LLM analysis failed: ${error}`);
      this.log('  ❌ All frontend → backend edges will be skipped (no fallback)');
      this.log('  💡 Tip: Run "Monoid: Test VS Code LM" command to debug LLM availability');
      return [];
    }
  }

  /**
   * Generate guesses using heuristics
   */
  private async generateHeuristicGuesses(
    components: LocalNode[],
    endpoints: LocalNode[],
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<GuessedApiCall[]> {
    const guesses: GuessedApiCall[] = [];

    for (const component of components) {
      try {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, component.file_path);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const lines = document.getText().split('\n');
        const componentCode = lines.slice(component.start_line - 1, component.end_line).join('\n');

        const apiPaths = this.extractApiPaths(componentCode);
        
        for (const apiPath of apiPaths) {
          const matchedEndpoints = this.matchEndpoints(apiPath, endpoints);
          
          for (const endpoint of matchedEndpoints) {
            guesses.push({
              componentName: component.name,
              componentStableId: component.stable_id,
              endpoint: endpoint.name,
              endpointStableId: endpoint.stable_id,
              method: apiPath.method,
              matchedPath: apiPath.path,
              confidence: this.determineConfidence(apiPath.path, endpoint.name)
            });
          }
        }
      } catch (error) {
        // Silently skip files that can't be read
      }
    }

    return guesses;
  }

  /**
   * Use LLM to validate guesses AND discover additional API calls
   */
  private async analyzeWithLLM(
    guesses: GuessedApiCall[],
    components: LocalNode[],
    endpoints: LocalNode[],
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<LocalEdge[]> {
    // Get gpt-4o-mini model
    let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
    
    if (models.length === 0) {
      // Fallback to any copilot model
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0) {
        throw new Error('No language models available. Make sure GitHub Copilot is installed and signed in.');
      }
    }

    const model = models[0];
    this.log(`  Using model: ${model.id}`);
    
    const edges: LocalEdge[] = [];
    const endpointMap = new Map(endpoints.map(e => [e.name, e]));

    // Build a map of guesses by component for reference
    const guessesByComponent = new Map<string, GuessedApiCall[]>();
    for (const guess of guesses) {
      const existing = guessesByComponent.get(guess.componentStableId) || [];
      existing.push(guess);
      guessesByComponent.set(guess.componentStableId, existing);
    }

    // Analyze each component
    for (const component of components) {
      try {
        // Read component code
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, component.file_path);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const lines = document.getText().split('\n');
        const componentCode = lines.slice(component.start_line - 1, component.end_line).join('\n');

        // Skip if component is too small or doesn't seem to make API calls
        if (componentCode.length < 100) { continue; }
        if (!componentCode.includes('fetch') && !componentCode.includes('axios') && 
            !componentCode.includes('/api') && !componentCode.includes('useSWR') &&
            !componentCode.includes('useQuery')) {
          continue;
        }

        // Get heuristic guesses for this component
        const componentGuesses = guessesByComponent.get(component.stable_id) || [];
        const guessedCalls = componentGuesses.length > 0
          ? `Our heuristics detected these potential calls:\n${componentGuesses.map(g => `- ${g.endpoint} (path: ${g.matchedPath})`).join('\n')}`
          : 'Our heuristics did not detect any API calls in this component.';

        // Build the prompt
        const prompt = `Analyze this React component and identify ALL API endpoint calls it makes.

Component "${component.name}" from ${component.file_path}:
\`\`\`javascript
${componentCode.substring(0, 5000)}
\`\`\`

${guessedCalls}

Available API endpoints in this codebase:
${endpoints.map(e => `- ${e.name}`).join('\n')}

TASK: 
1. Validate any heuristic guesses (confirm or reject)
2. Find ANY ADDITIONAL API calls to the listed endpoints that heuristics might have missed
3. Look for fetch(), axios, useSWR, useQuery, or any HTTP calls

Respond with JSON only:
{
  "apiCalls": [
    { "endpoint": "GET /api/dashboard/stats", "confirmed": true, "source": "heuristic", "reason": "fetch call in useEffect" },
    { "endpoint": "POST /api/contact", "confirmed": true, "source": "discovered", "reason": "form submission handler" }
  ]
}

Only include endpoints from the available list above. Use "source": "heuristic" for validating guesses, "source": "discovered" for new finds.`;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

        // Collect response
        let responseText = '';
        for await (const chunk of response.text) {
          responseText += chunk;
        }

        // Parse response
        const jsonMatch = responseText.match(/\{[\s\S]*"apiCalls"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            const apiCalls = parsed.apiCalls || [];

            for (const call of apiCalls) {
              if (call.confirmed) {
                const endpoint = endpointMap.get(call.endpoint);
                if (endpoint) {
                  const isDiscovered = call.source === 'discovered';
                  const icon = isDiscovered ? '🔍' : '✓';
                  this.log(`    ${icon} ${component.name} → ${call.endpoint} (${call.source}: ${call.reason})`);
                  
                  edges.push({
                    source_stable_id: component.stable_id,
                    target_stable_id: endpoint.stable_id,
                    edge_type: 'calls',
                    metadata: { 
                      detection: isDiscovered ? 'llm_discovered' : 'llm_validated',
                      llmReason: call.reason
                    }
                  });
                }
              }
            }
          } catch (parseError) {
            this.log(`    ⚠️ Could not parse LLM response for ${component.name}`);
          }
        }
      } catch (error) {
        this.log(`    ⚠️ Error analyzing ${component.name}: ${error}`);
      }
    }

    return edges;
  }

  private extractApiPaths(code: string): Array<{ path: string; method: string }> {
    const paths: Array<{ path: string; method: string }> = [];
    
    // Pattern 1: fetch('/api/...')
    const fetchPattern = /fetch\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;
    let match;
    while ((match = fetchPattern.exec(code)) !== null) {
      const context = code.substring(Math.max(0, match.index - 100), match.index + match[0].length + 100);
      const method = this.inferMethod(context);
      paths.push({ path: match[1], method });
    }

    // Pattern 2: fetch(`/api/...`) with template literals
    const fetchTemplatePattern = /fetch\s*\(\s*`(\/api\/[^`]*)`/g;
    while ((match = fetchTemplatePattern.exec(code)) !== null) {
      const context = code.substring(Math.max(0, match.index - 100), match.index + match[0].length + 100);
      const method = this.inferMethod(context);
      const normalizedPath = match[1].replace(/\$\{[^}]+\}/g, '[id]');
      paths.push({ path: normalizedPath, method });
    }

    // Pattern 3: axios.get/post/etc('/api/...')
    const axiosPattern = /axios\.(get|post|put|patch|delete)\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/gi;
    while ((match = axiosPattern.exec(code)) !== null) {
      paths.push({ path: match[2], method: match[1].toUpperCase() });
    }

    // Pattern 4: useSWR or useQuery with API paths
    const hookPattern = /(?:useSWR|useQuery)\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;
    while ((match = hookPattern.exec(code)) !== null) {
      paths.push({ path: match[1], method: 'GET' });
    }

    return paths;
  }

  private inferMethod(context: string): string {
    if (/method\s*:\s*['"]POST['"]/i.test(context)) { return 'POST'; }
    if (/method\s*:\s*['"]PUT['"]/i.test(context)) { return 'PUT'; }
    if (/method\s*:\s*['"]PATCH['"]/i.test(context)) { return 'PATCH'; }
    if (/method\s*:\s*['"]DELETE['"]/i.test(context)) { return 'DELETE'; }
    return 'GET';
  }

  private matchEndpoints(
    apiPath: { path: string; method: string },
    endpoints: LocalNode[]
  ): LocalNode[] {
    const matched: LocalNode[] = [];
    
    for (const endpoint of endpoints) {
      const endpointMatch = endpoint.name.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/);
      if (!endpointMatch) { continue; }
      
      const endpointMethod = endpointMatch[1];
      let endpointPath = endpointMatch[2];
      
      // Normalize Next.js route paths
      endpointPath = endpointPath.replace(/\/route$/, '');
      
      // Normalize API path
      const normalizedApiPath = apiPath.path
        .replace(/\/\d+/g, '/[id]')
        .replace(/\/[a-f0-9-]{36}/gi, '/[id]');
      
      const pathsMatch = normalizedApiPath === endpointPath || 
                         normalizedApiPath.startsWith(endpointPath + '/') ||
                         this.fuzzyPathMatch(normalizedApiPath, endpointPath);
      
      const methodsMatch = apiPath.method === endpointMethod;
      
      if (pathsMatch && methodsMatch) {
        matched.push(endpoint);
      }
    }
    
    return matched;
  }

  private fuzzyPathMatch(apiPath: string, endpointPath: string): boolean {
    const normalize = (p: string) => p
      .replace(/\/route$/, '')
      .replace(/\[\w+\]/g, '*')
      .replace(/\$\{[^}]+\}/g, '*');
    
    const normalizedApi = normalize(apiPath);
    const normalizedEndpoint = normalize(endpointPath);
    
    if (normalizedApi === normalizedEndpoint) { return true; }
    
    const apiParts = normalizedApi.split('/').filter(Boolean);
    const endpointParts = normalizedEndpoint.split('/').filter(Boolean);
    
    const minLen = Math.min(apiParts.length, endpointParts.length);
    for (let i = 0; i < minLen; i++) {
      if (apiParts[i] !== endpointParts[i] && apiParts[i] !== '*' && endpointParts[i] !== '*') {
        return false;
      }
    }
    
    return true;
  }

  private determineConfidence(apiPath: string, endpointName: string): 'high' | 'medium' | 'low' {
    const endpointPath = endpointName.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, '').replace(/\/route$/, '');
    if (apiPath === endpointPath) { return 'high'; }
    if (apiPath.includes('[') || apiPath.includes('${')) { return 'medium'; }
    return 'low';
  }
}

/**
 * Test command to debug VS Code Language Model availability
 */
export async function testVSCodeLM(): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Monoid LM Test');
  outputChannel.show(true);
  
  outputChannel.appendLine('='.repeat(60));
  outputChannel.appendLine('Testing VS Code Language Model API');
  outputChannel.appendLine('='.repeat(60));
  outputChannel.appendLine('');

  // Check if the API is available
  outputChannel.appendLine('1. Checking if vscode.lm API exists...');
  if (!vscode.lm) {
    outputChannel.appendLine('   ❌ vscode.lm is undefined - Language Model API not available');
    outputChannel.appendLine('   This usually means VS Code version is too old or Copilot is not installed');
    return;
  }
  outputChannel.appendLine('   ✓ vscode.lm API exists');

  // Try to list all available models
  outputChannel.appendLine('');
  outputChannel.appendLine('2. Listing all available models...');
  try {
    const allModels = await vscode.lm.selectChatModels({});
    if (allModels.length === 0) {
      outputChannel.appendLine('   ❌ No models available');
      outputChannel.appendLine('   Make sure GitHub Copilot is installed and you are signed in');
    } else {
      outputChannel.appendLine(`   ✓ Found ${allModels.length} model(s):`);
      for (const model of allModels) {
        outputChannel.appendLine(`     - ${model.id} (vendor: ${model.vendor}, family: ${model.family})`);
      }
    }
  } catch (error) {
    outputChannel.appendLine(`   ❌ Error listing models: ${error}`);
  }

  // Try to select gpt-4o-mini specifically
  outputChannel.appendLine('');
  outputChannel.appendLine('3. Checking for GPT-4o-mini model...');
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
    if (models.length === 0) {
      outputChannel.appendLine('   ❌ GPT-4o-mini not available');
    } else {
      outputChannel.appendLine(`   ✓ GPT-4o-mini available: ${models[0].id}`);
    }
  } catch (error) {
    outputChannel.appendLine(`   ❌ Error: ${error}`);
  }

  // Try a simple request
  outputChannel.appendLine('');
  outputChannel.appendLine('4. Testing a simple LLM request...');
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
      outputChannel.appendLine('   ⚠️ Skipping - no models available');
    } else {
      const model = models[0];
      outputChannel.appendLine(`   Using model: ${model.id}`);
      
      const messages = [
        vscode.LanguageModelChatMessage.User('Reply with exactly: "LLM test successful"')
      ];
      
      const response = await model.sendRequest(
        messages, 
        {}, 
        new vscode.CancellationTokenSource().token
      );
      
      let responseText = '';
      for await (const chunk of response.text) {
        responseText += chunk;
      }
      
      outputChannel.appendLine(`   ✓ Response received: "${responseText.substring(0, 100)}..."`);
    }
  } catch (error) {
    outputChannel.appendLine(`   ❌ Request failed: ${error}`);
    if (error instanceof vscode.LanguageModelError) {
      outputChannel.appendLine(`      Error code: ${error.code}`);
      outputChannel.appendLine(`      Error cause: ${error.cause}`);
    }
  }

  outputChannel.appendLine('');
  outputChannel.appendLine('='.repeat(60));
  outputChannel.appendLine('Test complete');
  outputChannel.appendLine('='.repeat(60));
}
