/**
 * Generators for hostile wire traffic.
 *
 * Two layers, because the parser has two doors:
 *
 *  - `hostileText` / `hostileJsonArb` — bytes that may not be JSON at all, or
 *    are JSON no `JSON.stringify` would ever produce: duplicate keys, lone
 *    surrogates, `__proto__`, numbers outside the double range, 100k-deep
 *    nesting. These reach `parseEnvelopeJson` and the server's socket handler.
 *  - `deformedEnvelopeArb` — values that ARE decoded JSON, shaped roughly like
 *    an envelope but wrong in one place: a field of the wrong type, a negative
 *    or fractional `seq`, a foreign `gm`, a payload that violates its own
 *    schema. These reach `parseEnvelope`.
 *
 * The hand-written corpora matter as much as the random ones. Property-based
 * generation is good at breadth and bad at the specific pathological literal
 * (`"__proto__"`, `U+2028`, `1e999`, a bare `-0`), so the two are combined:
 * fast-check picks from the corpus as often as it picks a random value.
 */
import fc from 'fast-check';
import { MESSAGE_TYPES, PROTOCOL_VERSION } from '@graphmind-ai/schema';

const NUL = String.fromCharCode(0);

/**
 * Strings chosen to break something specific downstream: a JSON parser, a
 * UTF-8 encoder, SQLite's text binding, a JS object key, an HTML export, or
 * a human reading a run name.
 */
export const NASTY_STRINGS: readonly string[] = Object.freeze([
  '',
  ' ',
  NUL,
  `before${NUL}after`,
  '\u0001\u0002\u0003',
  '\ud800', // lone high surrogate
  '\udfff', // lone low surrogate
  '\ud800\ud800',
  '\udfff\ud800', // reversed pair
  '\u2028', // LINE SEPARATOR - breaks naive script embedding
  '\u2029', // PARAGRAPH SEPARATOR
  '\u202e', // RIGHT-TO-LEFT OVERRIDE
  '\u202egnp.exe', // renders as "exe.png" in a run list
  '\u200b\u200c\u200d\ufeff', // zero-width joiners + BOM
  '\ufffe', // noncharacters
  '\uffff',
  `e${'\u0301'.repeat(200)}`, // combining-mark explosion
  '\u0130\u0131', // dotted/dotless I: case folding is not identity
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '__defineGetter__',
  '../../etc/passwd',
  '../'.repeat(40),
  '%2e%2e%2f',
  "'; DROP TABLE events; --",
  '</script><img src=x onerror=alert(1)>',
  '${jndi:ldap://x/a}',
  '{{7*7}}',
  '\\u0000',
  '\r\n\r\n',
  'a'.repeat(64 * 1024),
  '\u00ff'.repeat(32 * 1024),
  '\u{1f648}'.repeat(16 * 1024),
]);

/** Numbers that are valid JSON but rarely valid anything else. */
export const NASTY_NUMBERS: readonly number[] = Object.freeze([
  0,
  -0,
  -1,
  0.5,
  -0.5,
  1e-323,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  9_007_199_254_740_993,
  1e21,
  1e300,
  -1e300,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  2 ** 53,
  -(2 ** 53),
]);

/**
 * Raw frames. Not "JSON with a mistake" — text a JSON parser, a UTF-8
 * decoder or an object-key writer is supposed to survive being handed.
 */
export function hostileText(): string[] {
  const deep = (depth: number): string => `${'['.repeat(depth)}0${']'.repeat(depth)}`;
  const wide = (n: number): string =>
    `{${Array.from({ length: n }, (_, i) => `"k${i}":${i}`).join(',')}}`;
  const envelope = (payload: string): string =>
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":${payload}}`;

  return [
    // not JSON at all
    '',
    ' ',
    '\n',
    NUL,
    'null',
    'undefined',
    'NaN',
    'Infinity',
    '{',
    '}',
    '[',
    '{"a":',
    '{"a":1,}',
    "{'a':1}",
    '{a:1}',
    '{"a":01}',
    '{"a":.5}',
    '{"a":+1}',
    '{"a":1e}',
    '<html></html>',
    'GET / HTTP/1.1',
    '﻿{"gm":1}', // BOM before the document
    // valid JSON, not an envelope
    '0',
    'true',
    'false',
    '"a string"',
    '[]',
    '[1,2,3]',
    '{}',
    '{"gm":1}',
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":0,"runId":"x"}`,
    // envelope-shaped, deliberately broken JSON semantics
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"a","runId":"b","type":"node.started","payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i"}}`,
    `{"gm":${PROTOCOL_VERSION},"seq":1e999,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}`,
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1e999,"runId":"fuzz","type":"node.started","payload":{}}`,
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":-1e999,"runId":"fuzz","type":"node.started","payload":{}}`,
    `{"gm":${PROTOCOL_VERSION},"seq":-0,"ts":1,"runId":"fuzz","type":"node.started","payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i"}}`,
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"\\ud800","type":"node.started","payload":{"nodeId":"n","kind":"tool","name":"x","instanceId":"i"}}`,
    // prototype pollution attempts
    envelope('{"nodeId":"n","kind":"tool","name":"x","instanceId":"i","__proto__":{"pwned":true}}'),
    envelope(
      '{"nodeId":"n","kind":"tool","name":"x","instanceId":"i","constructor":{"prototype":{"pwned":true}}}',
    ),
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"fuzz","type":"__proto__","payload":{"pwned":true}}`,
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"fuzz","type":"constructor","payload":{}}`,
    '{"__proto__":{"pwned":true}}',
    '{"constructor":{"prototype":{"pwned":true}}}',
    // structural extremes
    envelope(deep(1_000)),
    envelope(deep(100_000)),
    deep(1_000_000),
    envelope(wide(20_000)),
    envelope(`"${'A'.repeat(2 * 1024 * 1024)}"`),
    `{"gm":${PROTOCOL_VERSION},"seq":0,"ts":1,"runId":"${'r'.repeat(1024 * 1024)}","type":"node.started","payload":{}}`,
    // version negotiation
    '{"gm":0,"seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}',
    '{"gm":2,"seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}',
    '{"gm":-1,"seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}',
    '{"gm":1.5,"seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}',
    '{"gm":"1","seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}',
    '{"gm":null,"seq":0,"ts":1,"runId":"fuzz","type":"node.started","payload":{}}',
  ];
}

/**
 * The corpus minus the megabyte-scale entries. A property test runs its
 * generator hundreds of times, and a 2 MB literal picked at random turns a
 * 200-run property into a gigabyte of allocation for no extra coverage — the
 * giant frames are exercised once each, explicitly, by the corpus loops.
 */
const SMALL_HOSTILE_TEXT: readonly string[] = hostileText().filter((text) => text.length < 8_192);

/** Keys short enough to make a dictionary cheap, nasty enough to matter. */
const NASTY_KEYS: readonly string[] = NASTY_STRINGS.filter((text) => text.length < 64);

/** A `fc` arbitrary over hostile frame text: corpus + generated. */
export const hostileTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SMALL_HOSTILE_TEXT),
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.json(),
  fc.constantFrom(...NASTY_KEYS),
);

/** Any decoded-JSON value, including the awkward ones. */
export const anyValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.constantFrom(...NASTY_KEYS),
  fc.constantFrom(...NASTY_NUMBERS),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.jsonValue(), { maxLength: 8 }),
  fc.dictionary(fc.constantFrom(...NASTY_KEYS), fc.jsonValue(), { maxKeys: 6 }),
);

/**
 * Envelope-shaped objects with every field independently free to be wrong.
 * `requiredKeys: []` lets fields go missing entirely, which is a different
 * failure than "present but wrong type" and has bitten parsers before.
 */
export const deformedEnvelopeArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    gm: fc.oneof(
      fc.constant(PROTOCOL_VERSION),
      fc.integer({ min: -5, max: 5 }),
      fc.constantFrom(...NASTY_NUMBERS),
      anyValueArb,
    ),
    seq: fc.oneof(
      fc.nat(),
      fc.integer({ min: -1000, max: 1000 }),
      fc.double(),
      fc.constantFrom(...NASTY_NUMBERS),
      anyValueArb,
    ),
    ts: fc.oneof(fc.nat(), fc.double(), fc.constantFrom(...NASTY_NUMBERS), anyValueArb),
    runId: fc.oneof(fc.string(), fc.constantFrom(...NASTY_KEYS), anyValueArb),
    type: fc.oneof(
      fc.constantFrom(...MESSAGE_TYPES),
      fc.string(),
      fc.constantFrom(...NASTY_KEYS),
      anyValueArb,
    ),
    payload: anyValueArb,
  },
  { requiredKeys: [] },
) as fc.Arbitrary<Record<string, unknown>>;

/**
 * Structurally valid envelopes carrying a hostile payload — the case that
 * gets furthest into the server, because the frame passes every check the
 * envelope layer makes and only the payload is a problem.
 */
export const validShapeHostilePayloadArb: fc.Arbitrary<Record<string, unknown>> = fc.record({
  gm: fc.constant(PROTOCOL_VERSION),
  seq: fc.nat({ max: 1_000_000 }),
  ts: fc.nat(),
  runId: fc.oneof(fc.string({ minLength: 1 }), fc.constantFrom(...NASTY_KEYS)),
  type: fc.constantFrom(...MESSAGE_TYPES),
  payload: anyValueArb,
});

/**
 * Guard against a false-negative pollution check: `({} as any).pwned` reads
 * `undefined` both when nothing happened and when the test itself forgot to
 * clean up a previous run. Snapshot the prototype and compare.
 */
const POLLUTION_KEYS = ['pwned', 'polluted', 'isAdmin', 'toString', 'valueOf'] as const;

export function prototypeSnapshot(): string {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  return JSON.stringify(
    POLLUTION_KEYS.map((key) => [key, Object.hasOwn(proto, key) ? typeof proto[key] : 'absent']),
  );
}
