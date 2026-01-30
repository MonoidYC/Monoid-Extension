// Types matching the Supabase schema

export type NodeType = 
  | 'function' 
  | 'class' 
  | 'method' 
  | 'endpoint' 
  | 'handler' 
  | 'middleware' 
  | 'hook' 
  | 'component' 
  | 'module' 
  | 'variable' 
  | 'type' 
  | 'interface' 
  | 'constant' 
  | 'test' 
  | 'other';

export type EdgeType = 
  | 'calls' 
  | 'imports' 
  | 'exports' 
  | 'extends' 
  | 'implements' 
  | 'routes_to' 
  | 'depends_on' 
  | 'uses' 
  | 'defines' 
  | 'references' 
  | 'other';

export interface CodeNode {
  id?: string;
  version_id: string;
  stable_id: string;
  name: string;
  qualified_name?: string;
  node_type: NodeType;
  language?: string;
  file_path: string;
  start_line: number;
  start_column?: number;
  end_line: number;
  end_column?: number;
  snippet?: string;
  signature?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  github_link?: string;
}

export interface CodeEdge {
  id?: string;
  version_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  created_at?: string;
  updated_at?: string;
}

export interface Repo {
  id: string;
  workspace_id: string;
  owner: string;
  name: string;
  default_branch?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RepoVersion {
  id: string;
  repo_id: string;
  commit_sha: string;
  branch?: string;
  committed_at?: string;
  ingested_at?: string;
  node_count?: number;
  edge_count?: number;
}

// GitHub repository info for generating links
export interface GitHubInfo {
  owner: string;
  repo: string;
  branch: string;
}

// Cluster for frontend/backend grouping (optional; can be set by user in UI)
export type ClusterType = 'frontend' | 'backend' | 'shared' | 'unknown';

// For local analysis before saving to Supabase
export interface LocalNode {
  stable_id: string;
  name: string;
  qualified_name?: string;
  node_type: NodeType;
  language?: string;
  file_path: string;
  start_line: number;
  start_column?: number;
  end_line: number;
  end_column?: number;
  snippet?: string;
  signature?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  github_link?: string;
  /** User-overridable cluster; persisted in .monoid/graph.json */
  cluster?: ClusterType;
}

export interface LocalEdge {
  source_stable_id: string;
  target_stable_id: string;
  edge_type: EdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface AnalysisResult {
  nodes: LocalNode[];
  edges: LocalEdge[];
}

// Graph visualization types
export interface GraphNode {
  id: string;
  label: string;
  type: NodeType;
  filePath: string;
  line: number;
  summary?: string;
  githubLink?: string;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
