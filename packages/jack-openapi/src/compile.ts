/**
 * (OpenAPI document + jack.yaml) → Manifest, plus lint findings.
 *
 * Every operation in the document becomes a candidate tool with a generated
 * name. jack.yaml then decides, per generated name, whether it is enabled
 * and how it is presented. Only enabled tools reach the manifest.
 */
import {
  MANIFEST_VERSION,
  parseManifest,
  type HttpMethod,
  type JackConfig,
  type JsonValue,
  type Manifest,
  type ParamMapping,
  type ToolAnnotations,
  type ToolDefinition,
} from '@graphmind-ai/jack-schema';
import { Diagnostics, type Diagnostic } from './diagnostics.js';
import { nameFromPath, toArgName, toToolName, uniqueNames } from './names.js';
import { normalize, type Dialect, type NormalizedOperation } from './normalize.js';
import { looksLikeInstructions, sanitizeText, tidy } from './sanitize.js';
import { asJson, asObjectSchema, type Schema } from './schema.js';

export class CompileError extends Error {
  override name = 'CompileError';
}

export type ToolKind = 'read' | 'write' | 'destructive';

/** One row per operation in the document, enabled or not (for `jack check` and the dashboard). */
export interface ToolRow {
  /** Name the tool is published under (after any rename). */
  name: string;
  /** Name `jack init` generated — the key used in jack.yaml. */
  key: string;
  method: HttpMethod;
  path: string;
  enabled: boolean;
  kind: ToolKind;
  deprecated: boolean;
  tags: string[];
  summary?: string;
}

export interface CompileResult {
  manifest: Manifest;
  /** Resolved base URL the tool paths hang off (origin + server path prefix). */
  baseUrl: string;
  dialect: Dialect;
  tools: ToolRow[];
  diagnostics: Diagnostic[];
}

export interface CompileOptions {
  /** Where the document was fetched from; relative `servers` resolve against it. */
  documentUrl?: string;
}

const DESCRIPTION_MAX = 4_000;
const SHORT_DESCRIPTION = 20;

export function kindOf(method: HttpMethod): ToolKind {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'destructive';
  return 'write';
}

export function inferAnnotations(method: HttpMethod): ToolAnnotations {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return { readOnlyHint: true };
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
    case 'PUT':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
    default:
      return { readOnlyHint: false, destructiveHint: false };
  }
}

/** The name `jack init` gives an operation before any rename. */
export const generatedName = (op: Pick<NormalizedOperation, 'operationId' | 'method' | 'path'>): string =>
  op.operationId !== undefined && op.operationId.trim() !== '' ? toToolName(op.operationId) : nameFromPath(op.method, op.path);

/** Resolve the base URL: jack.yaml `upstream` wins, else the document's first server. */
export function resolveUpstream(configured: string | undefined, serverUrl: string | null): { origin: string; prefix: string } {
  const raw = configured ?? serverUrl;
  if (raw === null || raw === undefined) {
    throw new CompileError(
      'the document has no absolute server URL; set `upstream:` in jack.yaml (or pass --upstream to `jack init`)',
    );
  }
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CompileError(`upstream must be http(s), got ${url.protocol}`);
  if (url.search !== '' || url.hash !== '') throw new CompileError('upstream must not contain a query string or fragment');
  return { origin: url.origin, prefix: url.pathname.replace(/\/+$/, '') };
}

interface Args {
  properties: Record<string, Schema>;
  required: string[];
  params: ParamMapping[];
  bodyArg?: string;
}

function buildArgs(op: NormalizedOperation): Args {
  const out: Args = { properties: {}, required: [], params: [] };
  const used = new Set<string>();
  const claim = (wire: string, loc: string): string => {
    let arg = toArgName(wire);
    if (used.has(arg)) arg = toArgName(`${loc}_${wire}`);
    for (let i = 2; used.has(arg); i++) arg = `${toArgName(`${loc}_${wire}`)}_${i}`;
    used.add(arg);
    return arg;
  };

  const order = { path: 0, query: 1, header: 2 } as const;
  for (const p of [...op.params].sort((a, b) => order[a.in] - order[b.in])) {
    const arg = claim(p.name, p.in);
    out.properties[arg] = p.schema;
    if (p.required) out.required.push(arg);
    out.params.push({ arg, in: p.in, ...(arg !== p.name ? { name: p.name } : {}) });
  }

  if (op.body) {
    const obj = asObjectSchema(op.body.schema);
    if (obj) {
      const req = new Set((obj.required as string[] | undefined) ?? []);
      for (const [prop, schema] of Object.entries(obj.properties as Record<string, Schema>)) {
        const arg = claim(prop, 'body');
        out.properties[arg] = schema;
        if (req.has(prop)) out.required.push(arg);
        out.params.push({ arg, in: 'body', ...(arg !== prop ? { name: prop } : {}) });
      }
    } else {
      const arg = claim('body', 'body');
      const schema = { ...op.body.schema };
      if (schema.description === undefined && op.body.description) schema.description = tidy(sanitizeText(op.body.description).text);
      out.properties[arg] = schema;
      if (op.body.required) out.required.push(arg);
      out.bodyArg = arg;
    }
  }
  return out;
}

function describe(op: NormalizedOperation, override: string | undefined, diag: Diagnostics, tool: string): string {
  const raw = override ?? [op.summary, op.description].filter((s) => s !== undefined && s.trim() !== '').join('\n\n');
  const { text, stripped } = sanitizeText(raw);
  if (stripped > 0) diag.warn('J007', `removed ${stripped} invisible character(s) from the description`, tool);
  let description = tidy(text);
  if (description === '') {
    diag.warn('J002', `no summary or description in the document; add a description in jack.yaml`, tool);
    description = `${op.method} ${op.path}`;
  } else if (override === undefined && description.length < SHORT_DESCRIPTION) {
    diag.warn('J002', `description is very short ("${description}"); models pick tools by their descriptions`, tool);
  }
  const suspicious = looksLikeInstructions(description);
  if (suspicious !== null) {
    diag.warn('J008', `description contains instruction-like text ("${suspicious}"); review it for tool poisoning`, tool);
  }
  if (description.length > DESCRIPTION_MAX) {
    diag.warn('J003', `description truncated from ${description.length} to ${DESCRIPTION_MAX} characters`, tool);
    description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
  }
  return description;
}

export function compile(doc: unknown, config: JackConfig, opts: CompileOptions = {}): CompileResult {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CompileError('the OpenAPI document must be an object');
  const diag = new Diagnostics();
  const nd = normalize(doc as Schema, diag, opts.documentUrl);
  const { origin, prefix } = resolveUpstream(config.upstream, nd.serverUrl);

  const nextName = uniqueNames();
  const rows: ToolRow[] = [];
  const tools: ToolDefinition[] = [];
  const keyToName = new Map<string, string>();
  const published = new Set<string>();

  for (const op of nd.operations) {
    const key = nextName(generatedName(op));
    const override = config.tools[key] ?? undefined;
    const kind = kindOf(op.method);
    const name = override?.name ?? key;

    let enabled = kind === 'read' && !op.deprecated;
    if (override?.enabled !== undefined) enabled = override.enabled;
    else if (op.deprecated && kind === 'read') diag.note('J009', 'deprecated operation; disabled unless enabled in jack.yaml', key);

    rows.push({
      name,
      key,
      method: op.method,
      path: `${prefix}${op.path}`,
      enabled,
      kind,
      deprecated: op.deprecated,
      tags: op.tags,
      ...(op.summary !== undefined ? { summary: tidy(sanitizeText(op.summary).text) } : {}),
    });
    keyToName.set(key, name);
    if (!enabled) continue;

    if (published.has(name)) throw new CompileError(`two enabled tools are named '${name}'; rename one in jack.yaml`);
    published.add(name);

    if (kind !== 'read' && override?.description === undefined) {
      diag.note('J013', `${kind} operation enabled with the spec's own description; consider writing one for the model`, name);
    }

    const args = buildArgs(op);
    const inputSchema: Schema = { type: 'object', properties: args.properties, additionalProperties: false };
    if (args.required.length > 0) inputSchema.required = args.required;

    const title = op.summary !== undefined ? tidy(sanitizeText(op.summary).text).slice(0, 128) : undefined;
    const hasBody = args.params.some((p) => p.in === 'body') || args.bodyArg !== undefined;
    const tool: ToolDefinition = {
      name,
      description: describe(op, override?.description, diag, name),
      inputSchema: asJson(inputSchema) as Record<string, JsonValue>,
      annotations: {
        ...(title ? { title } : {}),
        ...inferAnnotations(op.method),
        ...(override?.annotations ?? {}),
      },
      requiredScopes: override?.requiredScopes ?? op.scopes,
      confirm: override?.confirm ?? false,
      http: {
        method: op.method,
        path: `${prefix}${op.path}`,
        params: args.params,
        body: hasBody && op.body?.encoding === 'form' ? 'form' : 'json',
        ...(args.bodyArg !== undefined ? { bodyArg: args.bodyArg } : {}),
        headers: {},
        timeoutMs: override?.timeoutMs ?? 30_000,
      },
      response: {
        maxBytes: override?.response?.maxBytes ?? 50_000,
        ...(override?.response?.pick !== undefined ? { pick: override.response.pick } : {}),
      },
      source: op.operationId ?? `${op.method} ${op.path}`,
    };
    tools.push(tool);
  }

  for (const key of Object.keys(config.tools)) {
    if (!keyToName.has(key)) diag.warn('J004', `jack.yaml configures '${key}', which is not an operation in the document`, key);
  }

  const toolsets: Manifest['toolsets'] = [];
  for (const [setName, set] of Object.entries(config.toolsets)) {
    const members: string[] = [];
    for (const ref of set.tools) {
      const resolved = keyToName.get(ref) ?? (rows.some((r) => r.name === ref) ? ref : undefined);
      if (resolved === undefined) diag.warn('J012', `toolset '${setName}' lists '${ref}', which is not an operation in the document`);
      else if (published.has(resolved) && !members.includes(resolved)) members.push(resolved);
    }
    if (members.length > 0) toolsets.push({ name: setName, ...(set.description ? { description: set.description } : {}), tools: members });
  }

  if (tools.length > config.lint.maxTools) {
    diag.warn(
      'J001',
      `${tools.length} tools are enabled (lint.maxTools is ${config.lint.maxTools}); models choose worse with long tool lists. Disable rarely used ones or split them into toolsets`,
    );
  }

  const description = config.description ?? (nd.description ? tidy(sanitizeText(nd.description).text).slice(0, 2_000) : undefined);
  const manifest = parseManifest({
    version: MANIFEST_VERSION,
    name: config.name ?? nd.title,
    ...(description ? { description } : {}),
    upstream: origin,
    tools,
    toolsets,
    scopes: [...new Set(tools.flatMap((t) => t.requiredScopes))].sort(),
  });

  return { manifest, baseUrl: `${origin}${prefix}`, dialect: nd.dialect, tools: rows, diagnostics: diag.items };
}
