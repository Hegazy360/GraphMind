/**
 * Helpers every generator shares: literal escaping for both languages, the
 * JSON Schema a tool's parameters become, and the stub result a tool
 * returns until the engineer replaces it.
 *
 * Everything an engineer typed (prompts, descriptions, the stub result) is
 * emitted through one of the literal functions below. Nothing is ever
 * interpolated raw into source: a prompt containing a backtick, a quote or a
 * newline must come out as a correct string literal, not as code.
 */
import type { ParamType, ToolParam, ToolSpec, WorkflowSpec } from '../spec.js';

/**
 * A JavaScript / TypeScript string literal. JSON.stringify's escapes are a
 * subset of JS's, and the two line terminators JSON leaves raw (U+2028 and
 * U+2029) are legal inside a JS string since ES2019, so the output is always
 * a valid literal.
 */
export function tsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * A Python string literal. Every escape JSON.stringify emits (`\"`, `\\`,
 * `\n`, `\r`, `\t`, `\b`, `\f`, `\uXXXX`) is also a Python escape with the
 * same meaning, and it never emits `\/`, so a JSON string is a Python string.
 */
export function pyString(value: string): string {
  return JSON.stringify(value);
}

/** A Python literal for any JSON value (true -> True, null -> None, ...). */
export function pyLiteral(value: unknown, indent = 0): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return pyString(value);
  const pad = '    '.repeat(indent + 1);
  const close = '    '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${pad}${pyLiteral(item, indent + 1)},`).join('\n')}\n${close}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([key, item]) => `${pad}${pyString(key)}: ${pyLiteral(item, indent + 1)},`)
      .join('\n')}\n${close}}`;
  }
  return 'None';
}

/** A TypeScript literal for any JSON value, formatted over several lines. */
export function tsLiteral(value: unknown, indent = 0): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return tsString(value);
  const pad = '  '.repeat(indent + 1);
  const close = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${pad}${tsLiteral(item, indent + 1)},`).join('\n')}\n${close}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([key, item]) => `${pad}${tsKey(key)}: ${tsLiteral(item, indent + 1)},`)
      .join('\n')}\n${close}}`;
  }
  return 'null';
}

function tsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : tsString(key);
}

/**
 * What a tool stub returns. JSON text is kept as structured data (so the
 * model gets an object back, as it would from the real tool); anything else
 * is returned as a string.
 */
export function stubResult(tool: ToolSpec): unknown {
  const text = tool.returns.trim();
  if (text === '') return { ok: true };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** JSON Schema for one parameter type. */
export function jsonSchemaType(type: ParamType): 'string' | 'number' | 'boolean' {
  return type;
}

export interface ParamsJsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
  additionalProperties: false;
}

/** The JSON Schema object the provider APIs want for a tool's parameters. */
export function paramsJsonSchema(params: readonly ToolParam[]): ParamsJsonSchema {
  const properties: ParamsJsonSchema['properties'] = {};
  const required: string[] = [];
  for (const param of params) {
    properties[param.name] = {
      type: jsonSchemaType(param.type),
      ...(param.description !== undefined && param.description !== '' ? { description: param.description } : {}),
    };
    if (param.required) required.push(param.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

export const TS_TYPE: Record<ParamType, string> = { string: 'string', number: 'number', boolean: 'boolean' };
export const PY_TYPE: Record<ParamType, string> = { string: 'str', number: 'float', boolean: 'bool' };

/** `{ city: string; day?: string }` */
export function tsInputType(params: readonly ToolParam[]): string {
  if (params.length === 0) return 'Record<string, never>';
  const fields = params.map((p) => `${p.name}${p.required ? '' : '?'}: ${TS_TYPE[p.type]}`);
  return `{ ${fields.join('; ')} }`;
}

/** `city: str, day: str | None = None` — required parameters first, as Python demands. */
export function pySignature(params: readonly ToolParam[]): string {
  const required = params.filter((p) => p.required).map((p) => `${p.name}: ${PY_TYPE[p.type]}`);
  const optional = params.filter((p) => !p.required).map((p) => `${p.name}: ${PY_TYPE[p.type]} | None = None`);
  return [...required, ...optional].join(', ');
}

/** One-line comment of a tool's parameters, for the TODO in each stub. */
export function paramSummary(params: readonly ToolParam[]): string {
  if (params.length === 0) return 'no parameters';
  return params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ');
}

/** The spec file written next to the code, so the Build page can reopen it. */
export const SPEC_FILE = 'graphmind.workflow.json';

export function specFileContent(spec: WorkflowSpec, generatorVersion: string, createdAt: string): string {
  return `${JSON.stringify({ version: 1, generator: `graphmind-ai@${generatorVersion}`, createdAt, spec }, null, 2)}\n`;
}

/** Wrap prose at ~78 columns for comments and READMEs. */
export function wrap(text: string, width = 78): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines;
}

export const GITIGNORE = `# Credentials: this file is written by the GraphMind builder and must never be committed.
.env
.env.*
!.env.example

node_modules/
dist/
.venv/
__pycache__/
`;
