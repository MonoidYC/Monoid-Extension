import * as vscode from 'vscode';
import { LocalNode } from '../types';

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message: string;
    code: number;
  };
}

interface SnippetAndSummary {
  snippet: string;
  summary: string;
}

/**
 * Generate intelligent snippets and summaries for code nodes using Google Gemini
 */
export class GeminiSummarizer {
  private outputChannel: vscode.OutputChannel;
  private apiKey: string | undefined;
  private model: string = 'gemini-3-flash-preview';

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Monoid Gemini');
  }

  private getApiKey(): string | undefined {
    if (this.apiKey) {
      return this.apiKey;
    }
    
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    this.apiKey = config.get<string>('geminiApiKey');
    this.model = config.get<string>('geminiModel') || 'gemini-3-flash-preview';
    return this.apiKey;
  }

  private getApiUrl(): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  /**
   * Generate intelligent snippets AND summaries for a batch of nodes
   * Uses Gemini to extract the most important code, not just first N lines
   */
  async generateSnippetsAndSummaries(
    nodes: LocalNode[],
    workspaceFolder: vscode.WorkspaceFolder,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<Map<string, SnippetAndSummary>> {
    const results = new Map<string, SnippetAndSummary>();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      this.outputChannel.appendLine('[Gemini] No API key configured - skipping intelligent snippets');
      this.outputChannel.appendLine('[Gemini] Set monoid-visualize.geminiApiKey in settings');
      return results;
    }

    this.outputChannel.appendLine(`[Gemini] Generating intelligent snippets & summaries for ${nodes.length} nodes...`);

    // Process nodes in batches to avoid rate limits
    const batchSize = 5;
    const batches = this.chunkArray(nodes, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const progressMsg = `Extracting snippets & summaries (${i * batchSize + 1}-${Math.min((i + 1) * batchSize, nodes.length)}/${nodes.length})...`;
      
      if (progress) {
        progress.report({ message: progressMsg });
      }
      this.outputChannel.appendLine(`[Gemini] ${progressMsg}`);

      // Process batch in parallel
      const batchPromises = batch.map(node => this.extractSnippetAndSummary(node, workspaceFolder, apiKey));
      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach((result, index) => {
        const node = batch[index];
        if (result.status === 'fulfilled' && result.value) {
          results.set(node.stable_id, result.value);
        } else if (result.status === 'rejected') {
          this.outputChannel.appendLine(`[Gemini] Failed for ${node.name}: ${result.reason}`);
        }
      });

      // Small delay between batches to respect rate limits
      if (i < batches.length - 1) {
        await this.sleep(200);
      }
    }

    this.outputChannel.appendLine(`[Gemini] Generated ${results.size}/${nodes.length} snippets & summaries`);
    return results;
  }

  /**
   * Extract intelligent snippet and generate summary in one call
   */
  private async extractSnippetAndSummary(
    node: LocalNode, 
    workspaceFolder: vscode.WorkspaceFolder,
    apiKey: string
  ): Promise<SnippetAndSummary | null> {
    try {
      // Read the full source code for this node
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, node.file_path);
      const document = await vscode.workspace.openTextDocument(fileUri);
      const lines = document.getText().split('\n');
      const fullCode = lines.slice(node.start_line - 1, node.end_line).join('\n');

      // If code is small enough, no need for intelligent extraction
      if (fullCode.length < 800) {
        return this.generateSummaryOnly(node, fullCode, apiKey);
      }

      const prompt = this.buildSnippetExtractionPrompt(node, fullCode);

      const response = await fetch(`${this.getApiUrl()}?key=${apiKey}`, {
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
            temperature: 0.2,
            maxOutputTokens: 1500,
            topP: 0.8,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json() as GeminiResponse;

      if (data.error) {
        throw new Error(data.error.message);
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        return this.parseSnippetAndSummary(text, fullCode);
      }

      return null;
    } catch (error: any) {
      this.outputChannel.appendLine(`[Gemini] Error for ${node.name}: ${error.message}`);
      return null;
    }
  }

  /**
   * For small code blocks, just generate a summary (no need to extract snippet)
   */
  private async generateSummaryOnly(
    node: LocalNode, 
    fullCode: string,
    apiKey: string
  ): Promise<SnippetAndSummary | null> {
    const typeDescription = this.getTypeDescription(node.node_type);
    
    const prompt = `Generate a brief summary (1-2 sentences) for this ${typeDescription}.

${typeDescription}: ${node.name}
File: ${node.file_path}

Code:
\`\`\`
${fullCode}
\`\`\`

Write ONLY the summary, no markdown or explanations.`;

    try {
      const response = await fetch(`${this.getApiUrl()}?key=${apiKey}`, {
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
            temperature: 0.3,
            maxOutputTokens: 300,
            topP: 0.8,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as GeminiResponse;
      const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (summary) {
        return {
          snippet: fullCode,
          summary: summary.replace(/^["']|["']$/g, '')
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Build prompt for extracting important code snippet AND summary
   */
  private buildSnippetExtractionPrompt(node: LocalNode, fullCode: string): string {
    const typeDescription = this.getTypeDescription(node.node_type);
    
    return `Analyze this ${typeDescription} and extract the MOST IMPORTANT code that captures its core functionality.

${typeDescription}: ${node.name}
File: ${node.file_path}
${node.signature ? `Signature: ${node.signature}` : ''}

Full Code:
\`\`\`
${fullCode.substring(0, 6000)}
\`\`\`

TASK: Extract a focused code snippet (15-40 lines max) that shows:
- The main logic/purpose of this ${typeDescription}
- Key function calls, state management, or data transformations
- Important patterns (hooks used, API calls, rendering logic)

Skip boilerplate like imports, type definitions, simple variable declarations.

Respond in this EXACT format:
SNIPPET:
\`\`\`
[extracted code here]
\`\`\`

SUMMARY:
[1-2 sentence description of what this ${typeDescription} does]`;
  }

  /**
   * Parse the snippet and summary from Gemini's response
   */
  private parseSnippetAndSummary(response: string, fallbackCode: string): SnippetAndSummary {
    // Extract snippet between code fences
    const snippetMatch = response.match(/SNIPPET:\s*```[\w]*\n([\s\S]*?)```/);
    const snippet = snippetMatch ? snippetMatch[1].trim() : fallbackCode.substring(0, 1500);

    // Extract summary after SUMMARY:
    const summaryMatch = response.match(/SUMMARY:\s*([\s\S]*?)$/);
    const summary = summaryMatch 
      ? summaryMatch[1].trim().replace(/^["']|["']$/g, '')
      : 'No summary available';

    return { snippet, summary };
  }

  /**
   * Legacy method: Generate summaries only (for backwards compatibility)
   */
  async generateSummaries(
    nodes: LocalNode[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<Map<string, string>> {
    const summaries = new Map<string, string>();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      this.outputChannel.appendLine('[Gemini] No API key configured - skipping summaries');
      return summaries;
    }

    this.outputChannel.appendLine(`[Gemini] Generating summaries for ${nodes.length} nodes...`);

    const batchSize = 5;
    const batches = this.chunkArray(nodes, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const progressMsg = `Generating summaries (${i * batchSize + 1}-${Math.min((i + 1) * batchSize, nodes.length)}/${nodes.length})...`;
      
      if (progress) {
        progress.report({ message: progressMsg });
      }

      const batchPromises = batch.map(node => this.generateSummaryFromSnippet(node, apiKey));
      const results = await Promise.allSettled(batchPromises);

      results.forEach((result, index) => {
        const node = batch[index];
        if (result.status === 'fulfilled' && result.value) {
          summaries.set(node.stable_id, result.value);
        }
      });

      if (i < batches.length - 1) {
        await this.sleep(200);
      }
    }

    return summaries;
  }

  /**
   * Generate summary from existing snippet
   */
  private async generateSummaryFromSnippet(node: LocalNode, apiKey: string): Promise<string | null> {
    if (!node.snippet) {
      return null;
    }

    const typeDescription = this.getTypeDescription(node.node_type);
    const prompt = `Generate a brief summary (1-2 sentences) for this ${typeDescription}.

${typeDescription}: ${node.name}
File: ${node.file_path}

Code:
\`\`\`
${node.snippet.substring(0, 2000)}
\`\`\`

Write ONLY the summary, no markdown.`;

    try {
      const response = await fetch(`${this.getApiUrl()}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ]
        })
      });

      const data = await response.json() as GeminiResponse;
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get a human-readable description of the node type
   */
  private getTypeDescription(nodeType: string): string {
    const descriptions: Record<string, string> = {
      'function': 'function',
      'class': 'class',
      'method': 'method',
      'endpoint': 'API endpoint',
      'handler': 'request handler',
      'middleware': 'middleware',
      'hook': 'React hook',
      'component': 'React component',
      'module': 'module',
      'variable': 'variable',
      'type': 'type definition',
      'interface': 'interface',
      'constant': 'constant',
      'test': 'test',
      'other': 'code element'
    };
    return descriptions[nodeType] || 'code element';
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let summarizer: GeminiSummarizer | null = null;

export function getGeminiSummarizer(): GeminiSummarizer {
  if (!summarizer) {
    summarizer = new GeminiSummarizer();
  }
  return summarizer;
}
