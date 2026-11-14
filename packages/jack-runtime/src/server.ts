/**
 * A Manifest served as an MCP server (protocol 2026-07-28 only).
 *
 * `createToolServerFactory` returns the factory `createMcpHandler` (HTTP)
 * or `serveStdio` call once per request / connection. The manifest can be a
 * getter so `jack preview` hot-reloads, and the hosted data plane can swap
 * deployments, without rebuilding the handler.
 *
 * Per tool call:
 *   1. the tool must exist and the caller's grant must hold its scopes;
 *   2. arguments are validated against the tool's JSON schema;
 *   3. `confirm: true` tools ask the user first (MRTR `input_required`),
 *      with the request state HMAC-signed and bound to this exact call;
 *   4. the request is built, credentials attached, and sent through the
 *      egress guard; the response is shaped for the model;
 *   5. one CallRecord is emitted — never the arguments, never credentials.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  Server,
  type AuthInfo,
  type McpServerFactory,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { Ajv, addFormats } from '@modelcontextprotocol/server/validators/ajv';
import { z } from 'zod';
import { canonicalJson, type JsonValue, type Manifest, type ToolDefinition } from '@graphmind-ai/jack-schema';
import type { EgressPolicy } from './egress.js';
import { sendUpstream, UpstreamError, type UpstreamErrorKind } from './http.js';
import { ArgumentError, buildRequest } from './request.js';
import { shapeResponse, type ToolResult } from './shape.js';

export interface CallContext {
  tool: ToolDefinition;
  /** Verified token info (M3). Absent in local preview. */
  authInfo?: AuthInfo;
}

/** Upstream credentials for one call, as headers. Never logged, never returned. */
export type CredentialResolver = (ctx: CallContext) => Record<string, string> | Promise<Record<string, string>>;

export type CallStatus = 'ok' | 'upstream_error' | 'invalid_arguments' | 'forbidden' | 'declined' | 'credentials' | UpstreamErrorKind;

/**
 * Thrown by a CredentialResolver when the user's upstream credential is gone
 * or can no longer be refreshed. The message goes to the model, so it must
 * say what the user should do — and never contain the credential.
 */
export class CredentialError extends Error {
  override name = 'CredentialError';
}

export interface CallRecord {
  tool: string;
  status: CallStatus;
  upstreamStatus?: number;
  ms: number;
  requestBytes: number;
  responseBytes: number;
  /** Who called, when known: token subject and client id. */
  subject?: string;
  clientId?: string;
}

export interface ToolServerOptions {
  manifest: Manifest | (() => Manifest);
  credentials?: CredentialResolver;
  /** Default `public`. `any` is for local preview against your own machine. */
  egress?: EgressPolicy;
  /**
   * Scopes the caller holds. Default: the verified token's scopes, or every
   * scope when there is no token (local preview has no sign-in).
   */
  scopesOf?: (authInfo: AuthInfo | undefined) => readonly string[] | 'all';
  onCall?: (record: CallRecord) => void;
  /**
   * List every tool, even those the caller's scopes don't cover (calls are
   * still refused). Used behind Jack's authorization server, which answers a
   * call needing more scopes with an HTTP 403 insufficient_scope step-up
   * challenge before the request reaches this server.
   */
  listAll?: boolean;
  /** HMAC key for MRTR request state (≥ 32 bytes). Random per process if omitted. */
  stateKey?: string | Uint8Array;
  /** Download cap per call. Default 5 MB. */
  maxResponseBytes?: number;
  /** Server version reported to clients. */
  version?: string;
}

/** Fixed-key headers, e.g. `Authorization: Bearer <key>` for apikey mode in preview. */
export function headerCredentials(headers: Record<string, string>): CredentialResolver {
  const frozen = Object.freeze({ ...headers });
  return () => frozen;
}

// No auth info at all = local preview (no sign-in). Auth info without a scopes array is malformed: no scopes.
const defaultScopes = (authInfo: AuthInfo | undefined): readonly string[] | 'all' =>
  authInfo === undefined ? 'all' : Array.isArray(authInfo.scopes) ? authInfo.scopes : [];

const allowed = (tool: ToolDefinition, held: readonly string[] | 'all') =>
  held === 'all' || tool.requiredScopes.every((s) => held.includes(s));

const errorResult = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const confirmSchema = z.object({ confirm: z.boolean() });

interface ConfirmState {
  /** sha256 of the tool name + canonical arguments: the approval covers exactly this call. */
  call: string;
}

const callFingerprint = (tool: string, args: unknown) =>
  createHash('sha256').update(`${tool}\u0000${canonicalJson(args)}`).digest('base64url');

function describeCall(tool: ToolDefinition, args: Record<string, JsonValue>): string {
  const shown = Object.entries(args)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v).slice(0, 200)}`)
    .join('\n');
  const verb = tool.annotations.destructiveHint ? 'This action is destructive' : 'This action changes data';
  return `${tool.annotations.title ?? tool.name} — ${verb}. Run it with:\n${shown || '  (no arguments)'}`;
}

export function createToolServerFactory(opts: ToolServerOptions): McpServerFactory {
  const getManifest = typeof opts.manifest === 'function' ? opts.manifest : () => opts.manifest as Manifest;
  const egress = opts.egress ?? 'public';
  const scopesOf = opts.scopesOf ?? defaultScopes;
  const maxResponseBytes = opts.maxResponseBytes ?? 5 * 1024 * 1024;
  const codec = createRequestStateCodec<ConfirmState>({
    key: opts.stateKey ?? randomBytes(32),
    ttlSeconds: 600,
    // Bind to the caller so one user's approval can never be replayed by another.
    bind: (ctx) => `${ctx.http?.authInfo?.clientId ?? ''}\u0000${(ctx.http?.authInfo?.extra?.sub as string | undefined) ?? ''}`,
  });

  // Validators are compiled once per manifest object (cheap to reuse across requests).
  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false });
  addFormats(ajv);
  let compiledFor: Manifest | null = null;
  let validators = new Map<string, ReturnType<typeof ajv.compile>>();
  const validatorFor = (manifest: Manifest, tool: ToolDefinition) => {
    if (compiledFor !== manifest) {
      compiledFor = manifest;
      validators = new Map();
    }
    let v = validators.get(tool.name);
    if (!v) {
      v = ajv.compile(tool.inputSchema);
      validators.set(tool.name, v);
    }
    return v;
  };

  return () => {
    const manifest = getManifest();
    const server = new Server(
      { name: manifest.name, version: opts.version ?? 'jack' },
      {
        capabilities: { tools: { listChanged: false } },
        ...(manifest.description ? { instructions: manifest.description } : {}),
        requestState: { verify: (state: string, ctx: ServerContext) => codec.verify(state, ctx) },
      },
    );

    server.setRequestHandler('tools/list', async (_req, ctx) => {
      const held = scopesOf(ctx.http?.authInfo);
      const tools = manifest.tools
        .filter((t) => opts.listAll === true || allowed(t, held))
        .map((t) => ({
          name: t.name,
          ...(t.annotations.title ? { title: t.annotations.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        }));
      // The list only changes on deploy; let clients cache it briefly, per user (scopes differ).
      return { tools: tools as never, ttlMs: 60_000, cacheScope: 'private' as const };
    });

    server.setRequestHandler('tools/call', async (req, ctx) => {
      const started = Date.now();
      const params = (req as { params: { name: string; arguments?: Record<string, unknown> } }).params;
      const authInfo = ctx.http?.authInfo;
      const record = (status: CallStatus, extra: Partial<CallRecord> = {}) =>
        opts.onCall?.({
          tool: params.name,
          status,
          ms: Date.now() - started,
          requestBytes: 0,
          responseBytes: 0,
          ...(authInfo?.clientId ? { clientId: authInfo.clientId } : {}),
          ...(typeof authInfo?.extra?.sub === 'string' ? { subject: authInfo.extra.sub } : {}),
          ...extra,
        });

      const tool = manifest.tools.find((t) => t.name === params.name);
      // Same answer for "no such tool" and "not allowed": tool names are not an oracle.
      if (!tool || !allowed(tool, scopesOf(authInfo))) {
        record('forbidden');
        return errorResult(`Unknown tool '${params.name}'.`) as never;
      }

      const args = (params.arguments ?? {}) as Record<string, JsonValue>;
      const validate = validatorFor(manifest, tool);
      if (!validate(args)) {
        record('invalid_arguments');
        const why = (validate.errors ?? [])
          .slice(0, 5)
          .map((e) => `${e.instancePath || '(arguments)'} ${e.message ?? 'is invalid'}`)
          .join('; ');
        return errorResult(`Invalid arguments for ${tool.name}: ${why}`) as never;
      }

      if (tool.confirm) {
        const fingerprint = callFingerprint(tool.name, args);
        const state = ctx.mcpReq.requestState<ConfirmState>();
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmSchema);
        // A confirmation only counts if WE asked for it, for THIS call (signed state).
        const askedForThis = state !== undefined && typeof state === 'object' && state.call === fingerprint;
        if (!askedForThis || answer === undefined) {
          const declined = askedForThis && ctx.mcpReq.inputResponses !== undefined;
          if (declined) {
            record('declined');
            return errorResult(`The user did not approve ${tool.name}; nothing was changed.`) as never;
          }
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({ message: describeCall(tool, args), requestedSchema: confirmSchema }),
            },
            requestState: await codec.mint({ call: fingerprint }, ctx),
          }) as never;
        }
        if (answer.confirm !== true) {
          record('declined');
          return errorResult(`The user did not approve ${tool.name}; nothing was changed.`) as never;
        }
      }

      let upstreamReq;
      try {
        upstreamReq = buildRequest(tool, args, manifest.upstream);
      } catch (err) {
        if (err instanceof ArgumentError) {
          record('invalid_arguments');
          return errorResult(`Invalid arguments for ${tool.name}: ${err.message}`) as never;
        }
        throw err;
      }
      let credentials: Record<string, string> = {};
      try {
        credentials = opts.credentials ? await opts.credentials({ tool, ...(authInfo ? { authInfo } : {}) }) : {};
      } catch (err) {
        if (err instanceof CredentialError) {
          record('credentials');
          return errorResult(`${tool.name} could not run: ${err.message}`) as never;
        }
        throw err;
      }
      upstreamReq.headers = { ...upstreamReq.headers, ...credentials };
      const requestBytes = upstreamReq.body ? Buffer.byteLength(upstreamReq.body) : 0;

      try {
        const res = await sendUpstream(upstreamReq, {
          allowedOrigin: manifest.upstream,
          policy: egress,
          timeoutMs: tool.http.timeoutMs,
          maxResponseBytes,
        });
        const result = shapeResponse(tool, res);
        record(res.status >= 200 && res.status < 300 ? 'ok' : 'upstream_error', {
          upstreamStatus: res.status,
          requestBytes,
          responseBytes: res.body.length,
        });
        return result as never;
      } catch (err) {
        if (err instanceof UpstreamError) {
          record(err.kind, { requestBytes });
          return errorResult(`${tool.name} failed: ${err.message}.`) as never;
        }
        throw err;
      }
    });

    return server;
  };
}
