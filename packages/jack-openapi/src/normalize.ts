/**
 * Swagger 2.0 / OpenAPI 3.0 / OpenAPI 3.1 → one internal shape. Everything
 * after this file only ever sees NormalizedDocument, so dialect differences
 * live in exactly one place.
 */
import type { HttpMethod } from '@graphmind-ai/jack-schema';
import type { Diagnostics } from './diagnostics.js';
import { convertSchema, RefResolver, type Schema } from './schema.js';

export type Dialect = 'swagger-2.0' | 'openapi-3.0' | 'openapi-3.1';

export interface NormalizedParam {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: Schema;
}

export interface NormalizedBody {
  encoding: 'json' | 'form';
  required: boolean;
  schema: Schema;
  description?: string;
}

export interface NormalizedOperation {
  method: HttpMethod;
  /** Path as written in the document (no server prefix). */
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  params: NormalizedParam[];
  body?: NormalizedBody;
  deprecated: boolean;
  /** OAuth2/OIDC scopes from the effective `security` requirement. */
  scopes: string[];
}

export interface NormalizedDocument {
  dialect: Dialect;
  title: string;
  description?: string;
  /** First server URL, absolute, with server variables at their defaults. Null if relative/absent. */
  serverUrl: string | null;
  operations: NormalizedOperation[];
}

const METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
};

/** Headers that carry transport or credentials: never tool arguments. */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'content-length', 'cookie', 'host']);

export class UnsupportedDocumentError extends Error {
  override name = 'UnsupportedDocumentError';
}

export function detectDialect(doc: Schema): Dialect {
  if (typeof doc.swagger === 'string' && doc.swagger.startsWith('2.')) return 'swagger-2.0';
  if (typeof doc.openapi === 'string') {
    if (doc.openapi.startsWith('3.0')) return 'openapi-3.0';
    if (doc.openapi.startsWith('3.1')) return 'openapi-3.1';
    throw new UnsupportedDocumentError(`OpenAPI ${doc.openapi} is not supported (supported: Swagger 2.0, OpenAPI 3.0, 3.1)`);
  }
  throw new UnsupportedDocumentError('not an OpenAPI document: no `openapi` or `swagger` field');
}

function serverUrl(doc: Schema, dialect: Dialect, documentUrl?: string): string | null {
  if (dialect === 'swagger-2.0') {
    if (typeof doc.host !== 'string') return null;
    const schemes = Array.isArray(doc.schemes) ? (doc.schemes as string[]) : [];
    const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
    const base = typeof doc.basePath === 'string' ? doc.basePath : '';
    return `${scheme}://${doc.host}${base}`;
  }
  const first = Array.isArray(doc.servers) ? (doc.servers[0] as Schema | undefined) : undefined;
  if (!first || typeof first.url !== 'string') return null;
  let url = first.url;
  const vars = (first.variables ?? {}) as Record<string, { default?: unknown }>;
  url = url.replace(/\{([^}]+)\}/g, (_, v: string) => String(vars[v]?.default ?? `{${v}}`));
  try {
    // Relative servers ("/api/v3") resolve against the document's own URL (OpenAPI 3 §4.8.5).
    return new URL(url, documentUrl).href.replace(/\/$/, '');
  } catch {
    return null; // relative and no document URL — the caller must supply --upstream
  }
}

/** Header names an apiKey security scheme sends — credentials, not arguments. */
function credentialHeaders(doc: Schema, dialect: Dialect): Set<string> {
  const schemes =
    dialect === 'swagger-2.0'
      ? ((doc.securityDefinitions ?? {}) as Record<string, Schema>)
      : (((doc.components as Schema | undefined)?.securitySchemes ?? {}) as Record<string, Schema>);
  const out = new Set<string>();
  for (const s of Object.values(schemes)) {
    if (s && s.type === 'apiKey' && s.in === 'header' && typeof s.name === 'string') out.add(s.name.toLowerCase());
  }
  return out;
}

function scopesFor(doc: Schema, dialect: Dialect, security: unknown): string[] {
  if (!Array.isArray(security) || security.length === 0) return [];
  const schemes =
    dialect === 'swagger-2.0'
      ? ((doc.securityDefinitions ?? {}) as Record<string, Schema>)
      : (((doc.components as Schema | undefined)?.securitySchemes ?? {}) as Record<string, Schema>);
  // The first alternative is the one we satisfy; its OAuth2/OIDC scopes become required scopes.
  const first = security[0] as Record<string, unknown> | undefined;
  const scopes: string[] = [];
  for (const [name, list] of Object.entries(first ?? {})) {
    const t = schemes[name]?.type;
    if ((t === 'oauth2' || t === 'openIdConnect') && Array.isArray(list)) scopes.push(...(list as string[]));
  }
  return [...new Set(scopes)];
}

export function normalize(doc: Schema, diag: Diagnostics, documentUrl?: string): NormalizedDocument {
  const dialect = detectDialect(doc);
  const resolver = new RefResolver(doc, diag);
  const info = (doc.info ?? {}) as Schema;
  const credHeaders = credentialHeaders(doc, dialect);
  const operations: NormalizedOperation[] = [];
  const consumes = Array.isArray(doc.consumes) ? (doc.consumes as string[]) : ['application/json'];

  for (const [path, rawItem] of Object.entries((doc.paths ?? {}) as Record<string, unknown>)) {
    const item = resolver.deref<Schema>(rawItem);
    if (!item) continue;
    const shared = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];

    for (const [verb, rawOp] of Object.entries(item)) {
      const method = METHODS[verb];
      if (!method || !rawOp || typeof rawOp !== 'object') continue;
      const op = rawOp as Schema;
      const label = `${method} ${path}`;
      const where = typeof op.operationId === 'string' ? op.operationId : label;

      // Operation-level parameters override path-level ones with the same (name, in).
      const byKey = new Map<string, Schema>();
      for (const raw of [...shared, ...((op.parameters as unknown[] | undefined) ?? [])]) {
        const p = resolver.deref<Schema>(raw);
        if (p && typeof p.name === 'string' && typeof p.in === 'string') byKey.set(`${p.in}:${p.name}`, p);
      }

      const params: NormalizedParam[] = [];
      let body: NormalizedBody | undefined;
      let skip: string | null = null;
      const swaggerForm: Schema = { type: 'object', properties: {}, required: [] };

      for (const p of byKey.values()) {
        const name = p.name as string;
        const loc = p.in as string;
        const required = p.required === true || loc === 'path';
        if (loc === 'cookie') {
          if (required) skip = `required cookie parameter '${name}' cannot be sent by Jack`;
          else diag.warn('J006', `${label}: cookie parameter '${name}' dropped`, where);
          continue;
        }
        if (loc === 'header' && (RESERVED_HEADERS.has(name.toLowerCase()) || credHeaders.has(name.toLowerCase()))) continue;
        if (dialect === 'swagger-2.0' && loc === 'body') {
          body = {
            encoding: 'json',
            required,
            schema: convertSchema(p.schema, resolver, diag, { dialect, mode: 'request' }, where),
            ...(typeof p.description === 'string' ? { description: p.description } : {}),
          };
          continue;
        }
        if (dialect === 'swagger-2.0' && loc === 'formData') {
          const { name: _n, in: _i, required: _r, ...rest } = p;
          (swaggerForm.properties as Schema)[name] = convertSchema(rest, resolver, diag, { dialect, mode: 'request' }, where);
          if (required) (swaggerForm.required as string[]).push(name);
          continue;
        }
        if (loc !== 'path' && loc !== 'query' && loc !== 'header') continue;
        // 3.x: schema lives under `schema`; 2.0: type/format/items/enum sit on the parameter itself.
        const source = dialect === 'swagger-2.0' ? (({ name: _n, in: _i, required: _r, ...rest }) => rest)(p) : p.schema;
        const schema = convertSchema(source, resolver, diag, { dialect, mode: 'request' }, where);
        if (typeof p.description === 'string' && schema.description === undefined) {
          schema.description = convertSchema({ description: p.description }, resolver, diag, { dialect, mode: 'request' }, where).description;
        }
        params.push({ name, in: loc, required, schema });
      }

      if (Object.keys(swaggerForm.properties as Schema).length > 0) {
        const opConsumes = Array.isArray(op.consumes) ? (op.consumes as string[]) : consumes;
        if (opConsumes.some((c) => c.startsWith('multipart/'))) skip = 'multipart/form-data uploads are not supported yet';
        else body = { encoding: 'form', required: (swaggerForm.required as string[]).length > 0, schema: swaggerForm };
      }

      if (dialect !== 'swagger-2.0' && op.requestBody !== undefined) {
        const rb = resolver.deref<Schema>(op.requestBody);
        const content = (rb?.content ?? {}) as Record<string, Schema>;
        const types = Object.keys(content);
        const json = types.find((t) => t === 'application/json' || /^application\/[\w.+-]*\+json/.test(t) || t === '*/*');
        const form = types.find((t) => t === 'application/x-www-form-urlencoded');
        const picked = json ?? form;
        if (picked) {
          body = {
            encoding: picked === form && !json ? 'form' : 'json',
            required: rb?.required === true,
            schema: convertSchema(content[picked]?.schema, resolver, diag, { dialect, mode: 'request' }, where),
            ...(typeof rb?.description === 'string' ? { description: rb.description } : {}),
          };
        } else if (types.length > 0) {
          skip = `request body type ${types.join(', ')} is not supported yet (JSON and form bodies are)`;
        }
      }

      if (skip !== null) {
        diag.warn(skip.includes('cookie') ? 'J006' : 'J005', `${label} skipped: ${skip}`, where);
        continue;
      }

      const security = op.security !== undefined ? op.security : doc.security;
      operations.push({
        method,
        path,
        ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
        ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
        ...(typeof op.description === 'string' ? { description: op.description } : {}),
        tags: Array.isArray(op.tags) ? (op.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
        params,
        ...(body ? { body } : {}),
        deprecated: op.deprecated === true,
        scopes: scopesFor(doc, dialect, security),
      });
    }
  }

  return {
    dialect,
    title: typeof info.title === 'string' && info.title.trim() !== '' ? info.title.trim() : 'API',
    ...(typeof info.description === 'string' ? { description: info.description } : {}),
    serverUrl: serverUrl(doc, dialect, documentUrl),
    operations,
  };
}
