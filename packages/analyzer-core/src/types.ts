// Types matching the Supabase schema - shared between extension and worker

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

export type ClusterType = 'frontend' | 'backend' | 'shared' | 'unknown';

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

export interface GitHubInfo {
  owner: string;
  repo: string;
  branch: string;
}

export interface AnalyzerOptions {
  /** Enable LLM-based analysis (requires geminiApiKey) */
  enableLlm?: boolean;
  /** Gemini API key for LLM features */
  geminiApiKey?: string;
  /** Gemini model name */
  geminiModel?: string;
  /** Logger callback */
  logger?: (message: string) => void;
  /** Progress callback */
  onProgress?: (message: string, percent: number) => void;
}
