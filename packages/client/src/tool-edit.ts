/**
 * Editing a held tool call's arguments (0.6.0, contract C2, workstream W2):
 * the pieces every adapter's tool wrapper shares.
 *
 *   - `toolGateOptions`: the `GateOptions` for one tool gate — `editable` +
 *     `validateInput` when the call's arguments can take an edit, `result` at
 *     the `after` gate (what the after-gate detectors inspect). Undefined while
 *     detached, so the detached gate path allocates nothing new.
 *   - `toolArgsValidator`: `mergeToolInput(live, proposed)` (top-level keys
 *     replace the live ones) followed by the tool's own schema. The verdict's
 *     `value` is what the call then runs with — the schema's PARSED output
 *     (zod defaults and transforms applied), not the raw edit.
 *   - `toolSchemaCheck`: a check for whatever schema a tool carries — zod
 *     (`safeParseAsync` / `safeParse`), any Standard Schema
 *     (`~standard.validate`), or a plain JSON Schema object, which gets
 *     `checkJsonSchemaLite`. Undefined when there is nothing to check with:
 *     the merged edit is then accepted as it is.
 *   - `checkJsonSchemaLite`: a CONSERVATIVE structural check for JSON Schema
 *     (mcp-proxy's cached `tools/list` schemas, JSON-schema tool definitions).
 *     It only refuses what it is sure the schema forbids; every keyword it
 *     does not implement passes. Bounded in depth and work, never evaluates a
 *     `pattern` (the schema may come from an untrusted MCP server: no ReDoS).
 *   - `describeIssues`: zod / Standard Schema issues as one short message that
 *     names the field and the problem and NEVER quotes a value — the
 *     validators' own messages are never used (zod 3's enum message quotes
 *     what it received).
 *
 * Nothing here throws into the host: a schema that throws while checking
 * surfaces as a rejected verdict, which the session turns into a `shape`
 * refusal with the gate still held.
 */
import {
  mergeToolInput,
  sanitizeShortText,
  type InputValidation,
  type ValidateInput,
  type ValidateInputContext,
} from './edit-input.js';
import type { GateDecision } from './gate-engine.js';
import type { GateOptions } from './session.js';

/** Checks (and parses) merged tool arguments. `value` on success is what runs. */
/**
 * Checks merged tool arguments. `context` is the session's (see
 * ValidateInputContext): a check that merges or compares against live values
 * itself must honour `inputHidden` the same way mergeToolInput does.
 */
export type SchemaCheck = (
  value: unknown,
  context?: ValidateInputContext,
) => InputValidation | PromiseLike<InputValidation>;

/** Said when a schema rejects an edit but gave nothing readable about why. */
const GENERIC_SCHEMA_MESSAGE = "the edited arguments do not match the tool's input schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Can an edit be merged into this live input? A plain object (the usual tool
 * arguments) or nothing at all (a call the model made with no arguments —
 * the classic missing-required-argument failure). A string, an array, a class
 * instance or a multi-argument call is not offered as editable.
 */
export function isEditableToolInput(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    if (!isRecord(value)) return false;
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/**
 * The validator for a tool gate: merge the proposed arguments into the live
 * ones (`mergeToolInput`), then run `check` on the result when there is one.
 */
export function toolArgsValidator(live: unknown, check?: SchemaCheck): ValidateInput {
  // `context` MUST reach mergeToolInput: when a HIDE switch covers the input,
  // the edit is judged as a full replacement, never completed from the hidden
  // live values (otherwise refuse-or-run answers leak them, one guess per edit).
  return (proposed, context) => {
    const merged = mergeToolInput(live, proposed, context);
    if (!merged.ok || check === undefined) return merged;
    return check(merged.value, context);
  };
}

/** What a tool gate can do with an edit: the live arguments and how to check an edit of them. */
export interface ToolEdit {
  /** The arguments the call runs with now (the model's, or the last accepted edit). */
  args: unknown;
  /** The tool's schema check; omitted: the merged edit is accepted as it is. */
  check?: SchemaCheck | undefined;
}

/**
 * `GateOptions` for one tool gate. `edit` makes the pause editable (the
 * session still offers it only when the app and the debugger both enabled
 * edits) — pass a function to have it evaluated only while attached;
 * `after` carries the call's result to the after-gate detectors. Undefined
 * when detached — the gate is a no-op then, and nothing is evaluated — or
 * when there is nothing to pass.
 */
export function toolGateOptions(
  session: { readonly attached: boolean },
  edit: ToolEdit | (() => ToolEdit | undefined) | undefined,
  after?: { result: unknown },
): GateOptions | undefined {
  if (!session.attached) return undefined;
  const plan = typeof edit === 'function' ? edit() : edit;
  if (plan === undefined && after === undefined) return undefined;
  const options: GateOptions = {};
  if (plan !== undefined) {
    options.editable = true;
    options.validateInput = toolArgsValidator(plan.args, plan.check);
  }
  if (after !== undefined) options.result = after.result;
  return options;
}

/**
 * The arguments an accepted edit hands the call — `decision.input` on a
 * `continue` (at `before`) or `retry` (at `after` / `error`) — or undefined
 * when the decision carries none (then the call keeps its arguments).
 */
export function editedArgs(decision: GateDecision): { args: unknown } | undefined {
  return (decision.action === 'continue' || decision.action === 'retry') && 'input' in decision
    ? { args: decision.input }
    : undefined;
}

// -- schema checks -----------------------------------------------------------

interface SafeParseLike {
  success?: unknown;
  data?: unknown;
  error?: unknown;
}

/** zod's `safeParse` result as a verdict. */
function fromSafeParse(result: unknown, value: unknown): InputValidation {
  const r = (isRecord(result) ? result : {}) as SafeParseLike;
  if (r.success === true) return { ok: true, value: r.data };
  return { ok: false, code: 'schema', message: describeValidationError(r.error, value) };
}

/** A Standard Schema `validate` result as a verdict. */
function fromStandardResult(result: unknown, value: unknown): InputValidation {
  if (isRecord(result) && Array.isArray(result['issues']) && result['issues'].length > 0) {
    return { ok: false, code: 'schema', message: describeIssues(result['issues'], value) };
  }
  if (isRecord(result) && 'value' in result) return { ok: true, value: result['value'] };
  return { ok: false, code: 'schema', message: GENERIC_SCHEMA_MESSAGE };
}

/** JSON Schema keywords that mark a plain object as a schema rather than, say, a zod raw shape. */
const JSON_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  '$schema',
];

function looksLikeJsonSchema(value: Record<string, unknown>): boolean {
  return JSON_SCHEMA_KEYWORDS.some((keyword) => Object.prototype.hasOwnProperty.call(value, keyword));
}

/**
 * A check for whatever schema a tool carries: zod (`safeParseAsync`, else
 * `safeParse`), any Standard Schema (`~standard.validate`), or a plain JSON
 * Schema object (`checkJsonSchemaLite`). Undefined when `schema` is none of
 * those. The returned check calls the schema lazily, only when an edit
 * arrives.
 */
export function toolSchemaCheck(schema: unknown): SchemaCheck | undefined {
  try {
    if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function')) return undefined;
    const s = schema as {
      safeParseAsync?: unknown;
      safeParse?: unknown;
      '~standard'?: unknown;
    };
    if (typeof s.safeParseAsync === 'function') {
      const zod = schema as { safeParseAsync: (value: unknown) => Promise<unknown> };
      return async (value) => fromSafeParse(await zod.safeParseAsync(value), value);
    }
    if (typeof s.safeParse === 'function') {
      const zod = schema as { safeParse: (value: unknown) => unknown };
      return (value) => fromSafeParse(zod.safeParse(value), value);
    }
    const standard = s['~standard'];
    if (isRecord(standard) && typeof standard['validate'] === 'function') {
      const validate = standard['validate'] as (value: unknown) => unknown;
      return async (value) => fromStandardResult(await validate.call(standard, value), value);
    }
    if (isRecord(schema) && looksLikeJsonSchema(schema)) return jsonSchemaLiteCheck(schema);
  } catch {
    // an unreadable schema is no schema
  }
  return undefined;
}

/** `checkJsonSchemaLite` as a SchemaCheck (the value passes through unchanged). */
export function jsonSchemaLiteCheck(schema: unknown): SchemaCheck {
  return (value) => {
    const problem = checkJsonSchemaLite(schema, value);
    return problem === undefined ? { ok: true, value } : { ok: false, code: 'schema', message: problem };
  };
}

// -- JSON-schema-lite ----------------------------------------------------------

/** Deeper than this, a schema (or a value) is not checked any further: it passes. */
const LITE_MAX_DEPTH = 32;
/** Work budget per check (schema nodes visited, array elements included). */
const LITE_MAX_STEPS = 20_000;
/** An array longer than this is checked only up to here. */
const LITE_MAX_ITEMS = 1_000;

type Segment = string | number;

interface LiteState {
  steps: number;
}

const KNOWN_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

/** A value's JSON type, for messages. Never the value. */
function typeName(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

const MAX_KEY_IN_MESSAGE = 48;

function shortKey(key: string): string {
  return key.length > MAX_KEY_IN_MESSAGE ? `${key.slice(0, MAX_KEY_IN_MESSAGE - 1)}…` : key;
}

/** `field "a.b[0]"`, or "the arguments object" for the top level. Keys are names, never values. */
function where(path: readonly Segment[]): string {
  if (path.length === 0) return 'the arguments object';
  let text = '';
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`;
    else text += text === '' ? shortKey(segment) : `.${shortKey(segment)}`;
  }
  return `field ${JSON.stringify(text)}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function problem(path: readonly Segment[], text: string): string {
  return sanitizeShortText(`${where(path)} ${text}`) ?? GENERIC_SCHEMA_MESSAGE;
}

/**
 * A conservative JSON Schema check. Returns undefined when `value` passes —
 * or when the check cannot tell — else one short message naming the field
 * and the problem, never quoting a value (schema bounds such as a maximum
 * may appear; they are not the input).
 *
 * Implemented: `type` (incl. arrays of types and `integer`), OpenAPI
 * `nullable`, `enum`/`const` of primitives, `required`, `properties`,
 * `additionalProperties` (false or a schema; skipped next to
 * `patternProperties`), `items` (schema or tuple), `prefixItems`,
 * `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`/
 * `exclusiveMinimum`/`exclusiveMaximum` (numeric forms), `allOf`, and
 * `anyOf`/`oneOf` (as "at least one branch"). Everything else — `$ref`,
 * `not`, `if`, `pattern`, `format`, `multipleOf`, … — passes, so the check is
 * never stricter than a real validator.
 */
export function checkJsonSchemaLite(schema: unknown, value: unknown): string | undefined {
  try {
    return liteCheck(schema, value, [], 0, { steps: 0 });
  } catch {
    return undefined;
  }
}

function liteCheck(
  schema: unknown,
  value: unknown,
  path: Segment[],
  depth: number,
  state: LiteState,
): string | undefined {
  state.steps += 1;
  if (state.steps > LITE_MAX_STEPS || depth > LITE_MAX_DEPTH) return undefined;
  if (schema === false) return problem(path, "is not allowed by the tool's schema");
  if (!isRecord(schema)) return undefined;
  if (value === null && schema['nullable'] === true) return undefined;

  const typeProblem = checkType(schema['type'], value, path);
  if (typeProblem !== undefined) return typeProblem;

  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every(isPrimitive)) {
    if (!isPrimitive(value) || !enumValues.some((allowed) => allowed === value)) {
      return problem(path, 'is not one of the allowed values');
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && isPrimitive(schema['const'])) {
    if (value !== schema['const']) return problem(path, 'is not the allowed value');
  }

  const bounds =
    typeof value === 'string'
      ? checkStringBounds(schema, value, path)
      : typeof value === 'number'
        ? checkNumberBounds(schema, value, path)
        : undefined;
  if (bounds !== undefined) return bounds;

  if (Array.isArray(value)) {
    const arrayProblem = checkArray(schema, value, path, depth, state);
    if (arrayProblem !== undefined) return arrayProblem;
  } else if (isRecord(value)) {
    const objectProblem = checkObject(schema, value, path, depth, state);
    if (objectProblem !== undefined) return objectProblem;
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      const found = liteCheck(branch, value, path, depth + 1, state);
      if (found !== undefined) return found;
    }
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const passes = branches.some((branch) => liteCheck(branch, value, path, depth + 1, state) === undefined);
    if (!passes) return problem(path, 'does not match any of the allowed shapes');
  }
  return undefined;
}

function checkType(type: unknown, value: unknown, path: Segment[]): string | undefined {
  let types: string[] | undefined;
  if (typeof type === 'string') types = [type];
  else if (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === 'string')) types = type;
  if (types === undefined || !types.every((t) => KNOWN_TYPES.has(t))) return undefined;
  if (types.some((t) => typeMatches(t, value))) return undefined;
  if (value === undefined) return problem(path, 'is required');
  return problem(path, `must be ${types.join(' or ')}, got ${typeName(value)}`);
}

function checkStringBounds(schema: Record<string, unknown>, value: string, path: Segment[]): string | undefined {
  const min = finiteNumber(schema['minLength']);
  const max = finiteNumber(schema['maxLength']);
  if (min === undefined && max === undefined) return undefined;
  let length = 0;
  for (const _ of value) length += 1; // code points, as JSON Schema counts
  if (min !== undefined && length < min) return problem(path, `is too short (at least ${min} characters)`);
  if (max !== undefined && length > max) return problem(path, `is too long (at most ${max} characters)`);
  return undefined;
}

function checkNumberBounds(schema: Record<string, unknown>, value: number, path: Segment[]): string | undefined {
  const minimum = finiteNumber(schema['minimum']);
  const maximum = finiteNumber(schema['maximum']);
  const exclusiveMinimum = finiteNumber(schema['exclusiveMinimum']);
  const exclusiveMaximum = finiteNumber(schema['exclusiveMaximum']);
  if (minimum !== undefined && value < minimum) return problem(path, `must be at least ${minimum}`);
  if (maximum !== undefined && value > maximum) return problem(path, `must be at most ${maximum}`);
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
    return problem(path, `must be greater than ${exclusiveMinimum}`);
  }
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
    return problem(path, `must be less than ${exclusiveMaximum}`);
  }
  return undefined;
}

function checkArray(
  schema: Record<string, unknown>,
  value: unknown[],
  path: Segment[],
  depth: number,
  state: LiteState,
): string | undefined {
  const minItems = finiteNumber(schema['minItems']);
  const maxItems = finiteNumber(schema['maxItems']);
  if (minItems !== undefined && value.length < minItems) return problem(path, `has too few items (at least ${minItems})`);
  if (maxItems !== undefined && value.length > maxItems) return problem(path, `has too many items (at most ${maxItems})`);
  const prefix = Array.isArray(schema['prefixItems'])
    ? (schema['prefixItems'] as unknown[])
    : Array.isArray(schema['items'])
      ? (schema['items'] as unknown[])
      : [];
  // `items` as one schema applies to every element (draft 7), or to the ones
  // after `prefixItems` (2020-12). Tuple-form `items` has no "rest" here.
  const rest = Array.isArray(schema['items']) ? undefined : schema['items'];
  const count = Math.min(value.length, LITE_MAX_ITEMS);
  for (let index = 0; index < count; index += 1) {
    const itemSchema = index < prefix.length ? prefix[index] : rest;
    if (itemSchema === undefined) continue;
    const found = liteCheck(itemSchema, value[index], [...path, index], depth + 1, state);
    if (found !== undefined) return found;
    if (state.steps > LITE_MAX_STEPS) return undefined;
  }
  return undefined;
}

function checkObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: Segment[],
  depth: number,
  state: LiteState,
): string | undefined {
  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== 'string') continue;
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
        return problem([...path, key], 'is required');
      }
    }
  }
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
  const additional = schema['additionalProperties'];
  const patterned = schema['patternProperties'] !== undefined;
  for (const key of Object.keys(value)) {
    const declared = properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key);
    if (declared) {
      const found = liteCheck(properties[key], value[key], [...path, key], depth + 1, state);
      if (found !== undefined) return found;
    } else if (!patterned) {
      if (additional === false) return problem([...path, key], "is not a parameter of this tool (the schema allows no other keys)");
      if (isRecord(additional)) {
        const found = liteCheck(additional, value[key], [...path, key], depth + 1, state);
        if (found !== undefined) return found;
      }
    }
    if (state.steps > LITE_MAX_STEPS) return undefined;
  }
  return undefined;
}

// -- issue descriptions ------------------------------------------------------------

/** A short identifier from a validator's issue (a type or format name), else undefined. */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_ -]{0,31}$/.test(value) ? value : undefined;
}

function boundOf(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  const n = finiteNumber(value);
  return n === undefined ? undefined : String(n);
}

/** zod / Standard Schema issue paths: keys, indices, or `{key}` segments. */
function readPath(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  const path: Segment[] = [];
  for (const entry of raw.slice(0, 32)) {
    const segment = isRecord(entry) && 'key' in entry ? entry['key'] : entry;
    if (typeof segment === 'number') path.push(segment);
    else if (typeof segment === 'string') path.push(segment);
    else if (typeof segment === 'symbol') path.push(segment.description ?? 'symbol');
  }
  return path;
}

/** The value at `path` inside `root`, reading own data only. Undefined when absent. */
function valueAt(root: unknown, path: readonly Segment[]): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[String(segment)];
  }
  return current;
}

function sizeProblem(issue: Record<string, unknown>, big: boolean): string {
  const origin = identifier(issue['origin']) ?? identifier(issue['type']);
  const bound = boundOf(big ? issue['maximum'] : issue['minimum']);
  const limit = bound === undefined ? '' : ` (${big ? 'at most' : 'at least'} ${bound}${origin === 'string' ? ' characters' : ''})`;
  if (origin === 'string') return `${big ? 'is too long' : 'is too short'}${limit}`;
  if (origin === 'array' || origin === 'set') return `${big ? 'has too many items' : 'has too few items'}${limit}`;
  if (origin === 'date') return big ? 'is too late' : 'is too early';
  return `${big ? 'is too large' : 'is too small'}${limit}`;
}

function issueProblem(issue: Record<string, unknown>, at: unknown): string {
  switch (issue['code']) {
    case 'invalid_type': {
      const expected = identifier(issue['expected']);
      if (at === undefined) return expected === undefined ? 'is required' : `is required (${expected})`;
      return expected === undefined ? `has the wrong type (${typeName(at)})` : `must be ${expected}, got ${typeName(at)}`;
    }
    case 'too_small':
      return sizeProblem(issue, false);
    case 'too_big':
      return sizeProblem(issue, true);
    case 'invalid_value':
    case 'invalid_enum_value':
    case 'invalid_literal':
      return 'is not one of the allowed values';
    case 'unrecognized_keys': {
      const keys = Array.isArray(issue['keys']) ? issue['keys'].filter((k): k is string => typeof k === 'string') : [];
      if (keys.length === 0) return 'has keys the schema does not allow';
      const named = keys.slice(0, 3).map((key) => JSON.stringify(shortKey(key))).join(', ');
      return `has ${keys.length === 1 ? 'a key' : 'keys'} the schema does not allow: ${named}${keys.length > 3 ? ', …' : ''}`;
    }
    case 'invalid_format':
    case 'invalid_string': {
      const format = identifier(issue['format']) ?? identifier(issue['validation']);
      return format === undefined ? 'is not in the expected format' : `is not a valid ${format}`;
    }
    case 'not_multiple_of': {
      const divisor = boundOf(issue['divisor']) ?? boundOf(issue['multipleOf']);
      return divisor === undefined ? 'is not an allowed multiple' : `is not a multiple of ${divisor}`;
    }
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return 'does not match any of the allowed shapes';
    case 'invalid_date':
      return 'is not a valid date';
    case 'not_finite':
      return 'must be a finite number';
    case 'custom':
      return "failed a check in the tool's schema";
    default:
      return 'is invalid';
  }
}

/**
 * Validation issues (zod 3 / 4, any Standard Schema) as one short message:
 * the first issue's field and problem, plus how many more there are. Built
 * from the issue's code, path and schema bounds only — never its `message`
 * and never a value (`value` is read only for the TYPE at the path).
 */
export function describeIssues(issues: unknown, value?: unknown): string {
  try {
    if (!Array.isArray(issues) || issues.length === 0) return GENERIC_SCHEMA_MESSAGE;
    const first = issues[0];
    if (!isRecord(first)) return GENERIC_SCHEMA_MESSAGE;
    const path = readPath(first['path']);
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more problem${issues.length > 2 ? 's' : ''})` : '';
    return sanitizeShortText(`${where(path)} ${issueProblem(first, valueAt(value, path))}${more}`) ?? GENERIC_SCHEMA_MESSAGE;
  } catch {
    return GENERIC_SCHEMA_MESSAGE;
  }
}

/**
 * A validator's error object (a ZodError's `issues`, or a wrapper whose
 * `cause` holds the issues — the AI SDK's TypeValidationError) as
 * `describeIssues` would say it. Never reads the error's own message: it may
 * quote the value.
 */
export function describeValidationError(error: unknown, value?: unknown): string {
  try {
    if (Array.isArray(error)) return describeIssues(error, value);
    if (typeof error !== 'object' || error === null) return GENERIC_SCHEMA_MESSAGE;
    const record = error as Record<string, unknown>;
    if (Array.isArray(record['issues'])) return describeIssues(record['issues'], value);
    const cause = record['cause'];
    if (Array.isArray(cause)) return describeIssues(cause, value);
    if (typeof cause === 'object' && cause !== null && Array.isArray((cause as Record<string, unknown>)['issues'])) {
      return describeIssues((cause as Record<string, unknown>)['issues'], value);
    }
  } catch {
    // fall through
  }
  return GENERIC_SCHEMA_MESSAGE;
}
