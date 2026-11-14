/**
 * Tool arguments → an HTTP request, following the manifest's mapping.
 *
 * Arguments are untrusted (they come from a model), so each value is put
 * in its slot with the encoding for that slot, and nothing an argument
 * contains can change the host, add a path segment, or set a header that
 * belongs to Jack.
 */
import type { JsonValue, ToolDefinition } from '@graphmind-ai/jack-schema';
import type { UpstreamRequest } from './http.js';

export class ArgumentError extends Error {
  override name = 'ArgumentError';
}

/** Headers no argument may set: transport, routing and credentials. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'te',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'jack-assertion',
]);

const scalar = (v: JsonValue, where: string): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new ArgumentError(`${where} must be a string, number or boolean`);
};

function pathSegment(v: JsonValue, arg: string): string {
  const s = scalar(v, `'${arg}'`);
  // An empty, "." or ".." segment would change which resource the path names.
  if (s === '' || s === '.' || s === '..') throw new ArgumentError(`'${arg}' is not a valid path value`);
  return encodeURIComponent(s);
}

function appendQuery(params: URLSearchParams, key: string, v: JsonValue): void {
  if (v === null) return;
  if (Array.isArray(v)) {
    // OpenAPI's default (form, explode=true): ?tag=a&tag=b
    for (const item of v) appendQuery(params, key, item);
    return;
  }
  if (typeof v === 'object') {
    for (const [k, inner] of Object.entries(v)) appendQuery(params, k, inner);
    return;
  }
  params.append(key, String(v));
}

/**
 * `baseOrigin` is the project's upstream origin; the tool's path already
 * carries any server prefix (`/api/v3/pet/{petId}`).
 */
export function buildRequest(tool: ToolDefinition, args: Record<string, JsonValue>, baseOrigin: string): UpstreamRequest {
  const { http } = tool;
  const pathValues = new Map<string, string>();
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' };
  const body: Record<string, JsonValue> = {};
  let hasBody = false;

  for (const p of http.params) {
    const value = args[p.arg];
    if (value === undefined) continue;
    const wire = p.name ?? p.arg;
    switch (p.in) {
      case 'path':
        pathValues.set(wire, pathSegment(value, p.arg));
        break;
      case 'query':
        appendQuery(query, wire, value);
        break;
      case 'header': {
        if (FORBIDDEN_HEADERS.has(wire.toLowerCase())) throw new ArgumentError(`header '${wire}' cannot be set by a tool argument`);
        const s = scalar(value, `'${p.arg}'`);
        if (/[\r\n\0]/.test(s)) throw new ArgumentError(`'${p.arg}' contains characters not allowed in a header`);
        headers[wire.toLowerCase()] = s;
        break;
      }
      case 'body':
        body[wire] = value;
        hasBody = true;
        break;
    }
  }

  const path = http.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = pathValues.get(name);
    if (v === undefined) throw new ArgumentError(`missing required path value '${name}'`);
    return v;
  });
  const url = new URL(path, baseOrigin);
  url.search = query.toString();

  let payload: string | undefined;
  if (http.bodyArg !== undefined && args[http.bodyArg] !== undefined) {
    payload = JSON.stringify(args[http.bodyArg]);
    headers['content-type'] = 'application/json';
  } else if (hasBody) {
    if (http.body === 'form') {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v !== null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      payload = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
  }
  for (const [k, v] of Object.entries(http.headers)) {
    if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  }

  return { url, method: http.method, headers, ...(payload !== undefined ? { body: payload } : {}) };
}
