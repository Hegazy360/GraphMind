/**
 * The CLI as an OAuth client of a Jack server — what `jack tools`, `jack
 * call` and `jack login` use when the server asks for sign-in. It is a
 * native app per RFC 8252: a loopback redirect on 127.0.0.1 (random port),
 * PKCE, DCR registration (the CLI has no public URL to host a CIMD
 * document), and tokens cached per server in ~/.jack/mcp-auth.json (0600).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';

interface Entry {
  client?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
}

export function credentialFile(env: Record<string, string | undefined> = process.env): string {
  return join(env.JACK_HOME ?? join(homedir(), '.jack'), 'mcp-auth.json');
}

function readAll(path: string): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>;
  } catch {
    return {};
  }
}

function writeAll(path: string, data: Record<string, Entry>) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function forgetServer(serverUrl: string, path = credentialFile()): Entry | undefined {
  const all = readAll(path);
  const entry = all[serverUrl];
  delete all[serverUrl];
  if (existsSync(path)) writeAll(path, all);
  return entry;
}

export type UrlOpener = (url: string) => void | Promise<void>;

/** Open the system browser; prints the URL either way so headless use still works. */
export const openInBrowser: UrlOpener = (url) => {
  if (process.env.JACK_NO_BROWSER) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser available: the printed URL is the fallback.
  }
};

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Signed in</title><body style="font:16px system-ui;padding:40px"><h2>Signed in to Jack</h2><p>You can close this tab and return to the terminal.</p>`;
const FAIL_PAGE = (why: string) =>
  `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font:16px system-ui;padding:40px"><h2>Sign-in failed</h2><p>${why.replace(/[<>&"]/g, '')}</p>`;

export class CliOAuthProvider implements OAuthClientProvider {
  private verifier = '';
  private expectedState = '';
  private server: Server | null = null;
  private port = 0;
  private waiter: { resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | null = null;
  /** A callback that arrived before anyone waited (fast browsers, cached IdP sessions). */
  private early: { params?: URLSearchParams; error?: Error } | null = null;
  /** Set when the SDK asked us to send the user to the authorization server. */
  authorizationUrl: URL | null = null;

  constructor(
    private readonly serverUrl: string,
    private readonly opener: UrlOpener,
    private readonly announce: (line: string) => void,
    private readonly path = credentialFile(),
  ) {}

  /** Bind the loopback redirect before the flow starts (its port is part of redirect_uri). */
  async listen(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      // The SDK checks `iss`; `state` is ours to check (it ties the callback to THIS attempt).
      const ok = params.get('state') === this.expectedState && this.expectedState !== '';
      const error = params.get('error');
      res.writeHead(ok && !error ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ok && !error ? DONE_PAGE : FAIL_PAGE(error ? `${error}: ${params.get('error_description') ?? ''}` : 'the response did not match this sign-in'));
      const outcome = !ok
        ? { error: new Error('sign-in response did not match this attempt (state mismatch)') }
        : error
          ? { error: new Error(`sign-in was not completed: ${error}${params.get('error_description') ? ` — ${params.get('error_description')}` : ''}`) }
          : { params };
      if (!this.waiter) {
        this.early = outcome;
        return;
      }
      if (outcome.error) this.waiter.reject(outcome.error);
      else this.waiter.resolve(outcome.params!);
      this.waiter = null;
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  /** Resolves with the callback's query once the user finishes in the browser. */
  waitForCallback(timeoutMs = 5 * 60_000): Promise<URLSearchParams> {
    if (this.early) {
      const { params, error } = this.early;
      this.early = null;
      return error ? Promise.reject(error) : Promise.resolve(params!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the browser sign-in')), timeoutMs);
      timer.unref();
      this.waiter = {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  get redirectUrl() {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata() {
    return {
      client_name: 'Jack CLI',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    this.expectedState = randomBytes(16).toString('base64url');
    return this.expectedState;
  }

  private entry(): Entry {
    return readAll(this.path)[this.serverUrl] ?? {};
  }
  private save(patch: Entry) {
    const all = readAll(this.path);
    all[this.serverUrl] = { ...all[this.serverUrl], ...patch };
    writeAll(this.path, all);
  }

  clientInformation() {
    return this.entry().client as never;
  }
  saveClientInformation(info: unknown) {
    this.save({ client: info as Record<string, unknown> });
  }
  tokens() {
    return this.entry().tokens as never;
  }
  saveTokens(tokens: unknown) {
    this.save({ tokens: tokens as Record<string, unknown> });
  }
  async redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
    this.announce('');
    this.announce('  Sign in to continue. Opening your browser — or open this URL:');
    this.announce(`  ${url.href}`);
    this.announce('');
    await this.opener(url.href);
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}
