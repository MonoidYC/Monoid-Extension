import * as vscode from 'vscode';
import { analyzeDirectory } from '@monoid/analyzer-core';
import { LLMAnalyzer } from './llmAnalyzer';
import type { AnalysisResult, GitHubInfo } from '../types';

/**
 * Code Analyzer - Thin VS Code wrapper around @monoid/analyzer-core
 *
 * Adapts vscode.WorkspaceFolder + progress APIs to the
 * platform-agnostic analyzeDirectory() function.
 */
export class CodeAnalyzer {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Monoid Visualize');
  }

  async analyzeWorkspace(
    workspaceFolder: vscode.WorkspaceFolder,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    githubInfo?: GitHubInfo,
    options?: { enableLlm?: boolean }
  ): Promise<AnalysisResult> {
    const enableLlm = options?.enableLlm ?? false;
    const rootPath = workspaceFolder.uri.fsPath;

    // Run the core analyzer (no vscode dependency)
    const result = await analyzeDirectory(rootPath, githubInfo, {
      logger: (msg: string) => {
        this.outputChannel.appendLine(msg);
        console.log(`[Monoid] ${msg}`);
      },
      onProgress: (msg: string, pct: number) => {
        if (progress) {
          progress.report({ message: msg, increment: pct > 0 ? pct / 100 : undefined });
        }
      },
    });

    // Phase 3: Optional LLM enrichment (still uses vscode APIs for config)
    if (enableLlm) {
      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const apiKey = config.get<string>('geminiApiKey');
      if (apiKey) {
        const llmAnalyzer = new LLMAnalyzer(this.outputChannel);
        const apiEdges = await llmAnalyzer.analyzeApiRelationships(
          result.nodes,
          workspaceFolder
        );
        result.edges.push(...apiEdges);
      } else {
        this.outputChannel.appendLine(
          'Phase 3: LLM enrichment enabled, but no geminiApiKey set - skipping'
        );
      }
    } else {
      this.outputChannel.appendLine('Phase 3: LLM enrichment disabled - skipping');
    }

    // Show the output channel
    this.outputChannel.show(true);

    return result;
  }
}
