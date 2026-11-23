/**
 * One Microsoft sign-in per Synapse process, held in memory and lent to stdio services.
 *
 * A Graph plane started with MCP_GRAPH_TOKEN_BROKER=1 does not run its own MSAL client. It
 * asks its parent for tokens with the JSON-RPC request `x-mcp-graph/token` over the same
 * stdio pipe it speaks MCP on, and Synapse answers from this session. So the person signs
 * in once for every plane, and nothing is written to disk: the session ends with the process,
 * and an earlier session's account can never answer for this one.
 *
 * The wire contract (method names, params, result) is the one in microsoft-graph-mcp-servers'
 * `mcp_shared/src/token-broker.ts`, which is the child side of it.
 *
 * The session is bound to the gateway's TENANT_ID: an account from any other directory is
 * dropped as soon as the sign-in returns. Only Microsoft Graph delegated scopes are lent.
 */
import { spawn } from 'node:child_process';

export const TOKEN_BROKER_ENV = 'MCP_GRAPH_TOKEN_BROKER';
/** The tenant a plane must be configured for; it refuses to start otherwise. */
export const EXPECTED_TENANT_ENV = 'GATEWAY_EXPECTED_TENANT_ID';
export const TOKEN_METHOD = 'x-mcp-graph/token';
export const SIGN_OUT_METHOD = 'x-mcp-graph/sign-out';
/** Microsoft Graph Command Line Tools, the multi-tenant public client `clientId: wellknown` names. */
export const WELL_KNOWN_GRAPH_CLI_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
/** How long a write sign-in lasts at most. It is a step-up, not a session. */
export const WRITE_SESSION_MAX_AGE_MS = 15 * 60_000;

/** A token is refreshed this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface BrokeredToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresOn: number;
}

export interface MsalAccountLike {
  readonly tenantId?: string;
  readonly homeAccountId?: string;
  readonly username?: string;
}

export interface MsalResultLike {
  readonly accessToken: string;
  readonly expiresOn: Date | null;
  readonly account: MsalAccountLike | null;
}

/** The slice of msal-node's PublicClientApplication used here. Built with NO cache plugin. */
export interface MsalLike {
  acquireTokenSilent(request: { account: never; scopes: string[] }): Promise<MsalResultLike | null>;
  acquireTokenInteractive(request: {
    scopes: string[];
    openBrowser: (url: string) => Promise<void>;
    prompt?: never;
  }): Promise<MsalResultLike | null>;
  getTokenCache(): {
    getAllAccounts(): Promise<MsalAccountLike[]>;
    removeAccount(account: never): Promise<void>;
  };
}

export interface MemorySessionOptions {
  readonly msal: MsalLike;
  readonly tenantId: string;
  readonly maxSessionAgeMs: number;
  readonly openBrowser: (url: string) => Promise<void>;
  /** msal-node's `PromptValue.SELECT_ACCOUNT`, so a browser signed in elsewhere is never reused silently. */
  readonly selectAccountPrompt: string;
  readonly signInScopes?: readonly string[];
  readonly now?: () => number;
}

export interface MemorySession {
  getToken(scopes: readonly string[]): Promise<BrokeredToken>;
  /** Sign in now if nobody has, so the browser opens before a call starts its timer. */
  ensureSignedIn(): Promise<void>;
  signOut(): Promise<void>;
  isSignedIn(): boolean;
}

const OIDC_SCOPES = new Set(['openid', 'profile', 'offline_access', 'email']);
const GRAPH_RESOURCE = 'https://graph.microsoft.com/';
const GRAPH_SCOPE_NAME = /^[A-Za-z]+(?:\.[A-Za-z]+)+$/;

/**
 * Only Microsoft Graph delegated scopes. Another audience, or `.default` (every scope ever
 * consented), is refused, so a child cannot use the session as a skeleton key.
 */
export function assertGraphScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('Token request names no scopes.');
  return scopes.map((scope) => {
    if (typeof scope !== 'string') throw new Error('Token request scopes must be strings.');
    const name = scope.startsWith(GRAPH_RESOURCE) ? scope.slice(GRAPH_RESOURCE.length) : scope;
    if (OIDC_SCOPES.has(name) || GRAPH_SCOPE_NAME.test(name)) return scope;
    throw new Error(`The token broker only lends Microsoft Graph delegated scopes; refused "${scope}".`);
  });
}

const sameTenant = (a: string | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

export function createMemorySession(options: MemorySessionOptions): MemorySession {
  const now = options.now ?? Date.now;
  const signInScopes = [...(options.signInScopes ?? ['User.Read'])];
  let account: MsalAccountLike | null = null;
  let signedInAt: number | null = null;
  // One browser at a time: several planes asking at once must not open several windows.
  let interactive: Promise<MsalResultLike> | null = null;

  const expired = () => signedInAt !== null && now() - signedInAt > options.maxSessionAgeMs;

  const forget = async (): Promise<void> => {
    const cache = options.msal.getTokenCache();
    for (const acct of await cache.getAllAccounts()) await cache.removeAccount(acct as never);
    account = null;
    signedInAt = null;
  };

  const toToken = (result: MsalResultLike): BrokeredToken => ({
    accessToken: result.accessToken,
    expiresOn: result.expiresOn?.getTime() ?? now() + REFRESH_MARGIN_MS,
  });

  const signIn = (scopes: string[]): Promise<MsalResultLike> => {
    interactive ??= (async () => {
      try {
        const result = await options.msal.acquireTokenInteractive({
          scopes,
          openBrowser: options.openBrowser,
          prompt: options.selectAccountPrompt as never,
        });
        if (!result?.accessToken || !result.account) {
          throw new Error('Interactive sign-in did not return an account and token.');
        }
        if (!sameTenant(result.account.tenantId, options.tenantId)) {
          await forget();
          throw new Error(
            `Signed in to tenant ${result.account.tenantId ?? 'unknown'}, but this gateway is bound to ${options.tenantId}. `
            + 'Nothing was kept; sign in with an account from the bound tenant.',
          );
        }
        account = result.account;
        signedInAt = now();
        return result;
      } finally {
        interactive = null;
      }
    })();
    return interactive;
  };

  const getToken = async (requested: readonly string[]): Promise<BrokeredToken> => {
    const scopes = assertGraphScopes(requested);
    if (account && expired()) await forget();
    if (interactive) await interactive.catch(() => undefined);
    if (account) {
      const silent = await options.msal.acquireTokenSilent({ account: account as never, scopes }).catch(() => null);
      if (silent?.accessToken) return toToken(silent);
    }
    return toToken(await signIn(scopes));
  };

  return {
    getToken,
    async ensureSignedIn() {
      if (!account || expired()) await getToken(signInScopes);
    },
    signOut: forget,
    isSignedIn: () => account !== null,
  };
}

export interface BrokerSessions {
  /** The session belongs to the machine's sign-in holder: stopping Synapse must not end it. */
  readonly shared?: boolean;
  /** Opened at the first call to a signed-in service. */
  readonly read: MemorySession;
  /** The write client's step-up session. Absent: writes share the read session. */
  readonly write?: MemorySession;
}

/** Answer one token request. Errors carry a message the plane can show, never a token. */
export async function answerTokenRequest(sessions: BrokerSessions, params: unknown): Promise<BrokeredToken> {
  const { scopes, access } = (params ?? {}) as { scopes?: unknown; access?: unknown };
  // Anything but an explicit 'write' is a read.
  const session = access === 'write' ? (sessions.write ?? sessions.read) : sessions.read;
  const token = await session.getToken(scopes as readonly string[]);
  return { accessToken: token.accessToken, expiresOn: token.expiresOn };
}

export async function signOutAll(sessions: BrokerSessions): Promise<void> {
  await Promise.all([sessions.read.signOut(), sessions.write?.signOut()]);
}

/** Open the system browser without a shell, so a URL can never become a command. */
export async function openSystemBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  await new Promise<void>((resolve) => {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.once('error', () => {
      // The sign-in URL is not a secret: it carries no token, only the request.
      process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'warn', message: 'Open this URL to sign in', url })}\n`);
      resolve();
    });
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export interface SignInOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly writeClientId?: string | undefined;
  readonly maxSessionAgeMs: number;
}

/** Real MSAL sessions, built only when a service asks for sign-in. */
export async function createSignInSessions(options: SignInOptions): Promise<BrokerSessions> {
  const { PromptValue, PublicClientApplication } = await import('@azure/msal-node');
  const session = (clientId: string, maxSessionAgeMs: number) => createMemorySession({
    msal: new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${options.tenantId}`,
        // Continuous access evaluation, as the planes' own providers request.
        clientCapabilities: ['cp1'],
      },
    }) as unknown as MsalLike,
    tenantId: options.tenantId,
    maxSessionAgeMs,
    openBrowser: openSystemBrowser,
    selectAccountPrompt: PromptValue.SELECT_ACCOUNT,
  });
  return {
    read: session(options.clientId, options.maxSessionAgeMs),
    ...(options.writeClientId
      ? { write: session(options.writeClientId, Math.min(options.maxSessionAgeMs, WRITE_SESSION_MAX_AGE_MS)) }
      : {}),
  };
}
