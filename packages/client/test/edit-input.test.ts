/**
 * The pure pieces of edited input (contract C2): the default merge for tool
 * arguments, the placeholder / truncation guard, the validator-result
 * normaliser, the wire-text sanitiser and the wire copy of an accepted edit.
 * The session-level state machine is in edit-input-session.test.ts. The
 * shared conformance fixture (fixtures/edit-input.json) closes the file.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_PREVIEW_NOTE_PREFIX, TRUNCATION_SUFFIX, serializePayload } from '@graphmind-ai/schema';
import {
  MAX_REFUSAL_MESSAGE,
  VALIDATOR_FAILED,
  mergeToolInput,
  normalizeValidation,
  prototypeKeyRefusal,
  proposedValueRefusal,
  sanitizeShortText,
  wireCopy,
} from '../src/edit-input.js';
import { REDACTED, mergeToolInput as exported } from '../src/index.js';

/** The read-only MCP server's preview of a big value (packages/cli/src/mcp/run-model.ts `compactPayload`). */
function mcpPreview(value: unknown, maxChars = 4000): { truncated: true; note: string; preview: string } {
  const json = JSON.stringify(value);
  return {
    truncated: true,
    note: `${MCP_PREVIEW_NOTE_PREFIX}${maxChars} of ${json.length} JSON characters — open the deep link in the GraphMind viewer for the full payload`,
    preview: json.slice(0, maxChars),
  };
}

describe('mergeToolInput — the default edit rule for tool arguments', () => {
  it('is exported from the package entry point', () => {
    expect(exported).toBe(mergeToolInput);
  });

  it('top-level keys replace live ones; unmentioned keys keep their LIVE values', () => {
    const liveDate = new Date(0);
    const live = { query: 'AMS', limit: 10, since: liveDate, nested: { a: 1, b: 2 } };
    const result = mergeToolInput(live, { query: 'LIS', nested: { a: 9 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ query: 'LIS', limit: 10, since: liveDate, nested: { a: 9 } });
    const value = result.value as Record<string, unknown>;
    // The live value itself, not a copy of the recorded one (a Date stays a Date).
    expect(value['since']).toBe(liveDate);
    // Nested values are replaced whole, never deep-merged.
    expect(value['nested']).toEqual({ a: 9 });
  });

  it('returns a new object and modifies neither argument', () => {
    const live = { a: 1, b: 2 };
    const proposed = { b: 3, c: 4 };
    const result = mergeToolInput(live, proposed);
    expect(result).toEqual({ ok: true, value: { a: 1, b: 3, c: 4 } });
    expect(live).toEqual({ a: 1, b: 2 });
    expect(proposed).toEqual({ b: 3, c: 4 });
    if (result.ok) {
      expect(result.value).not.toBe(live);
      expect(result.value).not.toBe(proposed);
    }
  });

  it('keeps keys whose edited value is undefined-free JSON, including falsy values', () => {
    const result = mergeToolInput({ a: 'x', b: 'y', c: 'z' }, { a: null, b: 0, c: '' });
    expect(result).toEqual({ ok: true, value: { a: null, b: 0, c: '' } });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'query=LIS'],
    ['a number', 42],
    ['a boolean', true],
    ['an empty array', []],
    ['an array of objects', [{ query: 'LIS' }]],
    ['a function', () => ({ query: 'LIS' })],
  ])('refuses %s as the edited arguments (code shape)', (_label, proposed) => {
    const result = mergeToolInput({ query: 'AMS' }, proposed);
    expect(result).toMatchObject({ ok: false, code: 'shape' });
    if (!result.ok) expect(result.message).toMatch(/JSON object/);
  });

  it('refuses objects that are not plain JSON objects (class instances, Map, Date)', () => {
    class Args {
      query = 'LIS';
    }
    for (const proposed of [new Args(), new Map([['query', 'LIS']]), new Date(0)]) {
      expect(mergeToolInput({ query: 'AMS' }, proposed)).toMatchObject({ ok: false, code: 'shape' });
    }
  });

  it('accepts a null-prototype object', () => {
    const proposed = Object.assign(Object.create(null) as Record<string, unknown>, { query: 'LIS' });
    expect(mergeToolInput({ query: 'AMS', limit: 1 }, proposed)).toEqual({
      ok: true,
      value: { query: 'LIS', limit: 1 },
    });
  });

  it('arrays are ordinary values inside the arguments', () => {
    const result = mergeToolInput({ tags: ['a'], keep: [1] }, { tags: ['b', 'c'] });
    expect(result).toEqual({ ok: true, value: { tags: ['b', 'c'], keep: [1] } });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'raw'],
    ['an array', ['x', 'y']],
  ])('a live input that is %s contributes no keys', (_label, live) => {
    expect(mergeToolInput(live, { query: 'LIS' })).toEqual({ ok: true, value: { query: 'LIS' } });
  });

  it('a JSON "__proto__" key is refused at the top level and cannot pollute any prototype', () => {
    const proposed = JSON.parse('{"__proto__": {"polluted": true}, "query": "LIS"}') as unknown;
    const result = mergeToolInput({ query: 'AMS' }, proposed);
    expect(result).toMatchObject({ ok: false, code: 'shape' });
    if (!result.ok) expect(result.message).toContain('__proto__');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('a "__proto__" key at any depth is refused', () => {
    const proposed = JSON.parse('{"filter": {"and": [{"__proto__": {"isAdmin": true}}]}}') as unknown;
    expect(mergeToolInput({}, proposed)).toMatchObject({ ok: false, code: 'shape' });
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });

  // The other standard deep-merge pollution payload (lodash defaultsDeep
  // CVE-2019-10744, the minimist CVE-2020-7598 bypass of "__proto__"-only fixes).
  const CONSTRUCTOR_PROTOTYPE = '{"query":"LIS","constructor":{"prototype":{"gmPolluted8":true}}}';

  it('a {"constructor":{"prototype":{...}}} path is refused at the top level, like "__proto__"', () => {
    const result = mergeToolInput({ query: 'AMS' }, JSON.parse(CONSTRUCTOR_PROTOTYPE) as unknown);
    expect(result).toMatchObject({ ok: false, code: 'shape' });
    if (!result.ok) expect(result.message).toContain('constructor.prototype');
  });

  it('a constructor.prototype path at any depth is refused', () => {
    const proposed = JSON.parse('{"filter":{"and":[{"constructor":{"prototype":{"isAdmin":true}}}]}}') as unknown;
    expect(mergeToolInput({}, proposed)).toMatchObject({ ok: false, code: 'shape' });
  });

  it('whatever it accepts cannot rewrite Object.prototype through a naive deep merge (its stated threat)', () => {
    /** Recursive, copies own enumerable keys, creates missing branches: tool code the doc warns about. */
    function naiveDeepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (typeof value === 'object' && value !== null) {
          if (target[key] === undefined || target[key] === null) target[key] = {};
          naiveDeepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
        } else {
          target[key] = value;
        }
      }
      return target;
    }
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      for (const json of [CONSTRUCTOR_PROTOTYPE, '{"__proto__":{"gmPolluted8":true}}']) {
        const merged = mergeToolInput({ query: 'AMS' }, JSON.parse(json) as unknown);
        if (merged.ok) naiveDeepMerge({}, merged.value as Record<string, unknown>);
      }
      expect(proto['gmPolluted8']).toBeUndefined();
    } finally {
      delete proto['gmPolluted8'];
    }
  });

  it.each([
    ['a string', { constructor: 'Point' }],
    ['an object without prototype', { constructor: { name: 'Point' } }],
    ['a sibling "prototype" key', { prototype: { x: 1 }, constructor: 'Point' }],
  ])('a key merely named "constructor" (%s) is an ordinary argument', (_label, proposed) => {
    expect(mergeToolInput({ limit: 1 }, proposed)).toEqual({ ok: true, value: { limit: 1, ...proposed } });
  });

  it('context.inputHidden: the live input contributes no keys (a hidden input takes only a full replacement)', () => {
    const live = { account: 'ACC-7731', confirm: 'ACC-7731', amount: 10 };
    expect(mergeToolInput(live, { confirm: 'ACC-7731' }, { inputHidden: true })).toEqual({
      ok: true,
      value: { confirm: 'ACC-7731' },
    });
    const full = { account: 'ACC-1', confirm: 'ACC-1', amount: 5 };
    expect(mergeToolInput(live, full, { inputHidden: true })).toEqual({ ok: true, value: full });
  });

  it.each([
    ['no context', undefined],
    ['inputHidden false', { inputHidden: false }],
  ])('%s: the default merge onto the live input', (_label, context) => {
    expect(mergeToolInput({ query: 'AMS', limit: 5 }, { limit: 1 }, context)).toEqual({
      ok: true,
      value: { query: 'AMS', limit: 1 },
    });
  });

  it('a live object carrying an own "__proto__" key (model JSON) stays inert in the merge', () => {
    const live = JSON.parse('{"__proto__": {"polluted": true}, "query": "AMS"}') as Record<string, unknown>;
    const result = mergeToolInput(live, { query: 'LIS' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value['polluted']).toBeUndefined();
    expect(value['query']).toBe('LIS');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('a cyclic proposed object (not from the wire) is merged without looping', () => {
    const proposed: Record<string, unknown> = { query: 'LIS' };
    proposed['self'] = proposed;
    const result = mergeToolInput({ limit: 1 }, proposed);
    expect(result.ok).toBe(true);
  });

  it('an unreadable proposed object (a throwing Proxy) is a shape refusal, never a throw', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => mergeToolInput({}, hostile)).not.toThrow();
    expect(mergeToolInput({}, hostile)).toMatchObject({ ok: false, code: 'shape' });
  });
});

describe('proposedValueRefusal — placeholders and truncation markers never run', () => {
  const shrunkString = serializePayload(
    { nodeId: 'n', kind: 'tool', name: 'n', instanceId: 'i', input: { q: 'x'.repeat(600_000) } },
    512 * 1024,
    'node.started',
  ).payload as { input?: unknown };

  it.each([
    ['the placeholder as a value', { q: REDACTED }, 'placeholder'],
    ['the placeholder inside a longer string', { q: `abc ${REDACTED} def` }, 'placeholder'],
    ['the placeholder as a key', { [REDACTED]: 1 }, 'placeholder'],
    ['the placeholder as a nested key', { a: { b: [{ [REDACTED]: true }] } }, 'placeholder'],
    ['the placeholder deep in an array', { a: [[['x', REDACTED]]] }, 'placeholder'],
    ['the placeholder as the whole value', REDACTED, 'placeholder'],
    ['the shrink marker key', { a: { __graphmindTruncated: true, bytes: 9, preview: 'x' } }, 'truncated'],
    ['the shrink marker as a nested key', { a: [{ b: { __graphmindTruncated: true } }] }, 'truncated'],
    ['the string truncation suffix', { q: `abc${TRUNCATION_SUFFIX}` }, 'truncated'],
    ['the suffix in a key', { [`k${TRUNCATION_SUFFIX}`]: 1 }, 'truncated'],
    ['LangGraph truncated preview', { state: { __graphmind: 'truncated', preview: 'x', chars: 9 } }, 'truncated'],
    ['LangGraph unserializable marker', { state: { __graphmind: 'unserializable', preview: 'x' } }, 'truncated'],
    ['a real shrunk input', shrunkString.input, 'truncated'],
    ['the MCP get_node preview marker', mcpPreview({ content: 'x'.repeat(10_000) }), 'truncated'],
    ['the MCP marker nested in a value', { hits: [mcpPreview({ body: 'y'.repeat(5000) })] }, 'truncated'],
  ])('refuses %s', (_label, value, code) => {
    expect(proposedValueRefusal(value)).toMatchObject({ code });
  });

  it('the placeholder wins when both appear', () => {
    expect(proposedValueRefusal({ a: REDACTED, b: TRUNCATION_SUFFIX })).toMatchObject({ code: 'placeholder' });
  });

  it.each([
    ['a plain object', { query: 'LIS', limit: 3 }],
    ['an empty object', {}],
    ['null', null],
    ['a number', 7],
    ['a near miss of the placeholder', { q: '__REDACTED_' }],
    ['a string that merely mentions the LangGraph marker', { q: '"__graphmind":"truncated"' }],
    ['a __graphmind key with another value', { __graphmind: 'note' }],
    ['undefined (no JSON form, nothing to check)', undefined],
    ['a legitimate truncated flag with its own note', { tree: [], truncated: true, note: 'GitHub API capped the listing' }],
    ['a string that merely quotes the MCP note', { q: `"note":"${MCP_PREVIEW_NOTE_PREFIX}4000 of 9000"` }],
  ])('accepts %s', (_label, value) => {
    expect(proposedValueRefusal(value)).toBeUndefined();
  });

  it('a value that cannot be serialised to be checked is a shape refusal', () => {
    expect(proposedValueRefusal({ n: 1n })).toMatchObject({ code: 'shape' });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(proposedValueRefusal(cyclic)).toMatchObject({ code: 'shape' });
  });

  it('its messages never quote the value', () => {
    const secret = 'SECRET-CANARY-91f2';
    for (const value of [{ q: `${secret} ${REDACTED}` }, { q: `${secret}${TRUNCATION_SUFFIX}` }]) {
      expect(proposedValueRefusal(value)?.message).not.toContain(secret);
    }
  });
});

describe('prototypeKeyRefusal — the key guard the session applies to every edit', () => {
  it.each([
    ['a top-level own "__proto__" key', '{"__proto__":{"isAdmin":true},"q":1}'],
    ['a nested own "__proto__" key', '{"opts":{"__proto__":{"isAdmin":true}}}'],
    ['a "__proto__" key inside an array', '[{"__proto__":{}}]'],
    ['a top-level constructor.prototype path', '{"constructor":{"prototype":{"polluted":true}}}'],
    ['a nested constructor.prototype path', '{"filter":{"and":[{"constructor":{"prototype":{}}}]}}'],
  ])('refuses %s (shape)', (_label, json) => {
    const refusal = prototypeKeyRefusal(JSON.parse(json) as unknown);
    expect(refusal).toMatchObject({ code: 'shape' });
    expect(refusal?.message).not.toContain('isAdmin');
  });

  it.each([
    ['a plain object', { query: 'LIS' }],
    ['a key named constructor holding a string', { constructor: 'Point' }],
    ['a key named prototype', { prototype: { x: 1 } }],
    ['a constructor object without prototype', { constructor: { name: 'Point' } }],
    ['a string mentioning __proto__', { q: '__proto__' }],
    ['a primitive', 'text'],
    ['null', null],
    ['undefined', undefined],
  ])('accepts %s', (_label, value) => {
    expect(prototypeKeyRefusal(value)).toBeUndefined();
  });

  it('is cycle-safe and never throws on an unreadable value', () => {
    const cyclic: Record<string, unknown> = { q: 1 };
    cyclic['self'] = cyclic;
    expect(prototypeKeyRefusal(cyclic)).toBeUndefined();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => prototypeKeyRefusal(hostile)).not.toThrow();
    expect(prototypeKeyRefusal(hostile)).toMatchObject({ code: 'shape' });
  });
});

describe('normalizeValidation — a validator is host code', () => {
  it('passes the two documented shapes through', () => {
    expect(normalizeValidation({ ok: true, value: { q: 1 } })).toEqual({ ok: true, value: { q: 1 } });
    expect(normalizeValidation({ ok: true, value: null })).toEqual({ ok: true, value: null });
    expect(normalizeValidation({ ok: false, code: 'schema', message: 'q must be a string' })).toEqual({
      ok: false,
      code: 'schema',
      message: 'q must be a string',
    });
    expect(normalizeValidation({ ok: false, code: 'unsupported' })).toEqual({ ok: false, code: 'unsupported' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ok'],
    ['true', true],
    ['ok as a string', { ok: 'true', value: 1 }],
    ['ok true without a value', { ok: true }],
    ['ok false without a code', { ok: false }],
    ['an unknown code', { ok: false, code: 'nope' }],
    ['a code that is not a string', { ok: false, code: 3 }],
  ])('%s becomes a shape refusal', (_label, result) => {
    expect(normalizeValidation(result)).toEqual(VALIDATOR_FAILED);
    expect(VALIDATOR_FAILED).toMatchObject({ ok: false, code: 'shape' });
  });

  it('a result whose fields throw on read becomes a shape refusal', () => {
    const hostile = {
      get ok(): boolean {
        throw new Error('boom');
      },
    };
    expect(normalizeValidation(hostile)).toEqual(VALIDATOR_FAILED);
  });

  it('a message that is not a string is dropped; a long one is cut', () => {
    expect(normalizeValidation({ ok: false, code: 'schema', message: { text: 'x' } })).toEqual({
      ok: false,
      code: 'schema',
    });
    const long = normalizeValidation({ ok: false, code: 'schema', message: 'y'.repeat(5000) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message?.length).toBe(MAX_REFUSAL_MESSAGE);
  });
});

describe('sanitizeShortText', () => {
  const ESC = String.fromCharCode(0x1b);
  const NUL = String.fromCharCode(0);
  const RLO = String.fromCharCode(0x202e);
  const C1 = String.fromCharCode(0x9b);

  it('removes control and bidi characters and collapses whitespace', () => {
    expect(sanitizeShortText(`  bad${ESC}[31m  value${NUL}${RLO}here${C1}\n\tend `)).toBe('bad [31m value here end');
  });

  it(`caps at ${MAX_REFUSAL_MESSAGE} characters with an ellipsis, never splitting a surrogate pair`, () => {
    const cut = sanitizeShortText('a'.repeat(1000));
    expect(cut).toHaveLength(MAX_REFUSAL_MESSAGE);
    expect(cut?.endsWith('…')).toBe(true);
    // An astral character just before, and straddling, the cut point.
    for (const pad of [197, 198]) {
      const astral = sanitizeShortText(`${'a'.repeat(pad)}😀😀😀`) ?? '';
      expect(astral.length).toBeLessThanOrEqual(MAX_REFUSAL_MESSAGE);
      expect(astral.endsWith('…')).toBe(true);
      const beforeEllipsis = astral.charCodeAt(astral.length - 2);
      expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    }
    expect(sanitizeShortText('a'.repeat(MAX_REFUSAL_MESSAGE))).toHaveLength(MAX_REFUSAL_MESSAGE);
  });

  it('non-strings and blank text are undefined', () => {
    expect(sanitizeShortText(undefined)).toBeUndefined();
    expect(sanitizeShortText(12)).toBeUndefined();
    expect(sanitizeShortText(`  ${ESC} ${NUL}  `)).toBeUndefined();
  });
});

describe('wireCopy — what exec.resumed.edited.after records', () => {
  it('is the JSON round trip of the value', () => {
    expect(wireCopy({ at: new Date(0), n: 1, drop: undefined })).toEqual({
      value: { at: '1970-01-01T00:00:00.000Z', n: 1 },
    });
    expect(wireCopy(null)).toEqual({ value: null });
  });

  it('has no copy for a value with no JSON form', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const throwing = {
      get boom(): number {
        throw new Error('x');
      },
    };
    for (const value of [undefined, () => 1, 1n, cyclic, throwing, { n: 2n }]) {
      expect(wireCopy(value)).toBeUndefined();
    }
  });
});

// ── the cross-language conformance fixture ──────────────────────────────────
// fixtures/edit-input.json: the Python port consumes every section
// (graphmind/edit_input.py), the Ruby port `proposedValue` (graphmind/
// edit_guard.rb, its inject guard). A missing field means undefined.

interface EditFixture {
  placeholder: string;
  maxRefusalMessage: number;
  proposedValue: { name: string; value?: unknown; refusal: 'placeholder' | 'truncated' | null }[];
  prototypeKeys: { name: string; value?: unknown; refused: boolean }[];
  normalizeValidation: { name: string; result?: unknown; expected: unknown }[];
  sanitizeShortText: { name: string; input?: unknown; expected: string | null }[];
  mergeToolInput: { name: string; live?: unknown; proposed?: unknown; inputHidden?: boolean; expected: unknown }[];
}

const editFixture = JSON.parse(
  readFileSync(new URL('./fixtures/edit-input.json', import.meta.url), 'utf8'),
) as EditFixture;

describe('conformance fixture edit-input.json (shared with the Python and Ruby ports)', () => {
  it('uses the shared constants and exercises every outcome', () => {
    expect(editFixture.placeholder).toBe(REDACTED);
    expect(editFixture.maxRefusalMessage).toBe(MAX_REFUSAL_MESSAGE);
    expect(new Set(editFixture.proposedValue.map((c) => c.refusal))).toEqual(new Set(['placeholder', 'truncated', null]));
    // Every Python recording bound (safe_value) has cases of its own.
    expect(editFixture.proposedValue.filter((c) => c.name.includes('Python')).length).toBeGreaterThanOrEqual(10);
  });

  it.each(editFixture.proposedValue.map((c) => [c.name, c] as const))('proposedValue: %s', (_name, c) => {
    expect(proposedValueRefusal(c.value)?.code ?? null).toBe(c.refusal);
  });

  it.each(editFixture.prototypeKeys.map((c) => [c.name, c] as const))('prototypeKeys: %s', (_name, c) => {
    const refusal = prototypeKeyRefusal(c.value);
    expect(refusal === undefined ? false : refusal.code === 'shape').toBe(c.refused);
  });

  it.each(editFixture.normalizeValidation.map((c) => [c.name, c] as const))('normalizeValidation: %s', (_name, c) => {
    expect(normalizeValidation(c.result)).toEqual(c.expected);
  });

  it.each(editFixture.sanitizeShortText.map((c) => [c.name, c] as const))('sanitizeShortText: %s', (_name, c) => {
    expect(sanitizeShortText(c.input) ?? null).toBe(c.expected);
  });

  it.each(editFixture.mergeToolInput.map((c) => [c.name, c] as const))('mergeToolInput: %s', (_name, c) => {
    const context = c.inputHidden === undefined ? undefined : { inputHidden: c.inputHidden };
    // Key order is part of the contract: the ports compare JSON text.
    expect(JSON.stringify(mergeToolInput(c.live, c.proposed, context))).toBe(JSON.stringify(c.expected));
  });
});
