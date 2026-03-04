import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import type {
  LocalNode,
  LocalEdge,
  AnalysisResult,
  GitHubInfo,
  AnalyzerOptions,
  NodeType,
  EdgeType,
} from './types';

export type {
  LocalNode,
  LocalEdge,
  AnalysisResult,
  GitHubInfo,
  AnalyzerOptions,
  NodeType,
  EdgeType,
} from './types';

/**
 * Analyze a directory on disk and extract code nodes + edges.
 *
 * This is the vscode-free entry point used by both the extension (via a thin wrapper)
 * and the background worker service.
 */
export async function analyzeDirectory(
  rootPath: string,
  githubInfo?: GitHubInfo,
  options?: AnalyzerOptions
): Promise<AnalysisResult> {
  const analyzer = new CoreAnalyzer(rootPath, githubInfo, options);
  return analyzer.analyze();
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

class CoreAnalyzer {
  private nodes: Map<string, LocalNode> = new Map();
  private edges: LocalEdge[] = [];
  private rootPath: string;
  private githubInfo?: GitHubInfo;
  private logger: (msg: string) => void;
  private onProgress?: (msg: string, pct: number) => void;

  private stats = {
    filesAnalyzed: 0,
    componentsFound: 0,
    vueComponentsFound: 0,
    hooksFound: 0,
    endpointsFound: 0,
    classesFound: 0,
    exportedFunctionsFound: 0,
    skippedFunctions: 0,
  };

  constructor(rootPath: string, githubInfo?: GitHubInfo, options?: AnalyzerOptions) {
    this.rootPath = rootPath;
    this.githubInfo = githubInfo;
    this.logger = options?.logger ?? ((msg: string) => console.log(`[analyzer-core] ${msg}`));
    this.onProgress = options?.onProgress;
  }

  async analyze(): Promise<AnalysisResult> {
    this.nodes.clear();
    this.edges = [];
    this.stats = {
      filesAnalyzed: 0,
      componentsFound: 0,
      vueComponentsFound: 0,
      hooksFound: 0,
      endpointsFound: 0,
      classesFound: 0,
      exportedFunctionsFound: 0,
      skippedFunctions: 0,
    };

    this.log('='.repeat(60));
    this.log('Starting code analysis...');
    this.log(`Root: ${this.rootPath}`);
    if (this.githubInfo) {
      this.log(`GitHub: ${this.githubInfo.owner}/${this.githubInfo.repo} (${this.githubInfo.branch})`);
    }
    this.log('='.repeat(60));

    // Find all relevant files
    const files = await fg(
      ['**/*.{ts,tsx,js,jsx,vue}'],
      {
        cwd: this.rootPath,
        ignore: [
          '**/node_modules/**',
          '**/dist/**',
          '**/build/**',
          '**/.next/**',
          '**/coverage/**',
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**',
        ],
        absolute: false,
        dot: false,
      }
    );

    const totalFiles = files.length;
    this.log(`Found ${totalFiles} source files to analyze`);

    for (const relativePath of files) {
      try {
        this.analyzeFile(relativePath);
        this.stats.filesAnalyzed++;

        if (this.onProgress) {
          const pct = (this.stats.filesAnalyzed / totalFiles) * 100;
          this.onProgress(
            `Analyzing ${path.basename(relativePath)} (${this.stats.filesAnalyzed}/${totalFiles})`,
            pct
          );
        }
      } catch (error) {
        this.log(`ERROR analyzing ${relativePath}: ${error}`);
      }
    }

    // Phase 2: Analyze edges
    this.log('');
    this.log('='.repeat(60));
    this.log('Phase 2: Analyzing relationships between nodes...');
    this.log('='.repeat(60));
    this.analyzeEdges();

    // Log summary
    this.log('');
    this.log('='.repeat(60));
    this.log('Analysis Complete!');
    this.log('='.repeat(60));
    this.log(`Files analyzed: ${this.stats.filesAnalyzed}`);
    this.log(`Components found: ${this.stats.componentsFound}`);
    this.log(`Vue components found: ${this.stats.vueComponentsFound}`);
    this.log(`Hooks found: ${this.stats.hooksFound}`);
    this.log(`API endpoints found: ${this.stats.endpointsFound}`);
    this.log(`Classes found: ${this.stats.classesFound}`);
    this.log(`Exported functions found: ${this.stats.exportedFunctionsFound}`);
    this.log(`Skipped (internal functions): ${this.stats.skippedFunctions}`);
    this.log(`Total nodes: ${this.nodes.size}`);
    this.log(`Total edges: ${this.edges.length}`);
    this.log('='.repeat(60));

    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
    };
  }

  // ----------- File reading helpers -----------

  private readFile(relativePath: string): string {
    const fullPath = path.join(this.rootPath, relativePath);
    return fs.readFileSync(fullPath, 'utf-8');
  }

  private log(message: string): void {
    this.logger(message);
  }

  // ----------- GitHub link generation -----------

  private generateGitHubLink(filePath: string, startLine: number, endLine: number): string | undefined {
    if (!this.githubInfo) return undefined;
    const { owner, repo, branch } = this.githubInfo;
    const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
    return `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}#${lineRange}`;
  }

  // ----------- Main file analysis -----------

  private analyzeFile(relativePath: string): void {
    const text = this.readFile(relativePath);
    const lines = text.split('\n');
    const isVueFile = /\.vue$/.test(relativePath);
    const isReactFile =
      /\.(tsx|jsx)$/.test(relativePath) ||
      text.includes('import React') ||
      text.includes("from 'react'") ||
      text.includes('from "react"') ||
      text.includes("'use client'") ||
      text.includes('"use client"') ||
      /<[A-Z]\w*[\s/>]/.test(text) ||
      (/<[a-z]+[^>]*>/.test(text));

    const exportedNames = this.getExportedNames(text);
    const imports = this.extractImports(text, relativePath);

    if (isVueFile) {
      this.extractVueComponents(text, lines, relativePath);
    }

    if (!isVueFile) {
      this.extractComponents(text, lines, relativePath, exportedNames, imports);
    }

    this.extractHooks(text, lines, relativePath, exportedNames, isVueFile);
    this.extractEndpoints(text, lines, relativePath);
    this.extractClasses(text, lines, relativePath, exportedNames);
    this.extractExportedFunctions(text, lines, relativePath, exportedNames);
  }

  // ----------- Edge analysis -----------

  private analyzeEdges(): void {
    const nodes = Array.from(this.nodes.values());
    const nodeNames = new Set(nodes.map((n) => n.name));
    const nodeByName = new Map(nodes.map((n) => [n.name, n]));

    this.log(`Analyzing relationships for ${nodes.length} nodes...`);
    this.edges = [];

    for (const node of nodes) {
      try {
        const fileContent = this.readFile(node.file_path);
        const imports = this.getImportedNames(fileContent);
        const lines = fileContent.split('\n');
        const nodeCode =
          node.language === 'vue'
            ? fileContent
            : lines.slice(node.start_line - 1, node.end_line).join('\n');

        const usedNodes = this.findUsedNodes(nodeCode, nodeNames, node.name, imports);

        if (usedNodes.length > 0) {
          this.log(`${node.name} (${node.node_type}) uses:`);
          for (const usedName of usedNodes) {
            const targetNode = nodeByName.get(usedName);
            if (targetNode) {
              const edgeType = this.determineEdgeType(node, targetNode);
              this.log(`  → ${usedName} (${targetNode.node_type}) [${edgeType}]`);
              this.edges.push({
                source_stable_id: node.stable_id,
                target_stable_id: targetNode.stable_id,
                edge_type: edgeType,
                metadata: {},
              });
            }
          }
        }
      } catch (error) {
        this.log(`Error analyzing edges for ${node.name}: ${error}`);
      }
    }

    this.log('');
    this.log(`Total edges found: ${this.edges.length}`);
  }

  // ----------- Import / usage helpers -----------

  private getImportedNames(fileContent: string): Set<string> {
    const imports = new Set<string>();
    const defaultImportPattern = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
    let match;
    while ((match = defaultImportPattern.exec(fileContent)) !== null) {
      imports.add(match[1]);
    }
    const namedImportPattern = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
    while ((match = namedImportPattern.exec(fileContent)) !== null) {
      match[1].split(',').forEach((name) => {
        const parts = name.trim().split(/\s+as\s+/);
        const localName = parts[parts.length - 1].trim();
        if (localName) imports.add(localName);
      });
    }
    return imports;
  }

  private findUsedNodes(
    nodeCode: string,
    knownNodes: Set<string>,
    selfName: string,
    imports: Set<string>
  ): string[] {
    const used: string[] = [];
    for (const nodeName of knownNodes) {
      if (nodeName === selfName) continue;
      if (!imports.has(nodeName)) continue;

      const kebabName = nodeName
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();
      const usagePatterns = [
        new RegExp(`<${nodeName}[\\s/>]`),
        ...(kebabName !== nodeName ? [new RegExp(`<${kebabName}[\\s/>]`)] : []),
        new RegExp(`\\b${nodeName}\\s*\\(`),
        new RegExp(`<${nodeName}\\s*/>`),
      ];

      for (const pattern of usagePatterns) {
        if (pattern.test(nodeCode)) {
          used.push(nodeName);
          break;
        }
      }
    }
    return used;
  }

  private determineEdgeType(source: LocalNode, target: LocalNode): EdgeType {
    if (source.node_type === 'component' && target.node_type === 'component') return 'uses';
    if (target.node_type === 'hook') return 'uses';
    if (source.node_type === 'class' && target.node_type === 'class') return 'extends';
    if (target.node_type === 'endpoint') return 'calls';
    return 'uses';
  }

  // ----------- Extraction helpers -----------

  private getExportedNames(text: string): Set<string> {
    const exported = new Set<string>();
    const directExportPattern =
      /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
    let match;
    while ((match = directExportPattern.exec(text)) !== null) {
      exported.add(match[1]);
    }
    const namedExportPattern = /export\s*\{([^}]+)\}/g;
    while ((match = namedExportPattern.exec(text)) !== null) {
      match[1].split(',').forEach((name) => {
        const cleanName = name.trim().split(/\s+as\s+/)[0].trim();
        if (cleanName) exported.add(cleanName);
      });
    }
    const defaultExportPattern = /export\s+default\s+(\w+)/g;
    while ((match = defaultExportPattern.exec(text)) !== null) {
      if (!['function', 'class', 'async'].includes(match[1])) exported.add(match[1]);
    }
    return exported;
  }

  private extractImports(text: string, _filePath: string): Map<string, string> {
    const imports = new Map<string, string>();
    const importPattern =
      /import\s+(?:(?:\{([^}]+)\})|(\w+))?\s*(?:,\s*(?:\{([^}]+)\}|(\w+)))?\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importPattern.exec(text)) !== null) {
      const namedImports1 = match[1];
      const defaultImport1 = match[2];
      const namedImports2 = match[3];
      const defaultImport2 = match[4];
      const sourcePath = match[5];

      if (
        !sourcePath.startsWith('.') &&
        !sourcePath.startsWith('@/') &&
        !sourcePath.startsWith('~/')
      ) {
        continue;
      }

      [namedImports1, namedImports2].forEach((namedImports) => {
        if (namedImports) {
          namedImports.split(',').forEach((imp) => {
            const name = imp.trim().split(/\s+as\s+/).pop()?.trim();
            if (name) imports.set(name, sourcePath);
          });
        }
      });
      [defaultImport1, defaultImport2].forEach((defaultImport) => {
        if (defaultImport) imports.set(defaultImport, sourcePath);
      });
    }
    return imports;
  }

  // ----------- Vue components -----------

  private extractVueComponents(text: string, lines: string[], filePath: string): void {
    const baseName = path.basename(filePath, '.vue');
    const nameFromFile = baseName
      .split(/[-_\s]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');

    let componentName = nameFromFile;
    let startLine = 1;
    let endLine = lines.length;

    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let scriptMatch: RegExpExecArray | null;
    const scriptBlocks: string[] = [];
    while ((scriptMatch = scriptRegex.exec(text)) !== null) {
      scriptBlocks.push(scriptMatch[1]);
    }
    if (scriptBlocks.length > 0) {
      const firstScriptStart = text.indexOf('<script');
      const firstScriptEnd = text.indexOf('</script>') + '</script>'.length;
      startLine = text.substring(0, firstScriptStart).split('\n').length;
      endLine = text.substring(0, firstScriptEnd).split('\n').length;

      for (const scriptContent of scriptBlocks) {
        const defineOptionsMatch = scriptContent.match(
          /defineOptions\s*\(\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/
        );
        if (defineOptionsMatch) {
          componentName = defineOptionsMatch[1];
          break;
        }
        const exportDefaultNameMatch = scriptContent.match(
          /export\s+default\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/s
        );
        if (exportDefaultNameMatch) {
          componentName = exportDefaultNameMatch[1];
          break;
        }
        const defineComponentObj = scriptContent.match(
          /defineComponent\s*\(\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/
        );
        const defineComponentStr = scriptContent.match(
          /defineComponent\s*\(\s*['"]([^'"]+)['"]/
        );
        if (defineComponentObj) {
          componentName = defineComponentObj[1];
          break;
        }
        if (defineComponentStr) {
          componentName = defineComponentStr[1];
          break;
        }
      }
    }

    this.log(`  Vue component: ${componentName} @ ${filePath}:${startLine}`);
    this.stats.vueComponentsFound++;

    this.addNode({
      stable_id: `${filePath}::${componentName}`,
      name: componentName,
      qualified_name: `${filePath}::${componentName}`,
      node_type: 'component',
      language: 'vue',
      file_path: filePath,
      start_line: startLine,
      end_line: endLine,
      snippet: lines.slice(startLine - 1, Math.min(startLine + 29, endLine)).join('\n'),
      signature: `<script> ... </script>`,
      metadata: { framework: 'vue' },
    });
  }

  // ----------- React components -----------

  private extractComponents(
    text: string,
    lines: string[],
    filePath: string,
    exportedNames: Set<string>,
    imports: Map<string, string>
  ): void {
    const patterns = [
      /(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*)\s*\([^)]*\)/g,
      /(?:export\s+)?(?:default\s+)?const\s+([A-Z]\w*)\s*(?::\s*(?:React\.)?(?:FC|FunctionComponent|Component)[^=]*)?\s*=\s*(?:\([^)]*\)|[a-z]\w*)\s*=>/g,
      /(?:export\s+)?const\s+([A-Z]\w*)\s*=\s*function/g,
      /(?:export\s+)?(?:default\s+)?const\s+([A-Z]\w*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/g,
    ];

    if (imports.size > 0) {
      const componentImports = Array.from(imports.entries()).filter(
        ([name]) => /^[A-Z]/.test(name) || name.startsWith('use')
      );
      if (componentImports.length > 0) {
        this.log(
          `  Imports: ${componentImports.map(([n, p]) => `${n} from ${p}`).join(', ')}`
        );
      }
    }

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);
        const functionBody = lines.slice(startLine - 1, endLine).join('\n');

        if (!this.containsJSX(functionBody)) {
          this.stats.skippedFunctions++;
          continue;
        }

        const isExported = exportedNames.has(name);
        this.log(
          `  Component: ${name}${isExported ? ' (exported)' : ''} @ ${filePath}:${startLine}`
        );
        this.stats.componentsFound++;

        this.addNode({
          stable_id: `${filePath}::${name}`,
          name,
          qualified_name: `${filePath}::${name}`,
          node_type: 'component',
          language: 'typescript',
          file_path: filePath,
          start_line: startLine,
          end_line: endLine,
          snippet: lines.slice(startLine - 1, Math.min(startLine + 29, endLine)).join('\n'),
          signature: match[0].trim(),
          metadata: { exported: isExported },
        });
      }
    }
  }

  // ----------- Hooks / Composables -----------

  private extractHooks(
    text: string,
    lines: string[],
    filePath: string,
    exportedNames: Set<string>,
    isVueFile = false
  ): void {
    const patterns = [
      /(?:export\s+)?(?:default\s+)?function\s+(use[A-Z]\w*)\s*\(/g,
      /(?:export\s+)?(?:default\s+)?const\s+(use[A-Z]\w*)\s*=\s*(?:\([^)]*\)|[a-z]\w*)\s*=>/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        const isExported = exportedNames.has(name);
        if (!isExported && !isVueFile) {
          this.stats.skippedFunctions++;
          continue;
        }

        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);

        this.log(`  Hook: ${name} @ ${filePath}:${startLine}`);
        this.stats.hooksFound++;

        this.addNode({
          stable_id: `${filePath}::${name}`,
          name,
          qualified_name: `${filePath}::${name}`,
          node_type: 'hook',
          language: 'typescript',
          file_path: filePath,
          start_line: startLine,
          end_line: endLine,
          snippet: lines.slice(startLine - 1, Math.min(startLine + 29, endLine)).join('\n'),
          signature: match[0].trim(),
          metadata: { exported: isExported },
        });
      }
    }
  }

  // ----------- API Endpoints -----------

  private extractEndpoints(text: string, lines: string[], filePath: string): void {
    const routePatterns = [
      /(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const method = match[1].toUpperCase();
        const route =
          match[2] || filePath.replace(/.*\/api/, '/api').replace(/\.\w+$/, '');
        const name = `${method} ${route}`;
        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);

        this.log(`  Endpoint: ${name} @ ${filePath}:${startLine}`);
        this.stats.endpointsFound++;

        this.addNode({
          stable_id: `${filePath}::${name}`,
          name,
          qualified_name: `${filePath}::${name}`,
          node_type: 'endpoint',
          language: 'typescript',
          file_path: filePath,
          start_line: startLine,
          end_line: endLine,
          snippet: lines.slice(startLine - 1, Math.min(startLine + 29, endLine)).join('\n'),
          signature: match[0].trim(),
          metadata: { method, route },
        });
      }
    }
  }

  // ----------- Classes -----------

  private extractClasses(
    text: string,
    lines: string[],
    filePath: string,
    exportedNames: Set<string>
  ): void {
    const classPattern =
      /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
    let match;
    while ((match = classPattern.exec(text)) !== null) {
      const name = match[1];
      const extendsClass = match[2];
      const isExported = exportedNames.has(name);
      if (!isExported) {
        this.stats.skippedFunctions++;
        continue;
      }

      const startLine = text.substring(0, match.index).split('\n').length;
      const endLine = this.findBlockEnd(lines, startLine - 1);

      this.log(
        `  Class: ${name}${extendsClass ? ` extends ${extendsClass}` : ''} @ ${filePath}:${startLine}`
      );
      this.stats.classesFound++;

      this.addNode({
        stable_id: `${filePath}::${name}`,
        name,
        qualified_name: `${filePath}::${name}`,
        node_type: 'class',
        language: 'typescript',
        file_path: filePath,
        start_line: startLine,
        end_line: endLine,
        snippet: lines.slice(startLine - 1, Math.min(startLine + 29, endLine)).join('\n'),
        signature: match[0].trim(),
        metadata: { extends: extendsClass, exported: isExported },
      });

      if (extendsClass) {
        this.edges.push({
          source_stable_id: `${filePath}::${name}`,
          target_stable_id: extendsClass,
          edge_type: 'extends',
        });
      }
    }
  }

  // ----------- Exported functions -----------

  private extractExportedFunctions(
    text: string,
    lines: string[],
    filePath: string,
    exportedNames: Set<string>
  ): void {
    const patterns = [
      /export\s+(?:async\s+)?function\s+([a-z]\w*)\s*\(/g,
      /export\s+const\s+([a-z]\w*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        if (name.startsWith('use')) continue;
        if (
          ['get', 'set', 'is', 'has', 'can', 'should', 'will', 'did'].some(
            (p) => name.startsWith(p) && name.length < 8
          )
        ) {
          this.stats.skippedFunctions++;
          continue;
        }

        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);
        const functionBody = lines.slice(startLine - 1, endLine).join('\n');
        if (this.containsJSX(functionBody)) continue;

        this.log(`  Function: ${name} @ ${filePath}:${startLine}`);
        this.stats.exportedFunctionsFound++;

        this.addNode({
          stable_id: `${filePath}::${name}`,
          name,
          qualified_name: `${filePath}::${name}`,
          node_type: 'function',
          language: 'typescript',
          file_path: filePath,
          start_line: startLine,
          end_line: endLine,
          snippet: lines.slice(startLine - 1, Math.min(startLine + 29, endLine)).join('\n'),
          signature: match[0].trim(),
          metadata: { exported: true },
        });
      }
    }
  }

  // ----------- Utility methods -----------

  private containsJSX(text: string): boolean {
    return (
      /<[A-Z]\w*[\s/>]/.test(text) ||
      (/<[a-z]+[\s/>]/.test(text) && /<\/[a-z]+>/.test(text))
    );
  }

  private findBlockEnd(lines: string[], startLineIndex: number): number {
    let parenCount = 0;
    let foundOpenParen = false;
    let foundCloseParen = false;
    let braceCount = 0;
    let foundBodyStart = false;

    for (let i = startLineIndex; i < lines.length; i++) {
      const line = lines[i];
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (!foundCloseParen) {
          if (char === '(') {
            parenCount++;
            foundOpenParen = true;
          } else if (char === ')') {
            parenCount--;
            if (foundOpenParen && parenCount === 0) {
              foundCloseParen = true;
            }
          }
          continue;
        }
        if (char === '{') {
          braceCount++;
          foundBodyStart = true;
        } else if (char === '}') {
          braceCount--;
          if (foundBodyStart && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }
    return Math.min(startLineIndex + 50, lines.length);
  }

  private addNode(node: LocalNode): void {
    if (!this.nodes.has(node.stable_id)) {
      if (!node.github_link && this.githubInfo) {
        node.github_link = this.generateGitHubLink(
          node.file_path,
          node.start_line,
          node.end_line
        );
      }
      this.nodes.set(node.stable_id, node);
    }
  }
}
