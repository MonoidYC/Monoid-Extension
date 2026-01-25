import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GitHubInfo {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Get GitHub owner and repo from git remote URL
 * Parses URLs like:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo
 */
export async function getGitHubInfoFromGit(workspacePath: string): Promise<GitHubInfo | null> {
  try {
    // Get the remote URL
    const { stdout: remoteUrl } = await execAsync('git remote get-url origin', { cwd: workspacePath });
    const url = remoteUrl.trim();
    
    // Parse GitHub URL
    let owner: string | null = null;
    let repo: string | null = null;
    
    // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
    const httpsMatch = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (httpsMatch) {
      owner = httpsMatch[1];
      repo = httpsMatch[2].replace(/\.git$/, '');
    }
    
    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^\/]+)\/([^\/\.]+)/);
    if (sshMatch) {
      owner = sshMatch[1];
      repo = sshMatch[2].replace(/\.git$/, '');
    }
    
    if (!owner || !repo) {
      console.log('[Monoid] Could not parse GitHub URL from remote:', url);
      return null;
    }
    
    // Get current branch
    let branch = 'main';
    try {
      const { stdout: branchOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: workspacePath });
      branch = branchOutput.trim();
    } catch {
      // Fallback to main
    }
    
    console.log(`[Monoid] Detected GitHub repo: ${owner}/${repo} (branch: ${branch})`);
    return { owner, repo, branch };
  } catch (error) {
    console.log('[Monoid] Not a git repository or no remote configured');
    return null;
  }
}
