import * as vscode from 'vscode';

const AUTH_SESSION_KEY = 'monoid.supabaseSession';

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user?: {
    id: string;
    email?: string;
    user_metadata?: {
      avatar_url?: string;
      full_name?: string;
      user_name?: string;
    };
  };
}

export class AuthService {
  private context: vscode.ExtensionContext;
  private sessionChangeEmitter = new vscode.EventEmitter<SupabaseSession | null>();
  
  public readonly onSessionChange = this.sessionChangeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Get the stored Supabase session
   */
  async getSession(): Promise<SupabaseSession | null> {
    const sessionJson = await this.context.secrets.get(AUTH_SESSION_KEY);
    if (!sessionJson) {
      return null;
    }

    try {
      const session = JSON.parse(sessionJson) as SupabaseSession;
      
      // Check if session is expired
      if (session.expires_at && session.expires_at < Date.now() / 1000) {
        console.log('[Auth] Session expired, clearing');
        await this.clearSession();
        return null;
      }
      
      return session;
    } catch (e) {
      console.error('[Auth] Failed to parse session:', e);
      return null;
    }
  }

  /**
   * Store a Supabase session
   */
  async setSession(session: SupabaseSession): Promise<void> {
    await this.context.secrets.store(AUTH_SESSION_KEY, JSON.stringify(session));
    this.sessionChangeEmitter.fire(session);
    console.log('[Auth] Session stored successfully');
  }

  /**
   * Clear the stored session
   */
  async clearSession(): Promise<void> {
    await this.context.secrets.delete(AUTH_SESSION_KEY);
    this.sessionChangeEmitter.fire(null);
    console.log('[Auth] Session cleared');
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const session = await this.getSession();
    return session !== null;
  }

  /**
   * Handle URI callback from OAuth flow
   * Expected URI format: vscode://monoid.monoid-visualize/auth/callback?session=<base64-encoded-session>
   */
  async handleAuthCallback(uri: vscode.Uri): Promise<boolean> {
    console.log('[Auth] Handling auth callback:', uri.toString());
    
    const query = new URLSearchParams(uri.query);
    const sessionParam = query.get('session');
    
    if (!sessionParam) {
      console.error('[Auth] No session in callback');
      vscode.window.showErrorMessage('Authentication failed: No session received');
      return false;
    }

    try {
      // Decode base64 session
      const sessionJson = Buffer.from(sessionParam, 'base64').toString('utf-8');
      const session = JSON.parse(sessionJson) as SupabaseSession;
      
      await this.setSession(session);
      
      vscode.window.showInformationMessage('Successfully signed in to Monoid!');
      return true;
    } catch (e) {
      console.error('[Auth] Failed to process auth callback:', e);
      vscode.window.showErrorMessage('Authentication failed: Invalid session data');
      return false;
    }
  }

  /**
   * Start the authentication flow by opening the dashboard login page
   */
  async startAuthFlow(): Promise<void> {
    const config = vscode.workspace.getConfiguration('monoid-visualize');
    const webAppUrl = config.get<string>('webAppUrl') || 'https://monoid-dashboard.vercel.app';
    
    // Open the login page with a flag indicating it's from VS Code
    const loginUrl = `${webAppUrl}/login?from=vscode`;
    
    vscode.env.openExternal(vscode.Uri.parse(loginUrl));
    vscode.window.showInformationMessage(
      'Opening browser to sign in. After signing in, click "Connect to VS Code" to complete authentication.'
    );
  }

  /**
   * Manually set session from a base64-encoded string (for development/debugging)
   * This is useful when running in Extension Development Host where URI handlers don't work
   */
  async setSessionFromBase64(base64Session: string): Promise<boolean> {
    try {
      const sessionJson = Buffer.from(base64Session, 'base64').toString('utf-8');
      const session = JSON.parse(sessionJson) as SupabaseSession;
      
      await this.setSession(session);
      vscode.window.showInformationMessage('Successfully signed in to Monoid!');
      return true;
    } catch (e) {
      console.error('[Auth] Failed to parse base64 session:', e);
      vscode.window.showErrorMessage('Invalid session data. Please copy the full session token.');
      return false;
    }
  }

  /**
   * Sign out - clear session
   */
  async signOut(): Promise<void> {
    await this.clearSession();
    vscode.window.showInformationMessage('Signed out of Monoid');
  }

  /**
   * Get session info for display
   */
  async getSessionInfo(): Promise<{ userName?: string; email?: string; avatarUrl?: string } | null> {
    const session = await this.getSession();
    if (!session?.user) {
      return null;
    }

    return {
      userName: session.user.user_metadata?.user_name || session.user.user_metadata?.full_name,
      email: session.user.email,
      avatarUrl: session.user.user_metadata?.avatar_url,
    };
  }
}

// Singleton instance
let authServiceInstance: AuthService | null = null;

export function initAuthService(context: vscode.ExtensionContext): AuthService {
  authServiceInstance = new AuthService(context);
  return authServiceInstance;
}

export function getAuthService(): AuthService {
  if (!authServiceInstance) {
    throw new Error('AuthService not initialized. Call initAuthService first.');
  }
  return authServiceInstance;
}
