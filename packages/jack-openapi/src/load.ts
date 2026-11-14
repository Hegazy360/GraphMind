/**
 * Reading documents and jack.yaml from disk or the network.
 *
 * Inputs here are untrusted (a spec URL can point anywhere, a YAML file can
 * be hostile), so: http(s) only, a timeout, a size cap, and YAML parsed with
 * a low alias limit (no "billion laughs").
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { jackConfig, type JackConfig } from '@graphmind-ai/jack-schema';
import { compile, type CompileResult } from './compile.js';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export class LoadError extends Error {
  override name = 'LoadError';
}

/** JSON or YAML text → value. */
export function parseDocumentText(text: string, label: string): unknown {
  const trimmed = text.trimStart();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(text);
    return parseYaml(text, { maxAliasCount: 100, prettyErrors: true });
  } catch (err) {
    throw new LoadError(`${label}: not valid JSON or YAML — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

export interface LoadedSource {
  document: unknown;
  /** Set when fetched over http(s); relative `servers` resolve against it. */
  documentUrl?: string;
  label: string;
}

export async function loadSource(
  source: string,
  opts: { baseDir?: string; fetchImpl?: typeof fetch } = {},
): Promise<LoadedSource> {
  if (isUrl(source)) {
    const f = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(source, {
        headers: { accept: 'application/json, application/yaml;q=0.9, */*;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LoadError(`could not fetch ${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new LoadError(`could not fetch ${source}: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_DOCUMENT_BYTES) throw new LoadError(`${source} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    const text = await res.text();
    if (text.length > MAX_DOCUMENT_BYTES) throw new LoadError(`${source} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    return { document: parseDocumentText(text, source), documentUrl: res.url || source, label: source };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new LoadError(`only http(s) URLs and files are supported, got ${source}`);
  const path = isAbsolute(source) ? source : resolve(opts.baseDir ?? process.cwd(), source);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new LoadError(`cannot read ${path}`);
  }
  if (text.length > MAX_DOCUMENT_BYTES) throw new LoadError(`${path} is larger than ${MAX_DOCUMENT_BYTES} bytes`);
  return { document: parseDocumentText(text, path), label: path };
}

export function parseConfigText(text: string, label: string): JackConfig {
  const raw = parseDocumentText(text, label) ?? {};
  const parsed = jackConfig.safeParse(raw);
  if (!parsed.success) throw new LoadError(`${label} is not a valid jack.yaml:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

type RawConfig = Record<string, unknown>;

const isObject = (v: unknown): v is RawConfig => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a jack.yaml as plain data, following `extends:` (a path relative to
 * the file). The child wins key by key; `tools` and `toolsets` merge per
 * entry, so a variant file can change only `auth` (or one tool) and
 * inherit everything else. A relative `source:` keeps meaning "relative to
 * the file that wrote it".
 */
export type Env = Record<string, string | undefined>;

/**
 * `${NAME}` and `${NAME:-default}` in any string value of jack.yaml, from the
 * environment; `${` is a literal `${`. Applied to parsed values (never to the
 * raw text), so a variable's content can never change the file's structure.
 * Typical use: `upstream: "${ACME_API_URL:-http://127.0.0.1:4830}"`, so each
 * worktree can point at its own API.
 */
export function interpolate(value: unknown, env: Env, where = 'jack.yaml'): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$?\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match: string, name: string, fallback: string | undefined) => {
      if (match.startsWith('$$')) return match.slice(1); // escaped: $${X} → ${X}
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new LoadError(`${where}: \${${name}} is not set (give a default with \${${name}:-…})`);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, where));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, where)]));
  return value;
}

async function readRawConfig(path: string, seen: string[] = [], env: Env = process.env): Promise<RawConfig> {
  const abs = resolve(path);
  if (seen.includes(abs)) throw new LoadError(`${abs}: extends loops back to itself (${[...seen, abs].join(' → ')})`);
  if (seen.length >= 5) throw new LoadError(`${abs}: extends is nested more than 5 deep`);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    throw new LoadError(seen.length === 0 ? `cannot read ${abs} — run \`jack init <openapi>\` first` : `cannot read ${abs} (from extends)`);
  }
  const raw = interpolate(parseDocumentText(text, abs) ?? {}, env, abs) as unknown;
  if (!isObject(raw)) throw new LoadError(`${abs} is not a valid jack.yaml: expected a mapping`);
  if (typeof raw.source === 'string' && !isUrl(raw.source) && !isAbsolute(raw.source)) raw.source = resolve(dirname(abs), raw.source);
  if (raw.extends === undefined) return raw;
  if (typeof raw.extends !== 'string') throw new LoadError(`${abs}: extends must be a path`);
  const parent = await readRawConfig(resolve(dirname(abs), raw.extends), [...seen, abs], env);
  const { extends: _drop, ...child } = raw;
  const merged: RawConfig = { ...parent, ...child };
  for (const key of ['tools', 'toolsets'] as const) {
    const p = isObject(parent[key]) ? parent[key] : {};
    const c = isObject(child[key]) ? child[key] : {};
    const out: RawConfig = { ...p };
    for (const [k, v] of Object.entries(c)) out[k] = isObject(out[k]) && isObject(v) ? { ...(out[k] as RawConfig), ...v } : v;
    if (Object.keys(out).length > 0) merged[key] = out;
  }
  return merged;
}

export async function loadConfig(path: string, env: Env = process.env): Promise<{ config: JackConfig; dir: string }> {
  const raw = await readRawConfig(path, [], env);
  const parsed = jackConfig.safeParse(raw);
  if (!parsed.success) throw new LoadError(`${path} is not a valid jack.yaml:\n${z.prettifyError(parsed.error)}`);
  return { config: parsed.data, dir: dirname(resolve(path)) };
}

/** jack.yaml path → compiled manifest (loads the `source` it points at). */
export async function compileProject(
  configPath: string,
  opts: { fetchImpl?: typeof fetch; env?: Env } = {},
): Promise<CompileResult & { config: JackConfig; source: LoadedSource }> {
  const { config, dir } = await loadConfig(configPath, opts.env ?? process.env);
  const source = await loadSource(config.source, { baseDir: dir, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const result = compile(source.document, config, source.documentUrl ? { documentUrl: source.documentUrl } : {});
  return { ...result, config, source };
}
