/**
 * OpenAPI schema objects → the JSON Schema an MCP client sees.
 *
 * - `$ref`s are inlined (local `#/...` pointers only). A reference cycle, or
 *   nesting deeper than MAX_DEPTH, becomes a described open object instead
 *   of an infinite or enormous schema.
 * - Dialects: 3.0 `nullable` and Swagger 2 `x-nullable` become a `null`
 *   type; Swagger 2 `type: file` becomes a string.
 * - Request mode drops `readOnly` properties (the server sets them, the
 *   model must not try to).
 * - Only keywords that help a model fill arguments are kept; examples,
 *   XML hints and vendor extensions are dropped to keep tool lists small.
 */
import type { JsonValue } from '@graphmind-ai/jack-schema';
import { sanitizeText, tidy } from './sanitize.js';
import type { Diagnostics } from './diagnostics.js';

export type Schema = Record<string, unknown>;

export const MAX_DEPTH = 8;

const PASSTHROUGH = [
  'type',
  'format',
  'enum',
  'const',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const;

export class RefResolver {
  constructor(
    private readonly doc: Schema,
    private readonly diag: Diagnostics,
  ) {}

  /** Follow a local JSON pointer; external refs are reported and return null. */
  lookup(ref: string): unknown {
    if (!ref.startsWith('#')) {
      this.diag.warn('J010', `external $ref '${ref}' is not supported; replaced with an open schema`);
      return null;
    }
    let node: unknown = this.doc;
    for (const raw of ref.slice(1).split('/').filter(Boolean)) {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!node || typeof node !== 'object') return null;
      node = (node as Record<string, unknown>)[decodeURIComponent(key)];
    }
    if (node === undefined) this.diag.warn('J010', `$ref '${ref}' points at nothing; replaced with an open schema`);
    return node ?? null;
  }

  /** Resolve an object that may itself be a `$ref` (parameters, request bodies…). */
  deref<T = Schema>(obj: unknown, seen: Set<string> = new Set()): T | null {
    let cur = obj;
    while (cur && typeof cur === 'object' && typeof (cur as Schema).$ref === 'string') {
      const ref = (cur as Schema).$ref as string;
      if (seen.has(ref)) return null;
      seen.add(ref);
      cur = this.lookup(ref);
    }
    return (cur ?? null) as T | null;
  }
}

export interface ConvertOptions {
  dialect: 'swagger-2.0' | 'openapi-3.0' | 'openapi-3.1';
  /** Request bodies and parameters: drop readOnly properties. */
  mode: 'request';
}

const refName = (ref: string) => ref.split('/').pop() ?? ref;

function cleanString(value: unknown, diag: Diagnostics, where: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const { text, stripped } = sanitizeText(value);
  if (stripped > 0) diag.warn('J007', `${where}: removed ${stripped} invisible character(s) from a schema description`);
  return tidy(text);
}

export function convertSchema(
  input: unknown,
  resolver: RefResolver,
  diag: Diagnostics,
  opts: ConvertOptions,
  where: string,
  depth = 0,
  stack: readonly string[] = [],
): Schema {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  let schema = input as Schema;

  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    const { $ref: _ignored, ...siblings } = schema;
    if (stack.includes(ref) || depth >= MAX_DEPTH) {
      diag.note('J011', `${where}: '${refName(ref)}' is recursive or nested deeper than ${MAX_DEPTH}; inlined as an open object`);
      return { type: 'object', description: `${refName(ref)} (nested; see the API documentation for its fields)` };
    }
    const target = resolver.lookup(ref);
    const resolved = convertSchema(target, resolver, diag, opts, where, depth + 1, [...stack, ref]);
    // 3.1 allows keywords next to $ref; the local ones (usually description) win.
    const local = convertSchema(siblings, resolver, diag, opts, where, depth, stack);
    return { ...resolved, ...local };
  }

  const out: Schema = {};
  for (const key of PASSTHROUGH) if (schema[key] !== undefined) out[key] = schema[key];

  const title = cleanString(schema.title, diag, where);
  if (title !== undefined) out.title = title;
  const description = cleanString(schema.description, diag, where);
  if (description !== undefined) out.description = description;

  if (out.type === 'file') {
    out.type = 'string';
    out.description = [description, '(file contents)'].filter(Boolean).join(' ');
  }

  const recurse = (s: unknown, w = where) => convertSchema(s, resolver, diag, opts, w, depth + 1, stack);

  if (schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, Schema> = {};
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const [name, raw] of Object.entries(schema.properties as Record<string, unknown>)) {
      const prop = resolver.deref(raw);
      if (opts.mode === 'request' && prop && prop.readOnly === true) {
        required.delete(name);
        continue;
      }
      props[name] = recurse(raw, `${where}.${name}`);
    }
    out.properties = props;
    const req = [...required].filter((n) => n in props);
    if (req.length > 0) out.required = req;
  }
  if (schema.items !== undefined) out.items = Array.isArray(schema.items) ? {} : recurse(schema.items);
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties =
      typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : recurse(schema.additionalProperties);
  }
  for (const combo of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[combo])) out[combo] = (schema[combo] as unknown[]).map((s) => recurse(s));
  }

  // Nullability across dialects. 3.1 already uses type arrays and passes through.
  const nullable = schema.nullable === true || schema['x-nullable'] === true;
  if (nullable && opts.dialect !== 'openapi-3.1') {
    // An enum constrains values on its own: without null in it, null still fails validation.
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else return { anyOf: [out, { type: 'null' }] };
  }
  return out;
}

/**
 * Merge `allOf` members that are all objects into one object schema, so a
 * body declared as `allOf: [Base, {extra}]` can be flattened into arguments.
 * Returns null when the shape is not a plain object.
 */
export function asObjectSchema(schema: Schema): Schema | null {
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as Schema[]).map(asObjectSchema);
    if (parts.some((p) => p === null)) return null;
    const merged: Schema = { type: 'object', properties: {} };
    const required: string[] = [];
    for (const p of parts as Schema[]) {
      Object.assign(merged.properties as Schema, p.properties ?? {});
      required.push(...((p.required as string[] | undefined) ?? []));
    }
    if (schema.description !== undefined) merged.description = schema.description;
    if (required.length > 0) merged.required = [...new Set(required)];
    return merged;
  }
  const isObject = schema.type === 'object' || (schema.type === undefined && schema.properties !== undefined);
  if (!isObject || !schema.properties) return null;
  return schema;
}

export const asJson = (s: Schema): Record<string, JsonValue> => JSON.parse(JSON.stringify(s)) as Record<string, JsonValue>;
