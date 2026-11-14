/**
 * "Test sign-in" and "Try it" for the dashboard.
 *
 * Nothing is simulated: the dashboard registers itself with the project's
 * own authorization server (DCR), sends the operator through the REAL
 * sign-in and consent pages, exchanges the code with PKCE, and then calls
 * tools through the project's live /mcp endpoint with the official MCP
 * client. If "Try it" works, an AI client will work the same way.
 *
 * Test sessions live in memory (per server process) and are per project.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PROTOCOL_VERSION, type Project } from '@graphmind-ai/jack-schema';
import { issuerFor, mcpUrlFor, type DataPlane } from './data-plane.js';

type InternalFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface Session {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  clientId: string;
  grantId: string | null;
}

export interface TryResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError: boolean;
  /** The tool asked for approval (confirm: true) and how it was answered. */
  approval: 'not-needed' | 'approved' | 'declined';
  as: string | null;
  ms: number;
}

export class ConsoleError extends Error {
  override name = 'ConsoleError';
}

const b64 = (n = 32) => randomBytes(n).toString('base64url');

export class TestConsole {
  private readonly clients = new Map<string, string>();
  private readonly pending = new Map<string, { projectId: string; slug: string; verifier: string; clientId: string; expires: number }>();
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly origin: string,
    private readonly plane: DataPlane,
  ) {}

  private readonly internal: InternalFetch = async (url, init) => {
    const res = await this.plane.handle(new Request(url, init));
    return res ?? new Response('not found', { status: 404 });
  };

  get callbackUrl() {
    return `${this.origin}/dashboard/callback`;
  }

  private async clientFor(project: Project): Promise<string> {
    const known = this.clients.get(project.id);
    if (known) return known;
    const res = await this.internal(`${issuerFor(this.origin, project.slug)}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Jack dashboard (test sign-in)', redirect_uris: [this.callbackUrl], token_endpoint_auth_method: 'none' }),
    });
    if (!res.ok) throw new ConsoleError(`could not register the dashboard with this project's sign-in (HTTP ${res.status})`);
    const { client_id } = (await res.json()) as { client_id: string };
    this.clients.set(project.id, client_id);
    return client_id;
  }

  /** Begin a test sign-in: the URL to send the operator's browser to. */
  async start(project: Project): Promise<string> {
    const clientId = await this.clientFor(project);
    const verifier = b64(48);
    const state = b64(18);
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    this.pending.set(state, { projectId: project.id, slug: project.slug, verifier, clientId, expires: now + 10 * 60_000 });
    const u = new URL(`${issuerFor(this.origin, project.slug)}/oauth/authorize`);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.callbackUrl,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: mcpUrlFor(this.origin, project.slug),
      state,
    }).toString();
    return u.href;
  }

  /** The browser came back. Returns the project id to send the operator back to. */
  async finish(params: URLSearchParams): Promise<{ projectId: string; error?: string }> {
    const state = params.get('state') ?? '';
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new ConsoleError('this test sign-in expired or was already used; start it again');
    if (params.get('iss') && params.get('iss') !== issuerFor(this.origin, p.slug)) throw new ConsoleError('sign-in response came from the wrong issuer');
    if (params.get('error')) return { projectId: p.projectId, error: params.get('error_description') ?? params.get('error') ?? 'sign-in failed' };
    const res = await this.internal(`${issuerFor(this.origin, p.slug)}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.get('code') ?? '',
        code_verifier: p.verifier,
        redirect_uri: this.callbackUrl,
        client_id: p.clientId,
        resource: mcpUrlFor(this.origin, p.slug),
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { projectId: p.projectId, error: String(body.error_description ?? body.error ?? `HTTP ${res.status}`) };
    this.save(p.projectId, p.clientId, body);
    return { projectId: p.projectId };
  }

  private save(projectId: string, clientId: string, body: Record<string, unknown>) {
    const accessToken = String(body.access_token);
    let grantId: string | null = null;
    try {
      grantId = String(JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')).grant_id ?? '') || null;
    } catch {
      grantId = null;
    }
    this.sessions.set(projectId, {
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: Date.now() + Number(body.expires_in ?? 0) * 1000,
      clientId,
      grantId,
    });
  }

  /** Who the test session is signed in as (null if none, or it was revoked). */
  whoami(project: Project): { signedIn: boolean; as: string | null } {
    const s = this.sessions.get(project.id);
    if (!s) return { signedIn: false, as: null };
    const grant = this.plane.grants(project).find((g) => g.id === s.grantId);
    if (!grant || grant.revokedAt !== null) {
      this.sessions.delete(project.id);
      return { signedIn: false, as: null };
    }
    return { signedIn: true, as: grant.display };
  }

  signOut(projectId: string) {
    this.sessions.delete(projectId);
  }

  private async token(project: Project): Promise<string | null> {
    const s = this.sessions.get(project.id);
    if (!s) return null;
    if (s.expiresAt - Date.now() > 30_000) return s.accessToken;
    if (!s.refreshToken) return null;
    const res = await this.internal(`${issuerFor(this.origin, project.slug)}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId }).toString(),
    });
    if (!res.ok) {
      this.sessions.delete(project.id);
      return null;
    }
    this.save(project.id, s.clientId, (await res.json()) as Record<string, unknown>);
    return this.sessions.get(project.id)!.accessToken;
  }

  /** Call one tool through the live /mcp endpoint, as the test session's user. */
  async tryTool(project: Project, tool: string, args: Record<string, unknown>, approve: boolean): Promise<TryResult> {
    const mode = this.plane.bundle(project).mode;
    const token = mode === 'sign-in' ? await this.token(project) : null;
    if (mode === 'sign-in' && !token) throw new ConsoleError('sign in first: this project requires sign-in (use "Test sign-in")');
    let approval: TryResult['approval'] = 'not-needed';
    const client = new Client(
      { name: 'jack-dashboard', version: '0.0.1' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
    );
    client.setRequestHandler('elicitation/create', async () => {
      approval = approve ? 'approved' : 'declined';
      return approve ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrlFor(this.origin, project.slug)), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        if (token) headers.set('authorization', `Bearer ${token}`);
        return this.internal(String(url), { ...init, headers });
      },
    });
    const started = Date.now();
    try {
      await client.connect(transport);
      const r = (await client.callTool({ name: tool, arguments: args })) as { content?: TryResult['content']; structuredContent?: unknown; isError?: boolean };
      return {
        content: r.content ?? [],
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
        isError: r.isError === true,
        approval,
        as: this.whoami(project).as,
        ms: Date.now() - started,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|403/.test(msg)) {
        this.sessions.delete(project.id);
        throw new ConsoleError('the test sign-in is no longer valid (expired or revoked); sign in again');
      }
      throw new ConsoleError(`the call failed: ${msg.split('\n')[0]}`);
    } finally {
      await client.close().catch(() => {});
    }
  }
}
