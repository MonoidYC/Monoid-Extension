## Monoid Visualize – VS Code extension

Monoid Visualize turns your JavaScript/TypeScript project into an interactive code graph backed by Supabase, then opens a Next.js dashboard to explore it.

### What it does

- **Analyze workspace**: walks the current VS Code workspace, extracting functions, classes, components, endpoints, hooks, etc. into `code_nodes` and `code_edges`.
- **Persist to Supabase**: writes into a shared Postgres schema (`workspaces`, `repos`, `repo_versions`, `code_nodes`, `code_edges`).
- **Open dashboard webview**: opens the Monoid dashboard for the new `repo_versions.id` in a VS Code webview (`/graph/[versionId]`).
- **Optional LLM enrichment**: with a Gemini API key + opt-in setting, adds summaries/snippets and extra API relationship edges.

The primary flow:

1. Open any project in VS Code.
2. Run the command **“Monoid: Visualize All Code”**.
3. Wait for analysis + Supabase sync.
4. A webview opens showing the graph in the dashboard.

### Extension settings

All settings live under `monoid-visualize`:

- **Supabase connection**
  - `monoid-visualize.supabaseUrl` (string)  
    Supabase URL. Defaults to a shared **public demo** instance.
  - `monoid-visualize.supabaseAnonKey` (string)  
    Supabase anon key. Also defaults to the public demo key.

- **Dashboard URL**
  - `monoid-visualize.webAppUrl` (string)  
    URL for the Monoid dashboard. Use your deployed dashboard or `http://localhost:3000` during local development.

- **GitHub metadata (optional)**
  - `monoid-visualize.githubOwner` (string)  
    Fallback owner if git remote parsing fails.
  - `monoid-visualize.githubRepo` (string)  
    Fallback repo name.
  - `monoid-visualize.githubBranch` (string, default `"main"`)  
    Branch used when generating GitHub permalinks.

- **LLM enrichment (optional, OFF by default)**
  - `monoid-visualize.geminiApiKey` (string)  
    Your Google Gemini API key.
  - `monoid-visualize.geminiModel` (string, default `"gemini-3-flash-preview"`)  
    Model name to use.
  - `monoid-visualize.enableLlmEnrichment` (boolean, default `false`)  
    When `true` and `geminiApiKey` is set:
    - `geminiSummarizer` generates summaries/snippets for nodes.
    - `LLMAnalyzer` adds extra API relationship edges.

No LLM calls are made unless you explicitly set a key **and** enable `enableLlmEnrichment`.

### Supabase schema (high level)

Graph tables written by the extension:

- `workspaces` – one row per VS Code workspace.
- `repos` – one row per repo (linked to `workspaces` + `organizations`).
- `repo_versions` – one row per visualization run (commit SHA + counts).
- `code_nodes` – individual code elements (functions, components, endpoints, etc.).
- `code_edges` – relationships like `calls`, `imports`, `depends_on`, etc.

Docs tables used by the dashboard:

- `organizations` – groups repos for the homepage/docs.
- `org_docs` – markdown docs that can deep-link into graph nodes.

For exact columns and RLS details, see `monoid_graph_schema_2904a02a.plan.md`.

### Demo vs. self-hosted Supabase

The extension ships with a **public demo** Supabase URL/anon key baked in so it works out-of-the-box.

For serious usage:

1. Create your own Supabase project.
2. Apply the schema described in `monoid_graph_schema_2904a02a.plan.md` (plus `organizations`/`org_docs`).
3. Set in VS Code:
   - `monoid-visualize.supabaseUrl` → your project URL.
   - `monoid-visualize.supabaseAnonKey` → your anon key.

The extension always uses the anon key only (no service-role keys).

For the public demo, RLS is disabled on:

- `workspaces`
- `repos`
- `repo_versions`
- `code_nodes`
- `code_edges`
- `organizations`
- `org_docs`

so that both extension and dashboard can read/write using only the anon key.

### Running the full stack locally

1. Clone both repos:
   - `monoid-visualize` – this VS Code extension.
   - `Monoid-dashboard` – the Next.js dashboard.
2. In `Monoid-dashboard`:
   - Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (demo or your own).
   - Run `npm install` and `npm run dev`.
3. In `monoid-visualize`:
   - Run `npm install`.
   - Press `F5` in VS Code to start an “Extension Development Host”.
4. In the dev host:
   - Set `monoid-visualize.webAppUrl` → `http://localhost:3000`.
   - Optionally point Supabase settings to your own project.
5. Open any codebase and run **“Monoid: Visualize All Code”**.

You should see a new `repo_versions` row, `code_nodes`/`code_edges` filled in, and the dashboard graph view loading inside VS Code.

