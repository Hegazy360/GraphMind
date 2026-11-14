/**
 * The manifest: what a Jack deployment IS. It is declarative — a list of
 * tools, each with the JSON schema the MCP client sees and the HTTP request
 * the runtime makes on its behalf. No customer code is ever part of it, so
 * nothing in a manifest can execute; the runtime interprets it.
 *
 * `jack-openapi` compiles (OpenAPI document + jack.yaml) → Manifest.
 * `jack-runtime` serves Manifest → MCP server.
 */
import { z } from 'zod';
import { canonicalJson, jsonValue, sha256Hex } from './json.js';

/** MCP tool names: what the spec allows and what every client accepts. */
export const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'snake_case, starting with a letter, at most 64 characters');

export const httpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
export type HttpMethod = z.infer<typeof httpMethod>;

/** Where each tool argument goes in the upstream request. */
export const paramLocation = z.enum(['path', 'query', 'header', 'body']);
export type ParamLocation = z.infer<typeof paramLocation>;

export const paramMapping = z.object({
  /** Argument name in the tool's input schema. */
  arg: z.string().min(1),
  in: paramLocation,
  /** Name on the wire (path template variable, query key, header name, body key). Default: `arg`. */
  name: z.string().min(1).optional(),
});
export type ParamMapping = z.infer<typeof paramMapping>;

/** Standard MCP tool annotations (hints only — nothing enforces them). */
export const toolAnnotations = z.object({
  title: z.string().max(128).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof toolAnnotations>;

export const responseShaping = z.object({
  /** JSONPath-like projection applied to a JSON body before it is returned (M2). */
  pick: z.string().max(512).optional(),
  /** Hard cap on the text returned to the model; the result says when it was cut. */
  maxBytes: z.number().int().min(1_000).max(1_000_000).default(50_000),
});

export const toolDefinition = z.object({
  name: toolName,
  description: z.string().min(1).max(4_000),
  /** JSON Schema (object) of the tool's arguments as the MCP client sees it. */
  inputSchema: z.record(z.string(), jsonValue),
  annotations: toolAnnotations.prefault({}),
  /** Scopes a grant must hold to list and call this tool; empty = any signed-in grant. */
  requiredScopes: z.array(z.string().min(1)).default([]),
  /** Ask the user to confirm (MRTR `input_required`) before the call runs (M2). */
  confirm: z.boolean().default(false),
  http: z.object({
    method: httpMethod,
    /** Path template relative to the project's upstream base URL, e.g. `/invoices/{id}`. */
    path: z.string().startsWith('/'),
    params: z.array(paramMapping).default([]),
    /** Body encoding when any param maps to `body`. */
    body: z.enum(['json', 'form']).default('json'),
    /**
     * When the request body is not an object (an array, a string…), the one
     * argument whose value IS the whole body. Mutually exclusive with `body` params.
     */
    bodyArg: z.string().min(1).optional(),
    /** Static headers added to every request (never credentials — those come from the grant). */
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  }),
  response: responseShaping.prefault({}),
  /** Source operation, for diffs and the dashboard (`operationId` or `METHOD /path`). */
  source: z.string().optional(),
});
export type ToolDefinition = z.infer<typeof toolDefinition>;

export const toolset = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  description: z.string().max(1_000).optional(),
  tools: z.array(toolName).min(1),
});

export const MANIFEST_VERSION = 1;

export const manifest = z.object({
  version: z.literal(MANIFEST_VERSION),
  /** Shown to MCP clients as the server name. */
  name: z.string().min(1).max(128),
  description: z.string().max(2_000).optional(),
  /** The only host the runtime will call for this manifest (origin, no path). */
  upstream: z.string().url(),
  tools: z.array(toolDefinition),
  toolsets: z.array(toolset).default([]),
  /** Scopes the authorization server advertises as `scopes_supported`. */
  scopes: z.array(z.string().min(1)).default([]),
});
export type Manifest = z.infer<typeof manifest>;

/**
 * Validate a manifest and the cross-references inside it: unique tool
 * names, toolsets that point at real tools, and path template variables
 * that have a matching `path` param.
 */
export function parseManifest(input: unknown): Manifest {
  const m = manifest.parse(input);
  const names = new Set<string>();
  for (const t of m.tools) {
    if (names.has(t.name)) throw new ManifestError(`duplicate tool name '${t.name}'`);
    names.add(t.name);
    const vars = [...t.http.path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1] as string);
    const pathParams = new Set(t.http.params.filter((p) => p.in === 'path').map((p) => p.name ?? p.arg));
    for (const v of vars) {
      if (!pathParams.has(v)) throw new ManifestError(`tool '${t.name}': path variable {${v}} has no path param`);
    }
    for (const p of t.http.params) {
      if (p.in === 'path' && !vars.includes(p.name ?? p.arg)) {
        throw new ManifestError(`tool '${t.name}': path param '${p.name ?? p.arg}' is not in the path template`);
      }
    }
    if (t.http.bodyArg !== undefined && t.http.params.some((p) => p.in === 'body')) {
      throw new ManifestError(`tool '${t.name}': bodyArg and body params cannot be combined`);
    }
  }
  for (const set of m.toolsets) {
    for (const n of set.tools) {
      if (!names.has(n)) throw new ManifestError(`toolset '${set.name}' lists unknown tool '${n}'`);
    }
  }
  return m;
}

export class ManifestError extends Error {
  override name = 'ManifestError';
}

/** Stable identity of a manifest's content (key order does not matter). */
export const manifestHash = (m: Manifest): string => sha256Hex(canonicalJson(m));

/**
 * Identity of ONE tool as an MCP client sees it — the same recipe Circuit's
 * gateway pins (name, description, input schema), so a Circuit workflow that
 * calls a Jack server notices exactly the changes Jack's own deploy diff shows.
 */
export const toolHash = (t: Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>): string =>
  sha256Hex(JSON.stringify([t.name, t.description, canonicalJson(t.inputSchema)]));

export interface ManifestDiff {
  added: string[];
  removed: string[];
  /** Tools whose client-visible definition changed (name, description or schema). */
  changed: string[];
  /** Tools whose HTTP mapping or policy changed but whose client-visible definition did not. */
  rewired: string[];
}

export function diffManifests(before: Manifest | null, after: Manifest): ManifestDiff {
  const prev = new Map((before?.tools ?? []).map((t) => [t.name, t]));
  const next = new Map(after.tools.map((t) => [t.name, t]));
  const diff: ManifestDiff = { added: [], removed: [], changed: [], rewired: [] };
  for (const [name, t] of next) {
    const p = prev.get(name);
    if (!p) diff.added.push(name);
    else if (toolHash(p) !== toolHash(t)) diff.changed.push(name);
    else if (canonicalJson(p) !== canonicalJson(t)) diff.rewired.push(name);
  }
  for (const name of prev.keys()) if (!next.has(name)) diff.removed.push(name);
  return diff;
}
