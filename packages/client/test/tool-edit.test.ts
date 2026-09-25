/**
 * The shared pieces of tool-argument edits (W2): the conservative
 * JSON-schema-lite checker, value-free issue descriptions, the schema-kind
 * sniffing, the per-gate options and the merge-then-check validator. The
 * adapters' suites prove the wiring; these pin the rules.
 */
import { describe, expect, it } from 'vitest';
import {
  checkJsonSchemaLite,
  describeIssues,
  describeValidationError,
  editedArgs,
  isEditableToolInput,
  jsonSchemaLiteCheck,
  toolArgsValidator,
  toolGateOptions,
  toolSchemaCheck,
  type InputValidation,
} from '../src/index.js';

const SECRET = 'SECRET-VALUE-9f3';

describe('checkJsonSchemaLite', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 5 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      ratio: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      mode: { enum: ['fast', 'slow'] },
      kind: { const: 'search' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
      nested: {
        type: 'object',
        properties: { deep: { type: ['string', 'null'] } },
        required: ['deep'],
        additionalProperties: false,
      },
      maybe: { type: 'string', nullable: true },
    },
    required: ['query'],
    additionalProperties: false,
  };

  it('passes a value that fits', () => {
    expect(
      checkJsonSchemaLite(schema, {
        query: 'ams',
        limit: 3,
        ratio: 0.5,
        mode: 'fast',
        kind: 'search',
        tags: ['a'],
        nested: { deep: null },
        maybe: null,
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ limit: 3 }, 'field "query" is required'],
    [{ query: 42 }, 'field "query" must be string, got integer'],
    [{ query: 'a' }, 'field "query" is too short (at least 2 characters)'],
    [{ query: 'abcdef' }, 'field "query" is too long (at most 5 characters)'],
    [{ query: 'ok', limit: 2.5 }, 'field "limit" must be integer, got number'],
    [{ query: 'ok', limit: 0 }, 'field "limit" must be at least 1'],
    [{ query: 'ok', limit: 51 }, 'field "limit" must be at most 50'],
    [{ query: 'ok', ratio: 0 }, 'field "ratio" must be greater than 0'],
    [{ query: 'ok', ratio: 1 }, 'field "ratio" must be less than 1'],
    [{ query: 'ok', mode: 'medium' }, 'field "mode" is not one of the allowed values'],
    [{ query: 'ok', kind: 'other' }, 'field "kind" is not the allowed value'],
    [{ query: 'ok', tags: [] }, 'field "tags" has too few items (at least 1)'],
    [{ query: 'ok', tags: ['a', 'b', 'c'] }, 'field "tags" has too many items (at most 2)'],
    [{ query: 'ok', tags: ['a', 7] }, 'field "tags[1]" must be string, got integer'],
    [{ query: 'ok', nested: {} }, 'field "nested.deep" is required'],
    [{ query: 'ok', nested: { deep: 1 } }, 'field "nested.deep" must be string or null, got integer'],
    [{ query: 'ok', nested: { deep: 'x', extra: 1 } }, 'field "nested.extra" is not a parameter of this tool'],
    [{ query: 'ok', other: true }, 'field "other" is not a parameter of this tool'],
    [{ query: 'ok', maybe: 3 }, 'field "maybe" must be string, got integer'],
  ])('refuses %j: %s', (value, message) => {
    expect(checkJsonSchemaLite(schema, value)).toContain(message);
  });

  it('never quotes the value, whatever the problem', () => {
    const values = [
      { query: SECRET },
      { query: 'ok', mode: SECRET },
      { query: 'ok', kind: SECRET },
      { query: 'ok', limit: SECRET },
      { query: 'ok', tags: [SECRET, 1] },
      { query: 'ok', [SECRET.toLowerCase()]: SECRET },
    ];
    for (const value of values) {
      const problem = checkJsonSchemaLite(schema, value) ?? '';
      expect(problem.length).toBeGreaterThan(0);
      expect(problem).not.toContain(SECRET);
    }
  });

  it('is conservative: keywords it does not implement pass', () => {
    const lenient = [
      [{ type: 'string', pattern: '^(a+)+$' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'],
      [{ type: 'string', format: 'email' }, 'not-an-email'],
      [{ $ref: '#/definitions/x' }, 123],
      [{ not: { type: 'string' } }, 'a string'],
      [{ if: { type: 'string' }, then: { minLength: 99 } }, 'short'],
      [{ type: 'number', multipleOf: 0.1 }, 0.30000000000000004],
      [{ type: 'object', patternProperties: { '^x': {} }, additionalProperties: false }, { y: 1 }],
      [{ type: 'weird-type' }, 1],
      [{ enum: [{ a: 1 }, 'x'] }, 'y'],
      [{ const: { a: 1 } }, { a: 2 }],
      [{ exclusiveMinimum: true, minimum: 1 }, 1],
      [true, 'anything'],
      [undefined, 'anything'],
      ['not a schema', 1],
    ] as const;
    for (const [s, value] of lenient) expect(checkJsonSchemaLite(s, value), JSON.stringify(s)).toBeUndefined();
  });

  it('anyOf / oneOf pass when any branch passes, and refuse only when none does', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'object', required: ['id'] }] };
    expect(checkJsonSchemaLite(s, 'x')).toBeUndefined();
    expect(checkJsonSchemaLite(s, { id: 1 })).toBeUndefined();
    expect(checkJsonSchemaLite(s, 5)).toContain('does not match any of the allowed shapes');
    const one = { oneOf: [{ type: 'number' }, { type: 'integer' }] }; // 1 matches both: still passes
    expect(checkJsonSchemaLite(one, 1)).toBeUndefined();
    expect(checkJsonSchemaLite({ allOf: [{ type: 'object' }, { required: ['a'] }] }, {})).toContain('field "a" is required');
  });

  it('tuple items and prefixItems are positional', () => {
    expect(checkJsonSchemaLite({ items: [{ type: 'string' }, { type: 'number' }] }, ['a', 'b'])).toContain(
      'field "[1]" must be number',
    );
    expect(
      checkJsonSchemaLite({ prefixItems: [{ type: 'string' }], items: { type: 'boolean' } }, ['a', true, 3]),
    ).toContain('field "[2]" must be boolean');
  });

  it('a false subschema forbids its key', () => {
    expect(checkJsonSchemaLite({ properties: { gone: false } }, { gone: 1 })).toContain('field "gone" is not allowed');
  });

  it('additionalProperties as a schema checks the extra keys', () => {
    expect(checkJsonSchemaLite({ additionalProperties: { type: 'number' } }, { a: 1, b: 'x' })).toContain(
      'field "b" must be number, got string',
    );
  });

  it('does not see through the prototype: a key named like an Object method is just a key', () => {
    const s = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(checkJsonSchemaLite(s, { constructor: 1 })).toContain('field "constructor" is not a parameter');
    expect(checkJsonSchemaLite({ required: ['toString'] }, {})).toContain('field "toString" is required');
  });

  it('stays bounded on hostile schemas: deep nesting and huge arrays pass instead of hanging', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    let value: unknown = 1;
    for (let i = 0; i < 200; i += 1) {
      deep = { type: 'object', properties: { x: deep } };
      value = { x: value };
    }
    expect(checkJsonSchemaLite(deep, value)).toBeUndefined();
    const big = Array.from({ length: 50_000 }, () => 'a');
    const started = performance.now();
    expect(checkJsonSchemaLite({ type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'string' }] } }, big)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('an enum costs its size once, never once per value checked against it', () => {
    // A tools/list schema with a huge enum, and an edit with many items.
    const values = Array.from({ length: 200_000 }, (_, i) => `v${i}`);
    let reads = 0;
    const counted = new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const schema = { type: 'array', items: { enum: counted } };
    const edit = Array.from({ length: 1_000 }, (_, i) => `v${i * 7}`);
    const started = performance.now();
    checkJsonSchemaLite(schema, edit);
    // Indexed once (not 1,000 x 200,000 reads); a later check reuses the index
    // and checks every item.
    expect(reads).toBeLessThanOrEqual(2 * values.length);
    const before = reads;
    expect(checkJsonSchemaLite(schema, edit)).toBeUndefined();
    expect(checkJsonSchemaLite(schema, [...edit.slice(0, 500), 'nope'])).toBe('field "[500]" is not one of the allowed values');
    expect(reads).toBe(before);
    expect(performance.now() - started).toBeLessThan(1_000);
    // A small enum still refuses on the first check.
    expect(checkJsonSchemaLite({ enum: ['fast', 'slow'] }, 'medium')).toBe('the arguments object is not one of the allowed values');
  });

  it('never throws, even on a schema whose getters throw', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        has() {
          throw new Error('boom');
        },
      },
    );
    expect(checkJsonSchemaLite(hostile, { a: 1 })).toBeUndefined();
    expect(checkJsonSchemaLite({ properties: hostile }, { a: 1 })).toBeUndefined();
  });

  it('long keys are shortened in the message', () => {
    const key = 'k'.repeat(300);
    const message = checkJsonSchemaLite({ additionalProperties: false }, { [key]: 1 }) ?? '';
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).toContain('…');
  });

  it('jsonSchemaLiteCheck returns the value untouched on success and code schema on failure', () => {
    const check = jsonSchemaLiteCheck({ type: 'object', required: ['a'] });
    const value = { a: 1 };
    expect(check(value)).toEqual({ ok: true, value });
    expect((check(value) as { value: unknown }).value).toBe(value);
    expect(check({})).toEqual({ ok: false, code: 'schema', message: 'field "a" is required' });
  });
});

describe('describeIssues / describeValidationError', () => {
  it.each([
    [{ code: 'invalid_type', expected: 'string', path: ['q'] }, { q: 5 }, 'field "q" must be string, got integer'],
    [{ code: 'invalid_type', expected: 'string', path: ['q'] }, {}, 'field "q" is required (string)'],
    [{ code: 'invalid_type', expected: 'number', received: SECRET, path: ['a', 0, 'b'] }, { a: [{ b: 'x' }] }, 'field "a[0].b" must be number, got string'],
    [{ code: 'too_small', origin: 'string', minimum: 3, path: ['q'] }, { q: 'a' }, 'field "q" is too short (at least 3 characters)'],
    [{ code: 'too_big', origin: 'number', maximum: 10, path: ['n'] }, { n: 11 }, 'field "n" is too large (at most 10)'],
    [{ code: 'too_small', type: 'array', minimum: 1, path: ['tags'] }, { tags: [] }, 'field "tags" has too few items (at least 1)'],
    [{ code: 'invalid_value', values: [SECRET], path: ['m'] }, { m: SECRET }, 'field "m" is not one of the allowed values'],
    [{ code: 'invalid_enum_value', received: SECRET, options: ['a'], path: ['m'] }, {}, 'field "m" is not one of the allowed values'],
    [{ code: 'unrecognized_keys', keys: ['x', 'y'], path: [] }, {}, 'the arguments object has keys the schema does not allow: "x", "y"'],
    [{ code: 'invalid_format', format: 'email', path: ['e'] }, {}, 'field "e" is not a valid email'],
    [{ code: 'invalid_string', validation: 'uuid', path: ['id'] }, {}, 'field "id" is not a valid uuid'],
    [{ code: 'not_multiple_of', divisor: 5, path: ['n'] }, {}, 'field "n" is not a multiple of 5'],
    [{ code: 'invalid_union', path: ['u'] }, {}, 'field "u" does not match any of the allowed shapes'],
    [{ code: 'custom', message: `bad ${SECRET}`, path: ['c'] }, {}, "field \"c\" failed a check in the tool's schema"],
    [{ message: `whatever ${SECRET}`, path: [{ key: 'std' }] }, {}, 'field "std" is invalid'],
  ])('%j', (issue, value, message) => {
    const text = describeIssues([issue], value);
    expect(text).toBe(message);
    expect(text).not.toContain(SECRET);
  });

  it('counts the other problems', () => {
    expect(describeIssues([{ code: 'custom', path: ['a'] }, { code: 'custom' }, { code: 'custom' }])).toBe(
      "field \"a\" failed a check in the tool's schema (and 2 more problems)",
    );
  });

  it('never uses the error message (it may quote the value)', () => {
    const zodError = Object.assign(new Error(`Invalid: received "${SECRET}"`), {
      issues: [{ code: 'invalid_type', expected: 'number', path: ['a'], message: SECRET }],
    });
    expect(describeValidationError(zodError, { a: 'x' })).toBe('field "a" must be number, got string');
    const wrapped = Object.assign(new Error(`Type validation failed: Value: {"a":"${SECRET}"}`), {
      cause: [{ message: SECRET, path: ['a'] }],
    });
    expect(describeValidationError(wrapped)).toBe('field "a" is invalid');
    expect(describeValidationError(new Error(SECRET))).not.toContain(SECRET);
    expect(describeValidationError({ cause: { issues: [{ code: 'custom', path: [] }] } })).toContain('the arguments');
    expect(describeValidationError(undefined)).toBe("the edited arguments do not match the tool's input schema");
    expect(describeIssues('nope')).toBe("the edited arguments do not match the tool's input schema");
  });
});

describe('toolSchemaCheck', () => {
  it('uses safeParseAsync, then safeParse (zod), keeping the parsed value', async () => {
    const asyncZod = {
      safeParseAsync: async (v: unknown) =>
        (v as { n?: unknown }).n === 1
          ? { success: true, data: { n: 1, parsed: true } }
          : { success: false, error: { issues: [{ code: 'invalid_type', expected: 'number', path: ['n'] }] } },
      safeParse: () => {
        throw new Error('not this one');
      },
    };
    const check = toolSchemaCheck(asyncZod);
    expect(await check?.({ n: 1 })).toEqual({ ok: true, value: { n: 1, parsed: true } });
    expect(await check?.({ n: 'x' })).toEqual({ ok: false, code: 'schema', message: 'field "n" must be number, got string' });

    const syncZod = { safeParse: (v: unknown) => ({ success: true, data: v }) };
    expect(await toolSchemaCheck(syncZod)?.({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
  });

  it('uses a Standard Schema validate', async () => {
    const standard = {
      '~standard': {
        version: 1,
        vendor: 'x',
        validate: async (v: unknown) =>
          (v as { ok?: unknown }).ok === true ? { value: { ok: true, extra: 1 } } : { issues: [{ message: SECRET, path: ['ok'] }] },
      },
    };
    const check = toolSchemaCheck(standard);
    expect(await check?.({ ok: true })).toEqual({ ok: true, value: { ok: true, extra: 1 } });
    const refused = (await check?.({ ok: false })) as InputValidation;
    expect(refused).toEqual({ ok: false, code: 'schema', message: 'field "ok" is invalid' });
  });

  it('uses the lite checker for a plain JSON Schema object', async () => {
    const check = toolSchemaCheck({ type: 'object', properties: { a: { type: 'string' } } });
    expect(await check?.({ a: 1 })).toEqual({ ok: false, code: 'schema', message: 'field "a" must be string, got integer' });
  });

  it('is undefined for nothing it can use (no schema: the merged edit is accepted)', () => {
    for (const value of [undefined, null, 1, 'x', {}, { a: { anything: 1 } }, () => {}]) {
      expect(toolSchemaCheck(value)).toBeUndefined();
    }
  });

  it('a schema whose check throws rejects (the session turns that into a shape refusal)', async () => {
    const check = toolSchemaCheck({
      safeParseAsync: async () => {
        throw new Error('boom');
      },
    });
    await expect(Promise.resolve(check?.({}))).rejects.toThrow('boom');
  });
});

/** The session's context for an input the debugger can see. */
const VISIBLE = { inputHidden: false } as const;

describe('toolArgsValidator', () => {
  it('merges (top-level keys replace) and then checks', async () => {
    const seen: unknown[] = [];
    const validate = toolArgsValidator({ a: 1, b: 2 }, (value) => {
      seen.push(value);
      return { ok: true, value: { ...(value as object), checked: true } };
    });
    expect(await validate({ b: 3 }, VISIBLE)).toEqual({ ok: true, value: { a: 1, b: 3, checked: true } });
    expect(seen).toEqual([{ a: 1, b: 3 }]);
  });

  it('refuses a proposal that is not an object before the check runs', async () => {
    let ran = false;
    const validate = toolArgsValidator({ a: 1 }, () => {
      ran = true;
      return { ok: true, value: 1 };
    });
    expect(await validate([1], VISIBLE)).toMatchObject({ ok: false, code: 'shape' });
    expect(await validate(JSON.parse('{"__proto__":{"x":1}}'), VISIBLE)).toMatchObject({ ok: false, code: 'shape' });
    expect(ran).toBe(false);
  });

  it('without a check the merged object is the verdict', async () => {
    expect(await toolArgsValidator(undefined)({ q: 'x' }, VISIBLE)).toEqual({ ok: true, value: { q: 'x' } });
  });

  // Integration defect found when the tool gates met the W0 fixes: the
  // validator dropped the session's context, so under a HIDE switch an edit
  // was completed from the hidden live arguments and the refuse-or-run answer
  // (repeatable while the gate stays held) revealed them.
  it('under a hidden input the edit is a FULL replacement: never completed from, or checked against, live values', async () => {
    const seen: Array<{ value: unknown; hidden: unknown }> = [];
    const validate = toolArgsValidator({ secret: 'hunter2', keep: 1 }, (value, context) => {
      seen.push({ value, hidden: context?.inputHidden });
      return { ok: true, value };
    });
    expect(await validate({ keep: 2 }, { inputHidden: true })).toEqual({ ok: true, value: { keep: 2 } });
    expect(await validate({ keep: 2 }, { inputHidden: false })).toEqual({
      ok: true,
      value: { secret: 'hunter2', keep: 2 },
    });
    expect(seen).toEqual([
      { value: { keep: 2 }, hidden: true },
      { value: { secret: 'hunter2', keep: 2 }, hidden: false },
    ]);
  });
});

describe("toolArgsValidator: a schema's transforms never run twice", () => {
  /** dollars -> cents, the way zod's `.transform(d => d * 100)` parses. */
  const cents = (value: unknown): InputValidation => {
    const v = value as { dollars?: unknown; memo?: unknown };
    if (typeof v.dollars !== 'number' || typeof v.memo !== 'string') return { ok: false, code: 'schema' };
    return { ok: true, value: { dollars: v.dollars * 100, memo: v.memo } };
  };
  const decisionFor = (verdict: InputValidation) =>
    ({ action: 'continue', input: (verdict as { value: unknown }).value }) as const;

  it('parsed live arguments with their raw input: the edit merges into the raw input and parses once', async () => {
    const validate = toolArgsValidator({ dollars: 500, memo: 'x' }, cents, { parsed: true, input: { dollars: 5, memo: 'x' } });
    const verdict = await validate({ memo: 'y' }, VISIBLE);
    expect(verdict).toEqual({ ok: true, value: { dollars: 500, memo: 'y' } });
    // editedArgs hands back what runs AND the merged raw input, for the next edit.
    expect(editedArgs(decisionFor(verdict))).toEqual({
      args: { dollars: 500, memo: 'y' },
      input: { dollars: 5, memo: 'y' },
    });
  });

  it('a raw input the schema does not parse into the live arguments is not trusted', async () => {
    // Stale (or repaired by the host) copy: 7 dollars would parse to 700, not 500.
    const validate = toolArgsValidator({ dollars: 500, memo: 'x' }, cents, { parsed: true, input: { dollars: 7, memo: 'x' } });
    expect(await validate({ memo: 'y' }, VISIBLE)).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('parsed live arguments without a raw input: a partial edit is refused unless the schema leaves them unchanged', async () => {
    const validate = toolArgsValidator({ dollars: 500, memo: 'x' }, cents, { parsed: true });
    const refused = await validate({ memo: 'y' }, VISIBLE);
    expect(refused).toMatchObject({ ok: false, code: 'unsupported' });
    expect(JSON.stringify(refused)).not.toContain('500');
    // A full replacement never keeps a live value: parsed once, from the edit.
    expect(await validate({ dollars: 7, memo: 'y' }, VISIBLE)).toEqual({ ok: true, value: { dollars: 700, memo: 'y' } });
    // An idempotent schema (defaults, trims) takes partial edits as before.
    const trim = (value: unknown): InputValidation => ({
      ok: true,
      value: { ...(value as object), q: String((value as { q: unknown }).q).trim() },
    });
    expect(await toolArgsValidator({ q: 'a', n: 1 }, trim, { parsed: true })({ q: ' b ' }, VISIBLE)).toEqual({
      ok: true,
      value: { q: 'b', n: 1 },
    });
  });

  it('a hidden input stays a full replacement: the live values decide nothing', async () => {
    const validate = toolArgsValidator({ dollars: 500, memo: 'x' }, cents, { parsed: true });
    expect(await validate({ dollars: 1, memo: 'y' }, { inputHidden: true })).toEqual({ ok: true, value: { dollars: 100, memo: 'y' } });
    expect(await validate({ memo: 'y' }, { inputHidden: true })).toMatchObject({ ok: false, code: 'schema' });
  });

  it('runMerged: the check only judges, the merged arguments run', async () => {
    const validate = toolArgsValidator({ dollars: 5, memo: 'x' }, cents, { runMerged: true });
    const verdict = await validate({ memo: 'y' }, VISIBLE);
    expect(verdict).toEqual({ ok: true, value: { dollars: 5, memo: 'y' } });
    expect(editedArgs(decisionFor(verdict))).toEqual({ args: { dollars: 5, memo: 'y' }, input: { dollars: 5, memo: 'y' } });
    expect(await validate({ dollars: 'five' }, VISIBLE)).toMatchObject({ ok: false, code: 'schema' });
  });
});

describe('toolGateOptions / editedArgs / isEditableToolInput', () => {
  it('detached: undefined, whatever is passed (the gate is a no-op)', () => {
    expect(toolGateOptions({ attached: false }, { args: { a: 1 } }, { result: 1 })).toBeUndefined();
  });

  it('attached: editable + validateInput for an edit, result at after, undefined when neither', () => {
    const options = toolGateOptions({ attached: true }, { args: { a: 1 } });
    expect(options?.editable).toBe(true);
    expect(typeof options?.validateInput).toBe('function');
    expect('result' in (options ?? {})).toBe(false);
    const after = toolGateOptions({ attached: true }, undefined, { result: undefined });
    expect(after).toEqual({ result: undefined });
    expect('result' in (after ?? {})).toBe(true);
    expect(toolGateOptions({ attached: true }, undefined)).toBeUndefined();
  });

  it('editedArgs reads decision.input on continue / retry only', () => {
    expect(editedArgs({ action: 'continue' })).toBeUndefined();
    expect(editedArgs({ action: 'retry' })).toBeUndefined();
    expect(editedArgs({ action: 'continue', input: { a: 1 } })).toEqual({ args: { a: 1 } });
    expect(editedArgs({ action: 'retry', input: undefined })).toEqual({ args: undefined });
    expect(editedArgs({ action: 'inject', output: { a: 1 } })).toBeUndefined();
    expect(editedArgs({ action: 'abort' })).toBeUndefined();
  });

  it('isEditableToolInput: plain objects and nothing; not strings, arrays or class instances', () => {
    expect(isEditableToolInput({ a: 1 })).toBe(true);
    expect(isEditableToolInput(Object.create(null))).toBe(true);
    expect(isEditableToolInput(undefined)).toBe(true);
    for (const value of [null, 'x', 1, [1], new Date(), new (class Args {})()]) {
      expect(isEditableToolInput(value)).toBe(false);
    }
    // A hostile input never throws into the host: it is simply not editable.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(isEditableToolInput(hostile)).toBe(false);
  });

  it('toolGateOptions evaluates a lazy edit only while attached', () => {
    let calls = 0;
    const lazy = () => {
      calls += 1;
      return { args: { a: 1 } };
    };
    expect(toolGateOptions({ attached: false }, lazy)).toBeUndefined();
    expect(calls).toBe(0);
    expect(toolGateOptions({ attached: true }, lazy)?.editable).toBe(true);
    expect(calls).toBe(1);
    expect(toolGateOptions({ attached: true }, () => undefined)).toBeUndefined();
  });
});
