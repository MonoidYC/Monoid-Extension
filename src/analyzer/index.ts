import * as vscode from 'vscode';
import * as path from 'path';
import { LocalNode, LocalEdge, AnalysisResult, NodeType, EdgeType, GitHubInfo } from '../types';
import { LLMAnalyzer } from './llmAnalyzer';

/**
 * Code Analyzer - Extracts meaningful nodes from a codebase
 *
 * What we consider a "node":
 * - React Components (PascalCase functions/consts that return JSX)
 * - Vue Components (Single File Components .vue, and defineComponent/export default in script)
 * - Custom Hooks / Vue Composables (functions starting with "use")
 * - API Endpoints (routes defined with express/fastify/etc, or fetch/axios calls)
 * - Classes (main class definitions, not individual methods)
 * - Exported Functions (public API of a module)
 *
 * What we DON'T extract:
 * - Internal/private helper functions
 * - Type definitions and interfaces (unless exported and significant)
 * - Individual class methods
 * - Utility functions
 * - Every file as a "module" node
 */

export class CodeAnalyzer {
  private nodes: Map<string, LocalNode> = new Map();
  private edges: LocalEdge[] = [];
  private progress?: vscode.Progress<{ message?: string; increment?: number }>;
  private outputChannel: vscode.OutputChannel;
  private githubInfo?: GitHubInfo;

  // Stats for debugging
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

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Monoid Visualize');
  }

  /**
   * Generate a GitHub permalink for a code location
   */
  private generateGitHubLink(filePath: string, startLine: number, endLine: number): string | undefined {
    if (!this.githubInfo) { return undefined; }
    
    const { owner, repo, branch } = this.githubInfo;
    const lineRange = startLine === endLine 
      ? `L${startLine}` 
      : `L${startLine}-L${endLine}`;
    
    return `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}#${lineRange}`;
  }

  async analyzeWorkspace(
    workspaceFolder: vscode.WorkspaceFolder,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    githubInfo?: GitHubInfo,
    options?: { enableLlm?: boolean }
  ): Promise<AnalysisResult> {
    this.nodes.clear();
    this.edges = [];
    this.progress = progress;
    this.githubInfo = githubInfo;
    const enableLlm = options?.enableLlm ?? false;
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
    this.log(`Workspace: ${workspaceFolder.name}`);
    if (githubInfo) {
      this.log(`GitHub: ${githubInfo.owner}/${githubInfo.repo} (${githubInfo.branch})`);
    }
    this.log('='.repeat(60));

    // Find all relevant files (exclude common non-source directories)
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx,js,jsx,vue}'),
      '{**/node_modules/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**,**/*.test.*,**/*.spec.*,**/__tests__/**}'
    );

    const totalFiles = files.length;
    this.log(`Found ${totalFiles} source files to analyze`);

    for (const file of files) {
      try {
        await this.analyzeFile(file, workspaceFolder);
        this.stats.filesAnalyzed++;
        
        if (this.progress) {
          const increment = (1 / totalFiles) * 100;
          this.progress.report({ 
            message: `Analyzing ${path.basename(file.fsPath)} (${this.stats.filesAnalyzed}/${totalFiles})`,
            increment 
          });
        }
      } catch (error) {
        this.log(`ERROR analyzing ${file.fsPath}: ${error}`);
      }
    }

    // Phase 2: Analyze edges using improved heuristics
    // This reads each node's file and finds references to other known nodes
    this.log('');
    this.log('='.repeat(60));
    this.log('Phase 2: Analyzing relationships between nodes...');
    this.log('='.repeat(60));
    
    await this.analyzeEdges(workspaceFolder);

    // Phase 3: Analyze frontend → backend relationships using LLM/heuristics (optional)
    if (enableLlm) {
      const config = vscode.workspace.getConfiguration('monoid-visualize');
      const apiKey = config.get<string>('geminiApiKey');
      if (apiKey) {
        const llmAnalyzer = new LLMAnalyzer(this.outputChannel);
        const apiEdges = await llmAnalyzer.analyzeApiRelationships(
          Array.from(this.nodes.values()),
          workspaceFolder
        );
        this.edges.push(...apiEdges);
      } else {
        this.log('Phase 3: LLM enrichment enabled, but no geminiApiKey set - skipping');
      }
    } else {
      this.log('Phase 3: LLM enrichment disabled - skipping');
    }

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

    // Show the output channel so user can see the analysis
    this.outputChannel.show(true);

    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges
    };
  }

  /**
   * Analyze edges by reading each node's source file and finding
   * references to other known nodes
   */
  private async analyzeEdges(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const nodes = Array.from(this.nodes.values());
    const nodeNames = new Set(nodes.map(n => n.name));
    const nodeByName = new Map(nodes.map(n => [n.name, n]));
    
    this.log(`Analyzing relationships for ${nodes.length} nodes...`);
    this.log(`Known node names: ${Array.from(nodeNames).join(', ')}`);
    this.log('');

    this.edges = []; // Clear any previous edges

    for (const node of nodes) {
      try {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, node.file_path);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const fileContent = document.getText();
        
        // Get the full file content (we need to check imports at file level)
        const imports = this.getImportedNames(fileContent);
        
        // Extract the node's code block (for Vue SFC use full file so template usage is found)
        const lines = fileContent.split('\n');
        const nodeCode =
          node.language === 'vue'
            ? fileContent
            : lines.slice(node.start_line - 1, node.end_line).join('\n');

        // Find which known nodes this node references
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
                metadata: {}
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

  private getImportedNames(fileContent: string): Set<string> {
    const imports = new Set<string>();
    
    // Match: import X from './path'
    const defaultImportPattern = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g;
    let match;
    while ((match = defaultImportPattern.exec(fileContent)) !== null) {
      imports.add(match[1]);
    }
    
    // Match: import { X, Y as Z } from './path'
    const namedImportPattern = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
    while ((match = namedImportPattern.exec(fileContent)) !== null) {
      match[1].split(',').forEach(name => {
        // Handle "X as Y" - we want the local name (Y)
        const parts = name.trim().split(/\s+as\s+/);
        const localName = parts[parts.length - 1].trim();
        if (localName) {
          imports.add(localName);
        }
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
      // Skip self-reference
      if (nodeName === selfName) { continue; }
      
      // Only consider nodes that are imported (to avoid false positives)
      if (!imports.has(nodeName)) { continue; }
      
      // Check various usage patterns
      const kebabName = nodeName
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();
      const usagePatterns = [
        // JSX / Vue PascalCase: <Component or <Component>
        new RegExp(`<${nodeName}[\\s/>]`),
        // Vue template kebab-case: <hello-world
        ...(kebabName !== nodeName ? [new RegExp(`<${kebabName}[\\s/>]`)] : []),
        // Function/hook call: useHook( or functionName(
        new RegExp(`\\b${nodeName}\\s*\\(`),
        // JSX self-closing: <Component />
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
    // Component using another component
    if (source.node_type === 'component' && target.node_type === 'component') {
      return 'uses';
    }
    // Component using a hook
    if (target.node_type === 'hook') {
      return 'uses';
    }
    // Class extending another class
    if (source.node_type === 'class' && target.node_type === 'class') {
      return 'extends';
    }
    // Calling an endpoint
    if (target.node_type === 'endpoint') {
      return 'calls';
    }
    // Default
    return 'uses';
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
    console.log(`[Monoid] ${message}`);
  }

  private async analyzeFile(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    const lines = text.split('\n');

    // Check if this is a Vue SFC
    const isVueFile = /\.vue$/.test(uri.fsPath);

    // Check if this is a React/component file
    // Include: .tsx, .jsx, files with React imports, 'use client', or JSX patterns
    const isReactFile = /\.(tsx|jsx)$/.test(uri.fsPath) ||
                        text.includes('import React') ||
                        text.includes("from 'react'") ||
                        text.includes('from "react"') ||
                        text.includes("'use client'") ||
                        text.includes('"use client"') ||
                        /<[A-Z]\w*[\s/>]/.test(text) ||  // JSX component usage
                        /<[a-z]+[^>]*>/.test(text);      // JSX HTML elements

    // Extract exports to know what's public (for .vue, getExportedNames works on full text; script is included)
    const exportedNames = this.getExportedNames(text);

    // Extract imports for edge detection
    const imports = this.extractImports(text, relativePath);

    // 1a. Extract Vue Components (Single File Components)
    if (isVueFile) {
      this.extractVueComponents(text, lines, relativePath);
    }

    // 1b. Extract React Components (always try for non-Vue - containsJSX will filter)
    if (!isVueFile) {
      this.extractComponents(text, lines, relativePath, exportedNames, imports);
    }

    // 2. Extract Custom Hooks / Vue Composables (useXxx in React and Vue)
    this.extractHooks(text, lines, relativePath, exportedNames, isVueFile);

    // 3. Extract API Endpoints (route handlers, fetch calls)
    this.extractEndpoints(text, lines, relativePath);

    // 4. Extract Classes
    this.extractClasses(text, lines, relativePath, exportedNames);

    // 5. Extract significant exported functions (not components/hooks)
    this.extractExportedFunctions(text, lines, relativePath, exportedNames);
  }

  private getExportedNames(text: string): Set<string> {
    const exported = new Set<string>();
    
    // export function Name
    // export const Name
    // export class Name
    const directExportPattern = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
    let match;
    while ((match = directExportPattern.exec(text)) !== null) {
      exported.add(match[1]);
    }

    // export { Name, Name2 }
    const namedExportPattern = /export\s*\{([^}]+)\}/g;
    while ((match = namedExportPattern.exec(text)) !== null) {
      match[1].split(',').forEach(name => {
        const cleanName = name.trim().split(/\s+as\s+/)[0].trim();
        if (cleanName) { exported.add(cleanName); }
      });
    }

    // export default Name
    const defaultExportPattern = /export\s+default\s+(\w+)/g;
    while ((match = defaultExportPattern.exec(text)) !== null) {
      if (!['function', 'class', 'async'].includes(match[1])) { exported.add(match[1]); }
    }

    return exported;
  }

  private extractImports(text: string, filePath: string): Map<string, string> {
    const imports = new Map<string, string>(); // name -> source path
    
    // import { Component } from './path' or import Component from './path'
    const importPattern = /import\s+(?:(?:\{([^}]+)\})|(\w+))?\s*(?:,\s*(?:\{([^}]+)\}|(\w+)))?\s*from\s*['"]([^'"]+)['"]/g;
    let match;

    while ((match = importPattern.exec(text)) !== null) {
      const namedImports1 = match[1]; // { A, B }
      const defaultImport1 = match[2]; // Component
      const namedImports2 = match[3]; // second named imports after comma
      const defaultImport2 = match[4]; // second default after comma  
      const sourcePath = match[5];

      // Skip external packages
      if (!sourcePath.startsWith('.') && !sourcePath.startsWith('@/') && !sourcePath.startsWith('~/')) {
        continue;
      }

      // Process named imports
      [namedImports1, namedImports2].forEach(namedImports => {
        if (namedImports) {
          namedImports.split(',').forEach(imp => {
            const name = imp.trim().split(/\s+as\s+/).pop()?.trim();
            if (name) {
              imports.set(name, sourcePath);
            }
          });
        }
      });

      // Process default imports
      [defaultImport1, defaultImport2].forEach(defaultImport => {
        if (defaultImport) {
          imports.set(defaultImport, sourcePath);
        }
      });
    }

    return imports;
  }

  /**
   * Extract Vue Single File Components (.vue): one component node per file.
   * Name from filename (PascalCase) or from script (defineOptions, export default name, defineComponent).
   */
  private extractVueComponents(text: string, lines: string[], filePath: string): void {
    const baseName = path.basename(filePath, '.vue');
    const nameFromFile = baseName
      .split(/[-_\s]+/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
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
        const defineOptionsMatch = scriptContent.match(/defineOptions\s*\(\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/);
        if (defineOptionsMatch) {
          componentName = defineOptionsMatch[1];
          break;
        }
        const exportDefaultNameMatch = scriptContent.match(/export\s+default\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/s);
        if (exportDefaultNameMatch) {
          componentName = exportDefaultNameMatch[1];
          break;
        }
        const defineComponentObj = scriptContent.match(/defineComponent\s*\(\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/);
        const defineComponentStr = scriptContent.match(/defineComponent\s*\(\s*['"]([^'"]+)['"]/);
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

    this.log(`  ✓ Vue component: ${componentName} @ ${filePath}:${startLine}`);
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
      metadata: { framework: 'vue' }
    });
  }

  private extractComponents(
    text: string, 
    lines: string[], 
    filePath: string,
    exportedNames: Set<string>,
    imports: Map<string, string>
  ): void {
    // Pattern for React components:
    // - PascalCase name
    // - Either function declaration or const arrow function
    // - Returns JSX (contains < and />)
    
    const patterns = [
      // export function ComponentName() or function ComponentName()
      /(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*)\s*\([^)]*\)/g,
      // export const ComponentName = () => or const ComponentName: React.FC = 
      /(?:export\s+)?(?:default\s+)?const\s+([A-Z]\w*)\s*(?::\s*(?:React\.)?(?:FC|FunctionComponent|Component)[^=]*)?\s*=\s*(?:\([^)]*\)|[a-z]\w*)\s*=>/g,
      // const ComponentName = function
      /(?:export\s+)?const\s+([A-Z]\w*)\s*=\s*function/g,
      // React.memo, React.forwardRef wrapped components
      /(?:export\s+)?(?:default\s+)?const\s+([A-Z]\w*)\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/g,
    ];

    // Log imports for debugging
    if (imports.size > 0) {
      const componentImports = Array.from(imports.entries())
        .filter(([name]) => /^[A-Z]/.test(name) || name.startsWith('use'));
      if (componentImports.length > 0) {
        this.log(`  Imports: ${componentImports.map(([n, p]) => `${n} from ${p}`).join(', ')}`);
      }
    }

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);
        const functionBody = lines.slice(startLine - 1, endLine).join('\n');

        // Must contain JSX to be a component
        if (!this.containsJSX(functionBody)) {
          this.stats.skippedFunctions++;
          continue;
        }

        // Prefer exported components, but include non-exported if they're clearly components
        const isExported = exportedNames.has(name);
        
        this.log(`  ✓ Component: ${name}${isExported ? ' (exported)' : ''} @ ${filePath}:${startLine}`);
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
          metadata: { exported: isExported }
        });
        // Edge detection is done in analyzeEdges() after all nodes are extracted
      }
    }
  }

  private extractHooks(
    text: string,
    lines: string[],
    filePath: string,
    exportedNames: Set<string>,
    isVueFile = false
  ): void {
    // Custom hooks (React) / composables (Vue) start with "use" followed by uppercase letter
    const patterns = [
      /(?:export\s+)?(?:default\s+)?function\s+(use[A-Z]\w*)\s*\(/g,
      /(?:export\s+)?(?:default\s+)?const\s+(use[A-Z]\w*)\s*=\s*(?:\([^)]*\)|[a-z]\w*)\s*=>/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        const isExported = exportedNames.has(name);
        // Vue <script setup>: top-level bindings are implicitly exported; include all useXxx
        if (!isExported && !isVueFile) {
          this.stats.skippedFunctions++;
          continue;
        }

        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);

        this.log(`  ✓ Hook: ${name} @ ${filePath}:${startLine}`);
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
          metadata: { exported: isExported }
        });
      }
    }
  }

  private extractEndpoints(text: string, lines: string[], filePath: string): void {
    // Express/Fastify route handlers
    const routePatterns = [
      // app.get('/path', handler) or router.post('/path', ...)
      /(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      // Next.js API routes: export async function GET/POST
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const method = match[1].toUpperCase();
        const route = match[2] || filePath.replace(/.*\/api/, '/api').replace(/\.\w+$/, '');
        const name = `${method} ${route}`;
        const startLine = text.substring(0, match.index).split('\n').length;

        this.log(`  ✓ Endpoint: ${name} @ ${filePath}:${startLine}`);
        this.stats.endpointsFound++;

        const endLine = this.findBlockEnd(lines, startLine - 1);
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
          metadata: { method, route }
        });
      }
    }

    // Note: API calls (fetch, axios) are tracked at the component level
    // via extractComponentUsage - we detect which components make API calls there
  }

  private extractClasses(
    text: string, 
    lines: string[], 
    filePath: string,
    exportedNames: Set<string>
  ): void {
    const classPattern = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
    let match;

    while ((match = classPattern.exec(text)) !== null) {
      const name = match[1];
      const extendsClass = match[2];
      const isExported = exportedNames.has(name);

      // Skip non-exported internal classes
      if (!isExported) {
        this.stats.skippedFunctions++;
        continue;
      }

      const startLine = text.substring(0, match.index).split('\n').length;
      const endLine = this.findBlockEnd(lines, startLine - 1);

      this.log(`  ✓ Class: ${name}${extendsClass ? ` extends ${extendsClass}` : ''} @ ${filePath}:${startLine}`);
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
        metadata: { extends: extendsClass, exported: isExported }
      });

      // Add extends edge
      if (extendsClass) {
        this.edges.push({
          source_stable_id: `${filePath}::${name}`,
          target_stable_id: extendsClass,
          edge_type: 'extends'
        });
      }
    }
  }

  private extractExportedFunctions(
    text: string, 
    lines: string[], 
    filePath: string,
    exportedNames: Set<string>
  ): void {
    // Only extract functions that are:
    // 1. Exported
    // 2. Not components (not PascalCase or no JSX)
    // 3. Not hooks (don't start with use)
    
    const patterns = [
      /export\s+(?:async\s+)?function\s+([a-z]\w*)\s*\(/g,
      /export\s+const\s+([a-z]\w*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        
        // Skip if it's a hook
        if (name.startsWith('use')) { continue; }
        
        // Skip common utility function names
        if (['get', 'set', 'is', 'has', 'can', 'should', 'will', 'did'].some(p => name.startsWith(p) && name.length < 8)) {
          this.stats.skippedFunctions++;
          continue;
        }

        const startLine = text.substring(0, match.index).split('\n').length;
        const endLine = this.findBlockEnd(lines, startLine - 1);
        const functionBody = lines.slice(startLine - 1, endLine).join('\n');

        // Skip if it contains JSX (it's a component we already caught)
        if (this.containsJSX(functionBody)) { continue; }

        this.log(`  ✓ Function: ${name} @ ${filePath}:${startLine}`);
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
          metadata: { exported: true }
        });
      }
    }
  }

  private containsJSX(text: string): boolean {
    // Check for JSX patterns
    return (
      /<[A-Z]\w*[\s/>]/.test(text) || // Custom components
      /<[a-z]+[\s/>]/.test(text) && /<\/[a-z]+>/.test(text) // HTML elements
    );
  }

  private findBlockEnd(lines: string[], startLineIndex: number): number {
    // First, we need to skip past the function parameters (which may contain braces
    // in destructuring patterns) and find the actual function body opening brace
    let parenCount = 0;
    let foundOpenParen = false;
    let foundCloseParen = false;
    let braceCount = 0;
    let foundBodyStart = false;
    
    for (let i = startLineIndex; i < lines.length; i++) {
      const line = lines[i];
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        
        // Phase 1: Skip past the parameter list
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
        
        // Phase 2: Find the function body and count braces
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
      // Add GitHub link if we have GitHub info configured
      if (!node.github_link && this.githubInfo) {
        node.github_link = this.generateGitHubLink(node.file_path, node.start_line, node.end_line);
      }
      this.nodes.set(node.stable_id, node);
    }
  }

}
