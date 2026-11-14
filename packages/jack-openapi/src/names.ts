/**
 * Tool and argument names. MCP tool names must match the manifest's
 * `^[a-z][a-z0-9_]{0,63}$`; argument names must be safe JSON-schema
 * property names for every client (OpenAI's function calling is the
 * strictest: `^[a-zA-Z0-9_.-]{1,64}$`).
 */
import { createHash } from 'node:crypto';

const MAX = 64;

/** `findPetsByStatus` → `find_pets_by_status`; `GET /users/{id}/repos` → `get_users_by_id_repos`. */
export function snake(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** Fit to the tool-name grammar: letter first, at most 64, hashed suffix when cut. */
export function toToolName(raw: string): string {
  let name = snake(raw);
  if (!/^[a-z]/.test(name)) name = `op_${name}`;
  if (name.length > MAX) name = `${name.slice(0, MAX - 9).replace(/_$/, '')}_${shortHash(raw)}`;
  return name;
}

export function nameFromPath(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      const v = /^\{(.+)\}$/.exec(s);
      return v ? `by_${v[1]}` : s;
    });
  return toToolName([method.toLowerCase(), ...segments].join('_'));
}

/** A name generator that never returns the same name twice (`x`, `x_2`, `x_3`…). */
export function uniqueNames(): (base: string) => string {
  const used = new Set<string>();
  return (base) => {
    let name = base;
    for (let i = 2; used.has(name); i++) {
      const suffix = `_${i}`;
      name = `${base.slice(0, MAX - suffix.length)}${suffix}`;
    }
    used.add(name);
    return name;
  };
}

/** Argument names: keep the wire name when it is already safe, otherwise snake it. */
export function toArgName(wire: string): string {
  if (/^[A-Za-z0-9_.-]{1,64}$/.test(wire)) return wire;
  const s = snake(wire).slice(0, MAX);
  return s === '' ? `arg_${shortHash(wire)}` : s;
}
