import * as vscode from 'vscode';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import type { LocalNode, LocalEdge, Workspace, Repo, RepoVersion, GraphData, GraphNode, GraphEdge } from '../types';

// Demo defaults (override via VS Code settings)
const DEFAULT_SUPABASE_URL = 'https://xfvxcufvhndwgkkfilaa.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmdnhjdWZ2aG5kd2dra2ZpbGFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTkzMzUsImV4cCI6MjA4NDg3NTMzNX0.wHaCMXY-ofbpIxqwLMizYSFrbzKTy0SLD9tjwULNHDA';

function cryptoRandomString(bytes: number): string {
  try {
    return crypto.randomBytes(bytes).toString('hex');
  } catch {
    return Array.from({ length: bytes }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }
}

export class SupabaseService {
  private client: SupabaseClient | null = null;
  private readonly secrets: vscode.SecretStorage;

  private static readonly AUTH_STATE_KEY = 'monoid.supabase.auth_state';

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  private getRedirectExtensionUri(): string {
    // publisher.name from package.json
    return 'vscode://monoid.monoid-visualize/auth-callback';
  }

  private getAuthStorage(): any {
    const prefix = 'monoid.supabase.auth.';
    return {
      getItem: async (key: string) => {
        return await this.secrets.get(prefix + key);
      },
      setItem: async (key: string, value: string) => {
        await this.secrets.store(prefix + key, value);
      },
      removeItem: async (key: string) => {
        await this.secrets.delete(prefix + key);
      },
    };
  }

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

    this.client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: this.getAuthStorage(),
      },
    });

    return this.client;
  }

  async startPkceSignIn(email: string, hostedCallbackUrl: string): Promise<void> {
    const client = this.getClient();
    const state = cryptoRandomString(24);
    await this.secrets.store(SupabaseService.AUTH_STATE_KEY, state);

    // Supabase will redirect to hostedCallbackUrl with ?code=...&state=...
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${hostedCallbackUrl}?state=${encodeURIComponent(state)}`,
      },
    });
    if (error) {
      throw new Error(`Failed to start sign-in: ${error.message}`);
    }
  }

  async signInWithPassword(email: string, password: string): Promise<{ userId: string }> {
    const client = this.getClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(error.message);
    }
    const userId = data.user?.id ?? data.session?.user?.id;
    if (!userId) {
      throw new Error('Signed in, but no user returned.');
    }
    // Confirm PostgREST sees the auth context (for debugging)
    try {
      const { data: who, error: whoErr } = await client.rpc('whoami');
      console.log('[Monoid] whoami():', whoErr ? whoErr : who);
    } catch {
      // ignore
    }
    return { userId };
  }

  async handleAuthCallbackUri(uri: vscode.Uri): Promise<boolean> {
    if (uri.path !== '/auth-callback') {
      return false;
    }

    const params = new URLSearchParams(uri.query);
    const code = params.get('code');
    const state = params.get('state');

    if (!code) {
      throw new Error('Missing code in auth callback URL.');
    }

    const expectedState = await this.secrets.get(SupabaseService.AUTH_STATE_KEY);
    if (!expectedState || !state || state !== expectedState) {
      throw new Error('Invalid auth state. Please try signing in again.');
    }

    const client = this.getClient();
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error) {
      throw new Error(`Failed to exchange code for session: ${error.message}`);
    }

    await this.secrets.delete(SupabaseService.AUTH_STATE_KEY);

    const session = data.session;
    if (!session) {
      throw new Error('No session returned from Supabase.');
    }

    // Ensure the client definitely has the session set (and persists it).
    await client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });

    // Server-side truth: what does PostgREST see for auth.uid()?
    try {
      const { data: who, error: whoErr } = await client.rpc('whoami');
      console.log('[Monoid] whoami():', whoErr ? whoErr : who);
    } catch (e) {
      console.log('[Monoid] whoami() call failed:', e);
    }

    console.log('[Monoid] Signed in as:', session.user.id);
    return true;
  }

  async signOut(): Promise<void> {
    const client = this.getClient();
    await client.auth.signOut();
    await this.secrets.delete(SupabaseService.AUTH_STATE_KEY);
  }

  async checkAuthentication(): Promise<{ authenticated: boolean; userId: string | null }> {
    const client = this.getClient();
    let { data } = await client.auth.getSession();
    if (!data.session) {
      // Try to restore/refresh from persisted refresh token.
      await client.auth.refreshSession();
      data = (await client.auth.getSession()).data;
    }

    // Log server-side auth context to detect “anon” vs “authenticated”.
    try {
      const { data: who, error: whoErr } = await client.rpc('whoami');
      console.log('[Monoid] whoami():', whoErr ? whoErr : who);
    } catch {
      // ignore
    }

    return { authenticated: !!data.session, userId: data.session?.user?.id ?? null };
  }

  async getOrCreateWorkspace(workspaceName: string): Promise<Workspace> {
    const client = this.getClient();
    const { data: { session } } = await client.auth.getSession();
    const userId = session?.user?.id ?? null;
    const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // If authenticated, filter by user_id; otherwise use slug only
    let query = client.from('workspaces').select('*').eq('slug', slug);
    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data: existing, error: fetchError } = await query.maybeSingle();

    if (existing && !fetchError) {
      return existing as Workspace;
    }

    // Create workspace with user_id if authenticated
    const insertData: any = { name: workspaceName, slug };
    if (userId) {
      insertData.user_id = userId;
    }

    const { data: created, error: createError } = await client
      .from('workspaces')
      .insert(insertData)
      .select()
      .single();

    if (createError) {
      // Handle unique constraint violation - workspace with this slug already exists for this user
      if (createError.code === '23505' || createError.message.includes('duplicate key') || createError.message.includes('unique constraint')) {
        // Try to fetch the existing workspace one more time (might have been created between check and insert)
        const { data: existingWorkspace } = await query.maybeSingle();
        if (existingWorkspace) {
          return existingWorkspace as Workspace;
        }
        // If still not found (shouldn't happen with proper constraints), suggest a different slug
        throw new Error(
          `A workspace with slug "${slug}" already exists for your account. ` +
          `Please use a different workspace name.`
        );
      }
      throw new Error(`Failed to create workspace: ${createError.message}`);
    }
    return created as Workspace;
  }

  async getOrCreateOrganization(
    orgName: string,
    slug?: string,
    avatarUrl?: string
  ): Promise<{ id: string; name: string; slug: string }> {
    const client = this.getClient();
    const { data: { session } } = await client.auth.getSession();
    const userId = session?.user?.id ?? null;

    const orgSlug = slug || orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Try to find existing org by slug
    const { data: existing, error: fetchError } = await client
      .from('organizations')
      .select('*')
      .eq('slug', orgSlug)
      .maybeSingle();

    if (existing && !fetchError) {
      // If we found an org and user is authenticated, ensure they're a member
      if (userId) {
        await this.ensureOrgMembership(existing.id, userId);
      }
      return existing as { id: string; name: string; slug: string };
    }

    // Create new organization with created_by field
    const insertData: any = { 
      name: orgName, 
      slug: orgSlug, 
      avatar_url: avatarUrl || null 
    };
    if (userId) {
      insertData.created_by = userId;
    }

    const { data: created, error: createError } = await client
      .from('organizations')
      .insert(insertData)
      .select()
      .single();

    if (createError) {
      // Handle unique constraint - org might have been created between check and insert
      if (createError.code === '23505' || createError.message.includes('duplicate key')) {
        const { data: retryExisting } = await client
          .from('organizations')
          .select('*')
          .eq('slug', orgSlug)
          .maybeSingle();
        if (retryExisting) {
          if (userId) {
            await this.ensureOrgMembership(retryExisting.id, userId);
          }
          return retryExisting as { id: string; name: string; slug: string };
        }
      }
      throw new Error(`Failed to create organization: ${createError.message}`);
    }

    // Add user as owner of the new organization
    if (userId && created) {
      await this.addOrgMember(created.id, userId, 'owner');
    }

    return created as { id: string; name: string; slug: string };
  }

  private async ensureOrgMembership(orgId: string, userId: string): Promise<void> {
    const client = this.getClient();
    
    // Check if membership already exists
    const { data: existing } = await client
      .from('org_members')
      .select('id')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existing) {
      // Add as member if not already
      await this.addOrgMember(orgId, userId, 'member');
    }
  }

  private async addOrgMember(orgId: string, userId: string, role: 'owner' | 'admin' | 'member'): Promise<void> {
    const client = this.getClient();
    
    const { error } = await client
      .from('org_members')
      .insert({
        organization_id: orgId,
        user_id: userId,
        role: role,
      });

    if (error && !error.message.includes('duplicate key')) {
      console.warn(`[Monoid] Failed to add org member: ${error.message}`);
    }
  }

  async getOrCreateRepo(
    workspaceId: string,
    repoName: string,
    owner?: string,
    organizationId?: string
  ): Promise<Repo> {
    const client = this.getClient();
    const repoOwner = owner || 'local';

    const { data: existing, error: fetchError } = await client
      .from('repos')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('name', repoName)
      .eq('owner', repoOwner)
      .single();

    if (existing && !fetchError) {
      if (organizationId && !(existing as any).organization_id) {
        await client.from('repos').update({ organization_id: organizationId }).eq('id', existing.id);
      }
      return existing as Repo;
    }

    const insertData: any = { workspace_id: workspaceId, name: repoName, owner: repoOwner };
    if (organizationId) {
      insertData.organization_id = organizationId;
    }

    const { data: created, error: createError } = await client.from('repos').insert(insertData).select().single();
    if (createError) {
      throw new Error(`Failed to create repo: ${createError.message}`);
    }
    return created as Repo;
  }

  async createVersion(repoId: string, commitSha: string, branch?: string): Promise<RepoVersion> {
    const client = this.getClient();

    const { data: created, error } = await client
      .from('repo_versions')
      .insert({ repo_id: repoId, commit_sha: commitSha, branch: branch || 'main' })
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

    const batchSize = 100;
    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize).map((node) => ({
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
        snippet: node.snippet?.substring(0, 1000),
        signature: node.signature,
        summary: node.summary,
        metadata: node.metadata || {},
        github_link: node.github_link,
      }));

      const { data, error } = await client.from('code_nodes').insert(batch).select('id, stable_id');
      if (error) {
        throw new Error(`Failed to save nodes: ${error.message}`);
      }

      data?.forEach((row: { id: string; stable_id: string }) => {
        stableIdToId.set(row.stable_id, row.id);
      });
    }

    return stableIdToId;
  }

  async saveEdges(versionId: string, edges: LocalEdge[], stableIdToId: Map<string, string>): Promise<void> {
    const client = this.getClient();

    const validEdges = edges.filter(
      (edge) => stableIdToId.has(edge.source_stable_id) && stableIdToId.has(edge.target_stable_id)
    );

    const edgeMap = new Map<
      string,
      { source_node_id: string; target_node_id: string; edge_type: string; weight: number; metadata: Record<string, unknown> }
    >();

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
          metadata: edge.metadata || {},
        });
      } else {
        edgeMap.get(key)!.weight += edge.weight || 1;
      }
    }

    const uniqueEdges = Array.from(edgeMap.values());
    const batchSize = 100;
    for (let i = 0; i < uniqueEdges.length; i += batchSize) {
      const batch = uniqueEdges.slice(i, i + batchSize).map((edge) => ({ version_id: versionId, ...edge }));
      const { error } = await client.from('code_edges').insert(batch);
      if (error) {
        throw new Error(`Failed to save edges: ${error.message}`);
      }
    }
  }

  async updateVersionCounts(versionId: string, nodeCount: number, edgeCount: number): Promise<void> {
    const client = this.getClient();
    const { error } = await client.from('repo_versions').update({ node_count: nodeCount, edge_count: edgeCount }).eq('id', versionId);
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

    const { data: nodesData, error: nodesError } = await client
      .from('code_nodes')
      .select('id, stable_id, name, node_type, file_path, start_line, github_link')
      .eq('version_id', versionId);
    if (nodesError) {
      throw new Error(`Failed to fetch nodes: ${nodesError.message}`);
    }

    const { data: edgesData, error: edgesError } = await client
      .from('code_edges')
      .select('source_node_id, target_node_id, edge_type')
      .eq('version_id', versionId);
    if (edgesError) {
      throw new Error(`Failed to fetch edges: ${edgesError.message}`);
    }

    const nodes: GraphNode[] = (nodesData || []).map((node) => ({
      id: node.id,
      label: node.name,
      type: node.node_type,
      filePath: node.file_path,
      line: node.start_line,
      githubLink: node.github_link,
    }));

    const edges: GraphEdge[] = (edgesData || []).map((edge) => ({
      source: edge.source_node_id,
      target: edge.target_node_id,
      type: edge.edge_type,
    }));

    return { nodes, edges };
  }

  async getAllVersionsForWorkspace(workspaceSlug: string): Promise<Array<{ version: RepoVersion; repo: Repo }>> {
    const client = this.getClient();

    const { data: workspace, error: wsError } = await client
      .from('workspaces')
      .select('id')
      .eq('slug', workspaceSlug)
      .single();
    if (wsError || !workspace) {
      return [];
    }

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

