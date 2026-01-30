import * as vscode from 'vscode';
import type { AnalysisResult, LocalNode, LocalEdge } from '../types';

const GRAPH_DIR = '.monoid';
const GRAPH_FILE = 'graph.json';

/**
 * Path to the local graph JSON file in the workspace
 */
export function getGraphFilePath(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder.uri, GRAPH_DIR, GRAPH_FILE);
}

/**
 * Write nodes and edges to .monoid/graph.json in the workspace
 */
export async function writeLocalGraph(
  workspaceFolder: vscode.WorkspaceFolder,
  data: AnalysisResult
): Promise<vscode.Uri> {
  const dirUri = vscode.Uri.joinPath(workspaceFolder.uri, GRAPH_DIR);
  const fileUri = vscode.Uri.joinPath(dirUri, GRAPH_FILE);

  try {
    await vscode.workspace.fs.createDirectory(dirUri);
  } catch {
    // Directory may already exist
  }

  const payload = {
    nodes: data.nodes,
    edges: data.edges,
    generatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(json);
  await vscode.workspace.fs.writeFile(fileUri, bytes);
  return fileUri;
}

/**
 * Read graph from .monoid/graph.json if it exists
 */
export async function readLocalGraph(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<{ nodes: LocalNode[]; edges: LocalEdge[] } | null> {
  const fileUri = getGraphFilePath(workspaceFolder);
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as {
      nodes?: LocalNode[];
      edges?: LocalEdge[];
      generatedAt?: string;
    };
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return { nodes: parsed.nodes, edges: parsed.edges };
    }
  } catch {
    // File missing or invalid
  }
  return null;
}
