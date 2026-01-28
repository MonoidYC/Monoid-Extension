import * as vscode from 'vscode';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { LocalNode, LocalEdge, CodeNode, CodeEdge, Workspace, Repo, RepoVersion, GraphData, GraphNode, GraphEdge } from '../types';
import { LocalTestNode, LocalTestCoverageEdge, TestNode, TestStatusUpdate, CodeNodeForTestGen } from '../testing/types';
import * as path from 'path';
import * as fs from 'fs';

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

  async getOrCreateOrganization(orgName: string, slug?: string, avatarUrl?: string): Promise<{ id: string; name: string; slug: string }> {
    const client = this.getClient();
    const orgSlug = slug || orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    // Try to get existing organization
    const { data: existing, error: fetchError } = await client
      .from('organizations')
      .select('*')
      .eq('slug', orgSlug)
      .single();

    if (existing && !fetchError) {
      return existing as { id: string; name: string; slug: string };
    }

    // Create new organization
    const { data: created, error: createError } = await client
      .from('organizations')
      .insert({ 
        name: orgName, 
        slug: orgSlug,
        avatar_url: avatarUrl || null
      })
      .select()
      .single();

    if (createError) {
      throw new Error(`Failed to create organization: ${createError.message}`);
    }

    console.log(`[Supabase] Created organization: ${orgName} (${orgSlug})`);
    return created as { id: string; name: string; slug: string };
  }

  async getOrCreateRepo(workspaceId: string, repoName: string, owner?: string, organizationId?: string): Promise<Repo> {
    const client = this.getClient();
    const repoOwner = owner || 'local';
    
    // Try to get existing repo by owner/name combination
    const { data: existing, error: fetchError } = await client
      .from('repos')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('name', repoName)
      .eq('owner', repoOwner)
      .single();

    if (existing && !fetchError) {
      // If organization_id is provided and repo doesn't have one, update it
      if (organizationId && !(existing as any).organization_id) {
        await client
          .from('repos')
          .update({ organization_id: organizationId })
          .eq('id', existing.id);
      }
      return existing as Repo;
    }

    // Create new repo
    const insertData: any = { 
      workspace_id: workspaceId, 
      name: repoName,
      owner: repoOwner
    };
    
    if (organizationId) {
      insertData.organization_id = organizationId;
    }

    const { data: created, error: createError } = await client
      .from('repos')
      .insert(insertData)
      .select()
      .single();

    if (createError) {
      throw new Error(`Failed to create repo: ${createError.message}`);
    }

    console.log(`[Supabase] Created repo: ${repoOwner}/${repoName} (org: ${organizationId || 'none'})`);
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
        summary: node.summary,
        metadata: node.metadata || {},
        github_link: node.github_link
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
      .select('id, stable_id, name, node_type, file_path, start_line, github_link')
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
      line: node.start_line,
      githubLink: node.github_link
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

  // ==================== Test Node Methods ====================

  /**
   * Save test nodes to Supabase (upsert to handle regeneration)
   * Returns a map of stable_id -> database id
   */
  async saveTestNodes(versionId: string, tests: LocalTestNode[]): Promise<Map<string, string>> {
    const client = this.getClient();
    const stableIdToId = new Map<string, string>();

    // Upsert tests in batches
    const batchSize = 50;
    for (let i = 0; i < tests.length; i += batchSize) {
      const batch = tests.slice(i, i + batchSize).map(test => ({
        version_id: versionId,
        stable_id: test.stable_id,
        name: test.name,
        description: test.description,
        test_type: test.test_type,
        source_type: test.source_type,
        file_path: test.file_path,
        start_line: test.start_line,
        end_line: test.end_line,
        runner: test.runner,
        command: test.command,
        last_status: 'pending',
        metadata: test.metadata || {}
      }));

      const { data, error } = await client
        .from('test_nodes')
        .upsert(batch, { 
          onConflict: 'version_id,stable_id',
          ignoreDuplicates: false 
        })
        .select('id, stable_id');

      if (error) {
        throw new Error(`Failed to save test nodes: ${error.message}`);
      }

      // Build stable_id to id mapping
      data?.forEach((row: { id: string; stable_id: string }) => {
        stableIdToId.set(row.stable_id, row.id);
      });
    }

    return stableIdToId;
  }

  /**
   * Save or update a single test node (upsert by stable_id)
   */
  async saveOrUpdateTestNode(versionId: string, test: LocalTestNode): Promise<string> {
    const client = this.getClient();

    // Check if test already exists for this version
    const { data: existing } = await client
      .from('test_nodes')
      .select('id')
      .eq('version_id', versionId)
      .eq('stable_id', test.stable_id)
      .single();

    if (existing) {
      // Update existing test
      const { error } = await client
        .from('test_nodes')
        .update({
          name: test.name,
          description: test.description,
          file_path: test.file_path,
          start_line: test.start_line,
          end_line: test.end_line,
          command: test.command,
          metadata: test.metadata || {}
        })
        .eq('id', existing.id);

      if (error) {
        throw new Error(`Failed to update test node: ${error.message}`);
      }

      return existing.id;
    }

    // Insert new test
    const { data, error } = await client
      .from('test_nodes')
      .insert({
        version_id: versionId,
        stable_id: test.stable_id,
        name: test.name,
        description: test.description,
        test_type: test.test_type,
        source_type: test.source_type,
        file_path: test.file_path,
        start_line: test.start_line,
        end_line: test.end_line,
        runner: test.runner,
        command: test.command,
        last_status: 'pending',
        metadata: test.metadata || {}
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to save test node: ${error.message}`);
    }

    return data.id;
  }

  /**
   * Get all test nodes for a version
   */
  async getTestNodes(versionId: string): Promise<TestNode[]> {
    const client = this.getClient();

    const { data, error } = await client
      .from('test_nodes')
      .select('*')
      .eq('version_id', versionId)
      .order('file_path', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch test nodes: ${error.message}`);
    }

    return (data || []) as TestNode[];
  }

  /**
   * Get a single test node by ID
   */
  async getTestNode(testNodeId: string): Promise<TestNode | null> {
    const client = this.getClient();

    const { data, error } = await client
      .from('test_nodes')
      .select('*')
      .eq('id', testNodeId)
      .single();

    if (error) {
      return null;
    }

    return data as TestNode;
  }

  /**
   * Get a test node by stable_id within a version
   */
  async getTestNodeByStableId(versionId: string, stableId: string): Promise<TestNode | null> {
    const client = this.getClient();

    const { data, error } = await client
      .from('test_nodes')
      .select('*')
      .eq('version_id', versionId)
      .eq('stable_id', stableId)
      .single();

    if (error) {
      // Log what stable_ids exist for this version to help debug
      const { data: existingNodes } = await client
        .from('test_nodes')
        .select('stable_id')
        .eq('version_id', versionId)
        .limit(10);
      
      console.log(`[Supabase] getTestNodeByStableId failed for "${stableId}"`);
      console.log(`[Supabase] Sample stable_ids for version ${versionId}:`, existingNodes?.map(n => n.stable_id));
      return null;
    }

    return data as TestNode;
  }

  /**
   * Update test status after execution
   */
  async updateTestStatus(testNodeId: string, status: TestStatusUpdate): Promise<void> {
    const client = this.getClient();

    const { error } = await client
      .from('test_nodes')
      .update(status)
      .eq('id', testNodeId);

    if (error) {
      throw new Error(`Failed to update test status: ${error.message}`);
    }
  }

  /**
   * Delete a test node
   */
  async deleteTestNode(testNodeId: string): Promise<void> {
    const client = this.getClient();

    // First delete coverage edges
    await client
      .from('test_coverage_edges')
      .delete()
      .eq('test_node_id', testNodeId);

    // Then delete the test node
    const { error } = await client
      .from('test_nodes')
      .delete()
      .eq('id', testNodeId);

    if (error) {
      throw new Error(`Failed to delete test node: ${error.message}`);
    }
  }

  /**
   * Delete all test nodes for a version
   */
  async deleteAllTestsForVersion(versionId: string): Promise<{ deleted: number }> {
    const client = this.getClient();

    // First get all test node IDs for this version
    const { data: testNodes, error: fetchError } = await client
      .from('test_nodes')
      .select('id')
      .eq('version_id', versionId);

    if (fetchError) {
      throw new Error(`Failed to fetch test nodes: ${fetchError.message}`);
    }

    if (!testNodes || testNodes.length === 0) {
      return { deleted: 0 };
    }

    const testNodeIds = testNodes.map(t => t.id);

    // Delete all coverage edges for these test nodes
    const { error: edgeError } = await client
      .from('test_coverage_edges')
      .delete()
      .in('test_node_id', testNodeIds);

    if (edgeError) {
      console.error(`Warning: Failed to delete test coverage edges: ${edgeError.message}`);
    }

    // Delete all test nodes for this version
    const { error: deleteError } = await client
      .from('test_nodes')
      .delete()
      .eq('version_id', versionId);

    if (deleteError) {
      throw new Error(`Failed to delete test nodes: ${deleteError.message}`);
    }

    return { deleted: testNodes.length };
  }

  // ==================== Test Coverage Edge Methods ====================

  /**
   * Save test coverage edges linking tests to code nodes
   */
  async saveTestCoverageEdges(
    versionId: string,
    edges: LocalTestCoverageEdge[],
    testIdMap: Map<string, string>,
    codeIdMap: Map<string, string>
  ): Promise<void> {
    const client = this.getClient();

    // Filter edges to only include those where both test and code nodes exist
    const validEdges = edges.filter(edge =>
      testIdMap.has(edge.test_stable_id) && codeIdMap.has(edge.code_stable_id)
    );

    if (validEdges.length === 0) {
      return;
    }

    // Deduplicate edges
    const edgeMap = new Map<string, {
      test_node_id: string;
      code_node_id: string;
      coverage_type: string;
      metadata: Record<string, unknown>;
    }>();

    for (const edge of validEdges) {
      const testId = testIdMap.get(edge.test_stable_id)!;
      const codeId = codeIdMap.get(edge.code_stable_id)!;
      const key = `${testId}:${codeId}:${edge.coverage_type}`;

      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          test_node_id: testId,
          code_node_id: codeId,
          coverage_type: edge.coverage_type,
          metadata: edge.metadata || {}
        });
      }
    }

    const uniqueEdges = Array.from(edgeMap.values());

    // Upsert edges in batches (to handle regeneration)
    const batchSize = 100;
    for (let i = 0; i < uniqueEdges.length; i += batchSize) {
      const batch = uniqueEdges.slice(i, i + batchSize).map(edge => ({
        version_id: versionId,
        ...edge
      }));

      const { error } = await client
        .from('test_coverage_edges')
        .upsert(batch, {
          onConflict: 'test_node_id,code_node_id',
          ignoreDuplicates: false
        });

      if (error) {
        throw new Error(`Failed to save test coverage edges: ${error.message}`);
      }
    }
  }

  /**
   * Add a single coverage edge
   */
  async addTestCoverageEdge(
    versionId: string,
    testNodeId: string,
    codeNodeId: string,
    coverageType: string
  ): Promise<void> {
    const client = this.getClient();

    // Check if edge already exists
    const { data: existing } = await client
      .from('test_coverage_edges')
      .select('id')
      .eq('version_id', versionId)
      .eq('test_node_id', testNodeId)
      .eq('code_node_id', codeNodeId)
      .eq('coverage_type', coverageType)
      .single();

    if (existing) {
      return; // Edge already exists
    }

    const { error } = await client
      .from('test_coverage_edges')
      .insert({
        version_id: versionId,
        test_node_id: testNodeId,
        code_node_id: codeNodeId,
        coverage_type: coverageType,
        metadata: {}
      });

    if (error) {
      throw new Error(`Failed to add test coverage edge: ${error.message}`);
    }
  }

  /**
   * Get coverage edges for a test node
   */
  async getTestCoverageEdges(testNodeId: string): Promise<{ code_node_id: string; coverage_type: string }[]> {
    const client = this.getClient();

    const { data, error } = await client
      .from('test_coverage_edges')
      .select('code_node_id, coverage_type')
      .eq('test_node_id', testNodeId);

    if (error) {
      throw new Error(`Failed to fetch test coverage edges: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Get code nodes stable_id to id mapping for a version
   */
  async getCodeNodeIdMap(versionId: string): Promise<Map<string, string>> {
    const client = this.getClient();
    const stableIdToId = new Map<string, string>();

    const { data, error } = await client
      .from('code_nodes')
      .select('id, stable_id')
      .eq('version_id', versionId);

    if (error) {
      throw new Error(`Failed to fetch code nodes: ${error.message}`);
    }

    data?.forEach((row: { id: string; stable_id: string }) => {
      stableIdToId.set(row.stable_id, row.id);
    });

    return stableIdToId;
  }

  /**
   * Get code nodes by type for a version (for test generation)
   */
  async getCodeNodesByType(versionId: string, nodeTypes: string[]): Promise<CodeNodeForTestGen[]> {
    const client = this.getClient();

    const { data, error } = await client
      .from('code_nodes')
      .select('id, stable_id, name, node_type, file_path, start_line, end_line, snippet, signature, summary, metadata')
      .eq('version_id', versionId)
      .in('node_type', nodeTypes)
      .order('file_path', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch code nodes by type: ${error.message}`);
    }

    return (data || []) as CodeNodeForTestGen[];
  }

  /**
   * Get all code nodes for a version that could be related to a specific file
   * (useful for finding dependencies/imports)
   */
  async getRelatedCodeNodes(versionId: string, filePath: string): Promise<CodeNodeForTestGen[]> {
    const client = this.getClient();

    // Get all nodes from the same file
    const { data: sameFileNodes, error: sameFileError } = await client
      .from('code_nodes')
      .select('id, stable_id, name, node_type, file_path, start_line, end_line, snippet, signature, summary, metadata')
      .eq('version_id', versionId)
      .eq('file_path', filePath);

    if (sameFileError) {
      throw new Error(`Failed to fetch related code nodes: ${sameFileError.message}`);
    }

    // Get edges where source is from this file to find dependencies
    const nodeIds = (sameFileNodes || []).map(n => n.id);
    
    if (nodeIds.length === 0) {
      return sameFileNodes || [];
    }

    const { data: edges, error: edgesError } = await client
      .from('code_edges')
      .select('target_node_id')
      .eq('version_id', versionId)
      .in('source_node_id', nodeIds)
      .in('edge_type', ['imports', 'uses', 'calls']);

    if (edgesError) {
      return sameFileNodes || [];
    }

    const targetIds = (edges || []).map(e => e.target_node_id);
    
    if (targetIds.length === 0) {
      return sameFileNodes || [];
    }

    // Fetch the target nodes (dependencies)
    const { data: depNodes, error: depError } = await client
      .from('code_nodes')
      .select('id, stable_id, name, node_type, file_path, start_line, end_line, snippet, signature, summary, metadata')
      .in('id', targetIds);

    if (depError) {
      return sameFileNodes || [];
    }

    return [...(sameFileNodes || []), ...(depNodes || [])];
  }

  /**
   * Get endpoints that a component might call (based on code edges)
   */
  async getEndpointsForComponent(versionId: string, componentNodeId: string): Promise<CodeNodeForTestGen[]> {
    const client = this.getClient();

    // Get edges from this component
    const { data: edges, error: edgesError } = await client
      .from('code_edges')
      .select('target_node_id')
      .eq('version_id', versionId)
      .eq('source_node_id', componentNodeId)
      .in('edge_type', ['calls', 'uses', 'routes_to']);

    if (edgesError || !edges || edges.length === 0) {
      return [];
    }

    const targetIds = edges.map(e => e.target_node_id);

    // Fetch the endpoint nodes
    const { data: endpoints, error: endpointError } = await client
      .from('code_nodes')
      .select('id, stable_id, name, node_type, file_path, start_line, end_line, snippet, signature, summary, metadata')
      .in('id', targetIds)
      .eq('node_type', 'endpoint');

    if (endpointError) {
      return [];
    }

    return (endpoints || []) as CodeNodeForTestGen[];
  }

  // ==================== Storage Methods ====================

  /**
   * Upload a test video file to Supabase Storage
   * Returns the public URL of the uploaded video
   */
  async uploadTestVideo(
    videoFilePath: string,
    repoOwner: string,
    repoName: string,
    testStableId: string
  ): Promise<string | null> {
    const client = this.getClient();
    
    try {
      // Check if file exists
      if (!fs.existsSync(videoFilePath)) {
        console.log(`[Supabase Storage] Video file not found: ${videoFilePath}`);
        return null;
      }

      // Read file content
      const fileBuffer = fs.readFileSync(videoFilePath);
      
      // Generate a unique path for the video
      // Format: {repoOwner}/{repoName}/{testStableId}/{timestamp}.webm
      const timestamp = Date.now();
      const fileExtension = path.extname(videoFilePath) || '.webm';
      const sanitizedStableId = testStableId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const storagePath = `${repoOwner}/${repoName}/${sanitizedStableId}/${timestamp}${fileExtension}`;

      console.log(`[Supabase Storage] Uploading video to: ${storagePath}`);

      // Upload to storage
      const { data, error } = await client.storage
        .from('test-videos')
        .upload(storagePath, fileBuffer, {
          contentType: fileExtension === '.mp4' ? 'video/mp4' : 'video/webm',
          upsert: true
        });

      if (error) {
        console.error(`[Supabase Storage] Upload failed: ${error.message}`);
        return null;
      }

      // Get public URL
      const { data: urlData } = client.storage
        .from('test-videos')
        .getPublicUrl(storagePath);

      console.log(`[Supabase Storage] Upload successful. Public URL: ${urlData.publicUrl}`);
      return urlData.publicUrl;

    } catch (err: any) {
      console.error(`[Supabase Storage] Error uploading video: ${err.message}`);
      return null;
    }
  }

  /**
   * Delete old test videos for a specific test to save storage space
   * Keeps only the most recent video
   */
  async cleanupOldTestVideos(
    repoOwner: string,
    repoName: string,
    testStableId: string,
    keepCount: number = 1
  ): Promise<void> {
    const client = this.getClient();
    
    try {
      const sanitizedStableId = testStableId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const folderPath = `${repoOwner}/${repoName}/${sanitizedStableId}`;

      // List files in the test's folder
      const { data: files, error: listError } = await client.storage
        .from('test-videos')
        .list(folderPath, {
          sortBy: { column: 'created_at', order: 'desc' }
        });

      if (listError || !files || files.length <= keepCount) {
        return; // No cleanup needed
      }

      // Delete all but the most recent videos
      const filesToDelete = files.slice(keepCount).map(f => `${folderPath}/${f.name}`);
      
      if (filesToDelete.length > 0) {
        const { error: deleteError } = await client.storage
          .from('test-videos')
          .remove(filesToDelete);

        if (deleteError) {
          console.error(`[Supabase Storage] Failed to cleanup old videos: ${deleteError.message}`);
        } else {
          console.log(`[Supabase Storage] Cleaned up ${filesToDelete.length} old video(s)`);
        }
      }
    } catch (err: any) {
      console.error(`[Supabase Storage] Error cleaning up videos: ${err.message}`);
    }
  }
}
