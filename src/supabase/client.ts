import * as vscode from 'vscode';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LocalNode, LocalEdge, CodeNode, CodeEdge, Workspace, Repo, RepoVersion, GraphData, GraphNode, GraphEdge } from '../types';
import * as path from 'path';

// Default values - can be overridden via settings
const DEFAULT_SUPABASE_URL = 'https://xfvxcufvhndwgkkfilaa.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmdnhjdWZ2aG5kd2dra2ZpbGFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTkzMzUsImV4cCI6MjA4NDg3NTMzNX0.wHaCMXY-ofbpIxqwLMizYSFrbzKTy0SLD9tjwULNHDA';

export class SupabaseService {
  private client: SupabaseClient | null = null;
  
  constructor() {}

  private getClient(): SupabaseClient {
    if (this.client) {
      return this.client;
    }

    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const supabaseUrl = config.get<string>('supabaseUrl') || DEFAULT_SUPABASE_URL;
    const supabaseAnonKey = config.get<string>('supabaseAnonKey') || DEFAULT_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase URL and anon key must be configured in settings');
    }

    this.client = createClient(supabaseUrl, supabaseAnonKey);
    return this.client;
  }

  async getOrCreateWorkspace(workspaceName: string): Promise<Workspace> {
    const client = this.getClient();
    const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    // Try to get existing workspace
    const { data: existing, error: fetchError } = await client
      .from('workspaces')
      .select('*')
      .eq('slug', slug)
      .single();

    if (existing && !fetchError) {
      return existing as Workspace;
    }

    // Create new workspace
    const { data: created, error: createError } = await client
      .from('workspaces')
      .insert({ name: workspaceName, slug })
      .select()
      .single();

    if (createError) {
      throw new Error(`Failed to create workspace: ${createError.message}`);
    }

    return created as Workspace;
  }

  async getOrCreateRepo(workspaceId: string, repoName: string): Promise<Repo> {
    const client = this.getClient();
    
    // Try to get existing repo
    const { data: existing, error: fetchError } = await client
      .from('repos')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('name', repoName)
      .single();

    if (existing && !fetchError) {
      return existing as Repo;
    }

    // Create new repo
    const { data: created, error: createError } = await client
      .from('repos')
      .insert({ 
        workspace_id: workspaceId, 
        name: repoName,
        owner: 'local' // For local workspaces
      })
      .select()
      .single();

    if (createError) {
      throw new Error(`Failed to create repo: ${createError.message}`);
    }

    return created as Repo;
  }

  async createVersion(repoId: string, commitSha: string, branch?: string): Promise<RepoVersion> {
    const client = this.getClient();
    
    const { data: created, error } = await client
      .from('repo_versions')
      .insert({
        repo_id: repoId,
        commit_sha: commitSha,
        branch: branch || 'main'
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create version: ${error.message}`);
    }

    return created as RepoVersion;
  }

  async saveNodes(versionId: string, nodes: LocalNode[]): Promise<Map<string, string>> {
    const client = this.getClient();
    const stableIdToId = new Map<string, string>();

    // Insert nodes in batches
    const batchSize = 100;
    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize).map(node => ({
        version_id: versionId,
        stable_id: node.stable_id,
        name: node.name,
        qualified_name: node.qualified_name,
        node_type: node.node_type,
        language: node.language,
        file_path: node.file_path,
        start_line: node.start_line,
        start_column: node.start_column,
        end_line: node.end_line,
        end_column: node.end_column,
        snippet: node.snippet?.substring(0, 1000), // Limit snippet size
        signature: node.signature,
        metadata: node.metadata || {}
      }));

      const { data, error } = await client
        .from('code_nodes')
        .insert(batch)
        .select('id, stable_id');

      if (error) {
        throw new Error(`Failed to save nodes: ${error.message}`);
      }

      // Build stable_id to id mapping
      data?.forEach((row: { id: string; stable_id: string }) => {
        stableIdToId.set(row.stable_id, row.id);
      });
    }

    return stableIdToId;
  }

  async saveEdges(versionId: string, edges: LocalEdge[], stableIdToId: Map<string, string>): Promise<void> {
    const client = this.getClient();

    // Filter edges to only include those where both source and target exist
    const validEdges = edges.filter(edge => 
      stableIdToId.has(edge.source_stable_id) && stableIdToId.has(edge.target_stable_id)
    );

    // Deduplicate edges based on source_node_id + target_node_id + edge_type
    const edgeMap = new Map<string, { 
      source_node_id: string; 
      target_node_id: string; 
      edge_type: string; 
      weight: number;
      metadata: Record<string, unknown>;
    }>();

    for (const edge of validEdges) {
      const sourceId = stableIdToId.get(edge.source_stable_id)!;
      const targetId = stableIdToId.get(edge.target_stable_id)!;
      const key = `${sourceId}:${targetId}:${edge.edge_type}`;
      
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          source_node_id: sourceId,
          target_node_id: targetId,
          edge_type: edge.edge_type,
          weight: edge.weight || 1,
          metadata: edge.metadata || {}
        });
      } else {
        // Increment weight for duplicate edges
        const existing = edgeMap.get(key)!;
        existing.weight += edge.weight || 1;
      }
    }

    const uniqueEdges = Array.from(edgeMap.values());

    // Insert edges in batches
    const batchSize = 100;
    for (let i = 0; i < uniqueEdges.length; i += batchSize) {
      const batch = uniqueEdges.slice(i, i + batchSize).map(edge => ({
        version_id: versionId,
        ...edge
      }));

      const { error } = await client
        .from('code_edges')
        .insert(batch);

      if (error) {
        throw new Error(`Failed to save edges: ${error.message}`);
      }
    }
  }

  async updateVersionCounts(versionId: string, nodeCount: number, edgeCount: number): Promise<void> {
    const client = this.getClient();
    
    const { error } = await client
      .from('repo_versions')
      .update({ node_count: nodeCount, edge_count: edgeCount })
      .eq('id', versionId);

    if (error) {
      throw new Error(`Failed to update version counts: ${error.message}`);
    }
  }

  async getLatestVersion(repoId: string): Promise<RepoVersion | null> {
    const client = this.getClient();
    
    const { data, error } = await client
      .from('repo_versions')
      .select('*')
      .eq('repo_id', repoId)
      .order('ingested_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      return null;
    }

    return data as RepoVersion;
  }

  async getGraphData(versionId: string): Promise<GraphData> {
    const client = this.getClient();

    // Fetch nodes
    const { data: nodesData, error: nodesError } = await client
      .from('code_nodes')
      .select('id, stable_id, name, node_type, file_path, start_line')
      .eq('version_id', versionId);

    if (nodesError) {
      throw new Error(`Failed to fetch nodes: ${nodesError.message}`);
    }

    // Fetch edges
    const { data: edgesData, error: edgesError } = await client
      .from('code_edges')
      .select('source_node_id, target_node_id, edge_type')
      .eq('version_id', versionId);

    if (edgesError) {
      throw new Error(`Failed to fetch edges: ${edgesError.message}`);
    }

    const nodes: GraphNode[] = (nodesData || []).map(node => ({
      id: node.id,
      label: node.name,
      type: node.node_type,
      filePath: node.file_path,
      line: node.start_line
    }));

    const edges: GraphEdge[] = (edgesData || []).map(edge => ({
      source: edge.source_node_id,
      target: edge.target_node_id,
      type: edge.edge_type
    }));

    return { nodes, edges };
  }

  async getAllVersionsForWorkspace(workspaceSlug: string): Promise<Array<{ version: RepoVersion; repo: Repo }>> {
    const client = this.getClient();

    // First get the workspace
    const { data: workspace, error: wsError } = await client
      .from('workspaces')
      .select('id')
      .eq('slug', workspaceSlug)
      .single();

    if (wsError || !workspace) {
      return [];
    }

    // Get repos for workspace
    const { data: repos, error: reposError } = await client
      .from('repos')
      .select('*')
      .eq('workspace_id', workspace.id);

    if (reposError || !repos) {
      return [];
    }

    const results: Array<{ version: RepoVersion; repo: Repo }> = [];

    for (const repo of repos) {
      const { data: versions } = await client
        .from('repo_versions')
        .select('*')
        .eq('repo_id', repo.id)
        .order('ingested_at', { ascending: false })
        .limit(1);

      if (versions && versions.length > 0) {
        results.push({ version: versions[0] as RepoVersion, repo: repo as Repo });
      }
    }

    return results;
  }
}
