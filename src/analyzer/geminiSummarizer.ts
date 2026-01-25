import * as vscode from 'vscode';
import { LocalNode } from '../types';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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

/**
 * Generate summaries for code nodes using Google Gemini
 */
export class GeminiSummarizer {
  private outputChannel: vscode.OutputChannel;
  private apiKey: string | undefined;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Monoid Gemini');
  }

  private getApiKey(): string | undefined {
    if (this.apiKey) {
      return this.apiKey;
    }
    
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    this.apiKey = config.get<string>('geminiApiKey');
    return this.apiKey;
  }

  /**
   * Generate summaries for a batch of nodes
   */
  async generateSummaries(
    nodes: LocalNode[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<Map<string, string>> {
    const summaries = new Map<string, string>();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      this.outputChannel.appendLine('[Gemini] No API key configured - skipping summaries');
      this.outputChannel.appendLine('[Gemini] Set monoid-visualize.geminiApiKey in settings');
      return summaries;
    }

    this.outputChannel.appendLine(`[Gemini] Generating summaries for ${nodes.length} nodes...`);

    // Process nodes in batches to avoid rate limits
    const batchSize = 5;
    const batches = this.chunkArray(nodes, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const progressMsg = `Generating summaries (${i * batchSize + 1}-${Math.min((i + 1) * batchSize, nodes.length)}/${nodes.length})...`;
      
      if (progress) {
        progress.report({ message: progressMsg });
      }
      this.outputChannel.appendLine(`[Gemini] ${progressMsg}`);

      // Process batch in parallel
      const batchPromises = batch.map(node => this.generateSummary(node, apiKey));
      const results = await Promise.allSettled(batchPromises);

      results.forEach((result, index) => {
        const node = batch[index];
        if (result.status === 'fulfilled' && result.value) {
          summaries.set(node.stable_id, result.value);
        } else if (result.status === 'rejected') {
          this.outputChannel.appendLine(`[Gemini] Failed to summarize ${node.name}: ${result.reason}`);
        }
      });

      // Small delay between batches to respect rate limits
      if (i < batches.length - 1) {
        await this.sleep(200);
      }
    }

    this.outputChannel.appendLine(`[Gemini] Generated ${summaries.size}/${nodes.length} summaries`);
    return summaries;
  }

  /**
   * Generate a summary for a single node
   */
  private async generateSummary(node: LocalNode, apiKey: string): Promise<string | null> {
    if (!node.snippet) {
      return null;
    }

    const prompt = this.buildPrompt(node);

    try {
      const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
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
            maxOutputTokens: 150,
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
        // Clean up the summary (remove quotes, trim)
        return text.trim().replace(/^["']|["']$/g, '');
      }

      return null;
    } catch (error: any) {
      this.outputChannel.appendLine(`[Gemini] Error for ${node.name}: ${error.message}`);
      return null;
    }
  }

  /**
   * Build the prompt for summarizing a code node
   */
  private buildPrompt(node: LocalNode): string {
    const typeDescription = this.getTypeDescription(node.node_type);
    const snippet = node.snippet?.substring(0, 2000) || ''; // Limit snippet size

    return `You are a code documentation assistant. Generate a brief, clear summary (1-2 sentences max) describing what this ${typeDescription} does.

${typeDescription}: ${node.name}
File: ${node.file_path}
${node.signature ? `Signature: ${node.signature}` : ''}

Code:
\`\`\`
${snippet}
\`\`\`

Write ONLY the summary, no explanations or markdown. Be concise and focus on the purpose and main functionality.`;
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
