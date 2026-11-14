/**
 * `jack tools` / `jack call` — a terminal test console for any Jack MCP
 * server (a running preview by default). Uses the official MCP client
 * pinned to 2026-07-28, so it exercises exactly what an AI client would,
 * including MRTR confirmations.
 */
import { createInterface } from 'node:readline/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CliOAuthProvider, credentialFile, forgetServer, openInBrowser, type UrlOpener } from './oauth.js';
import { PROTOCOL_VERSION } from '@graphmind-ai/jack-schema';
import type { Io } from './commands.js';
import { DEFAULT_PREVIEW_PORT } from './preview.js';

export const DEFAULT_MCP_URL = `http://127.0.0.1:${DEFAULT_PREVIEW_PORT}/mcp`;

/** How to answer a confirmation the server asks for. */
export type ConfirmMode = 'prompt' | 'yes' | 'no';

export interface ClientOptions {
  url?: string;
  confirm?: ConfirmMode;
  /** For tests: route requests without a socket. */
  fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** For tests: answer prompts without a TTY. */
  ask?: (question: string) => Promise<string>;
  /** How to show the sign-in page (default: the system browser). */
  openUrl?: UrlOpener;
  /** Where cached sign-ins live (default ~/.jack/mcp-auth.json, or $JACK_HOME). */
  credentialsPath?: string;
  /** How long to wait for the browser sign-in (default 5 minutes). */
  signInTimeoutMs?: number;
}

async function askOnTty(question: string): Promise<string> {
  if (!process.stdin.isTTY) return 'n';
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function connectClient(opts: ClientOptions, io: Io): Promise<Client> {
  const client = new Client(
    { name: 'jack-cli', version: '0.0.1' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  client.setRequestHandler('elicitation/create', async (req) => {
    const params = (req as { params: { message: string } }).params;
    const mode = opts.confirm ?? 'prompt';
    io.err('');
    io.err(`? ${params.message.replaceAll('\n', '\n  ')}`);
    let ok: boolean;
    if (mode === 'yes') {
      io.err('  → approved (--yes)');
      ok = true;
    } else if (mode === 'no') {
      io.err('  → declined (--no)');
      ok = false;
    } else {
      const answer = await (opts.ask ?? askOnTty)('  Approve? [y/N] ');
      ok = /^y(es)?$/i.test(answer.trim());
      if (!process.stdin.isTTY && opts.ask === undefined) io.err('  → declined (no terminal to ask; pass --yes to approve)');
    }
    return ok ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
  });
  const url = new URL(opts.url ?? DEFAULT_MCP_URL);
  const provider = new CliOAuthProvider(url.href, opts.openUrl ?? openInBrowser, io.err, opts.credentialsPath ?? credentialFile());
  await provider.listen();
  const transport = () =>
    new StreamableHTTPClientTransport(url, { authProvider: provider, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) });
  const fail = (err: unknown): never => {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`could not connect to ${url.href} (${why.split('\n')[0]}). Is \`jack preview\` running?`);
  };
  try {
    let t = transport();
    try {
      await client.connect(t);
    } catch (err) {
      // The server wants sign-in and the SDK has sent the user to the browser: wait for them.
      if (!provider.authorizationUrl) fail(err);
      const params = await provider.waitForCallback(opts.signInTimeoutMs);
      await t.finishAuth(params);
      io.err('  ✓ signed in');
      t = transport();
      await client.connect(t);
    }
    return client;
  } finally {
    await provider.close();
  }
}

/** `jack login`: sign in (or confirm an existing sign-in) and report who the server sees. */
export async function loginCommand(opts: ClientOptions, io: Io): Promise<number> {
  const client = await connectClient(opts, io);
  try {
    const { tools } = await client.listTools();
    io.out(`signed in to ${opts.url ?? DEFAULT_MCP_URL} — ${tools.length} tools available`);
    return 0;
  } finally {
    await client.close();
  }
}

/** `jack logout`: revoke the refresh token at the server (best effort) and forget it locally. */
export async function logoutCommand(opts: ClientOptions, io: Io): Promise<number> {
  const url = new URL(opts.url ?? DEFAULT_MCP_URL);
  const entry = forgetServer(url.href, opts.credentialsPath ?? credentialFile());
  const refresh = (entry?.tokens as { refresh_token?: string } | undefined)?.refresh_token;
  if (!entry) {
    io.out(`not signed in to ${url.href}`);
    return 0;
  }
  if (refresh) {
    const f = opts.fetchImpl ?? fetch;
    try {
      const meta = (await (await f(new URL('/.well-known/oauth-authorization-server', url.origin))).json()) as { revocation_endpoint?: string };
      if (meta.revocation_endpoint) {
        await f(meta.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refresh, token_type_hint: 'refresh_token' }).toString(),
        });
      }
    } catch {
      io.err('  (could not reach the server to revoke; the local sign-in was removed anyway)');
    }
  }
  io.out(`signed out of ${url.href}`);
  return 0;
}

export async function toolsCommand(opts: ClientOptions, io: Io): Promise<number> {
  const client = await connectClient(opts, io);
  try {
    const { tools } = await client.listTools();
    io.out(`${tools.length} tools at ${opts.url ?? DEFAULT_MCP_URL}`);
    io.out('');
    for (const t of tools) {
      const a = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
      const tag = a.readOnlyHint ? 'read' : a.destructiveHint ? 'DESTRUCTIVE' : 'writes';
      const props = Object.keys(((t.inputSchema as { properties?: object }).properties ?? {}) as object);
      const required = new Set(((t.inputSchema as { required?: string[] }).required ?? []) as string[]);
      const args = props.map((p) => (required.has(p) ? p : `${p}?`)).join(', ');
      io.out(`  ${t.name}(${args})  [${tag}]`);
      io.out(`    ${(t.description ?? '').split('\n')[0]}`);
    }
    return 0;
  } finally {
    await client.close();
  }
}

export async function callCommand(tool: string | undefined, argsJson: string | undefined, opts: ClientOptions, io: Io): Promise<number> {
  if (tool === undefined) {
    io.err('jack call needs a tool name: jack call <tool> [--args \'{"key":"value"}\']');
    return 1;
  }
  let args: Record<string, unknown> = {};
  if (argsJson !== undefined) {
    try {
      const parsed = JSON.parse(argsJson) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      args = parsed as Record<string, unknown>;
    } catch {
      io.err(`--args must be a JSON object, got: ${argsJson}`);
      return 1;
    }
  }
  const client = await connectClient(opts, io);
  try {
    const result = (await client.callTool({ name: tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    for (const c of result.content ?? []) io.out(c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`);
    return result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}
