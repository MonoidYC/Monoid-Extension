// Test-related types for E2E test generation and management

export type TestStatus = 'pending' | 'passed' | 'failed' | 'skipped' | 'running';

export type TestType = 'e2e' | 'unit' | 'integration' | 'security' | 'contract' | 'smoke' | 'regression' | 'performance' | 'other';

export type SourceType = 'file' | 'generated' | 'external' | 'synced';

export type CoverageType = 'covers' | 'calls' | 'tests_endpoint';

/**
 * Local test node for analysis before saving to Supabase
 */
export interface LocalTestNode {
  stable_id: string;
  name: string;
  description?: string;
  test_type: TestType;
  source_type: SourceType;
  file_path: string;
  start_line?: number;
  end_line?: number;
  runner: string;
  command?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Test node as stored in Supabase
 */
export interface TestNode {
  id: string;
  version_id: string;
  stable_id: string;
  name: string;
  description?: string;
  test_type: TestType;
  source_type: SourceType;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  runner?: string;
  command?: string;
  last_status?: TestStatus;
  last_run_at?: string;
  last_duration_ms?: number;
  last_error?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  github_link?: string;
}

/**
 * Test coverage edge linking tests to code nodes
 */
export interface TestCoverageEdge {
  id?: string;
  version_id: string;
  test_node_id: string;
  code_node_id: string;
  coverage_type: CoverageType;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

/**
 * Local coverage edge for analysis before saving to Supabase
 */
export interface LocalTestCoverageEdge {
  test_stable_id: string;
  code_stable_id: string;
  coverage_type: CoverageType;
  metadata?: Record<string, unknown>;
}

/**
 * Test file containing multiple test cases
 */
export interface TestFile {
  filePath: string;
  fileName: string;
  tests: TestItem[];
  lastModified?: Date;
}

/**
 * Individual test item for tree view display
 */
export interface TestItem {
  id: string;
  name: string;
  description?: string;
  filePath: string;
  line?: number;
  status: TestStatus;
  duration?: number;
  error?: string;
  supabaseId?: string; // ID in test_nodes table
}

/**
 * Test execution result
 */
export interface TestResult {
  testId: string;
  status: TestStatus;
  duration: number;
  error?: string;
  startedAt: Date;
  completedAt: Date;
}

/**
 * Status update payload for Supabase
 */
export interface TestStatusUpdate {
  last_status: TestStatus;
  last_run_at: string;
  last_duration_ms?: number;
  last_error?: string | null;
  last_ran_video?: string | null;
}

/**
 * Generated test output from AI
 */
export interface GeneratedTest {
  name: string;
  description: string;
  code: string;
  coveredComponents: string[];
  coveredEndpoints: string[];
}

/**
 * Test generation context
 */
export interface TestGenerationContext {
  pageSource: string;
  pagePath: string;
  baseUrl: string;
  components?: string[];
  endpoints?: string[];
  dataTestIds?: string[];
  // New fields for code_node-based generation
  codeNode?: CodeNodeForTestGen;
  relatedNodes?: CodeNodeForTestGen[];
  endpointNodes?: CodeNodeForTestGen[];
}

/**
 * Code node with full details for test generation
 */
export interface CodeNodeForTestGen {
  id: string;
  stable_id: string;
  name: string;
  node_type: string;
  file_path: string;
  start_line: number;
  end_line: number;
  snippet?: string;
  signature?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}
