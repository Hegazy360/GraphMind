/**
 * Round-trip property tests: for arbitrary well-formed envelopes of every
 * known message type, serialize -> parse yields `ok` and preserves content
 * (modulo JSON canonicalization, e.g. -0 -> 0).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  createEnvelope,
  parseEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
  type Envelope,
  type MessagePayloadMap,
  type MessageType,
} from '../src/index.js';

const nodeKindArb = fc.constantFrom('agent', 'llm', 'tool', 'custom' as const);
const statusArb = fc.constantFrom('ok', 'error', 'aborted' as const);
const pointArb = fc.constantFrom('before', 'after', 'error' as const);
const actionArb = fc.constantFrom('continue', 'retry', 'inject', 'abort' as const);
const modeArb = fc.constantFrom('run', 'step' as const);
const jsonArb = fc.jsonValue();
const idArb = fc.string({ minLength: 1, maxLength: 20 });

const errorInfoArb = fc.record(
  {
    name: fc.string(),
    message: fc.string(),
    stack: fc.string(),
  },
  { requiredKeys: ['name', 'message'] },
);

const matcherArb = fc.record(
  {
    kind: nodeKindArb,
    name: fc.string(),
    point: pointArb,
  },
  { requiredKeys: [] },
);

/** One payload arbitrary per message type — the exhaustiveness is asserted below. */
const payloadArbs: { [K in MessageType]: fc.Arbitrary<MessagePayloadMap[K]> } = {
  'run.started': fc.record(
    {
      app: fc.string(),
      sdk: fc.record({ name: fc.string(), version: fc.string() }),
      meta: fc.dictionary(fc.string(), jsonArb),
    },
    { requiredKeys: ['app', 'sdk'] },
  ),
  'run.finished': fc.record(
    { status: statusArb, error: errorInfoArb },
    { requiredKeys: ['status'] },
  ),
  'graph.hint': fc.record({
    nodes: fc.array(
      fc.record(
        { nodeId: idArb, kind: nodeKindArb, name: fc.string(), parentId: idArb },
        { requiredKeys: ['nodeId', 'kind', 'name'] },
      ),
    ),
  }),
  'node.started': fc.record(
    {
      nodeId: idArb,
      parentId: idArb,
      kind: nodeKindArb,
      name: fc.string(),
      instanceId: idArb,
      input: jsonArb,
    },
    { requiredKeys: ['nodeId', 'kind', 'name', 'instanceId', 'input'] },
  ),
  'node.token': fc.record({
    nodeId: idArb,
    deltas: fc.array(
      fc.record({ t: fc.constantFrom('text', 'reasoning', 'tool-args' as const), v: fc.string() }),
    ),
  }),
  'node.finished': fc.record(
    {
      nodeId: idArb,
      output: jsonArb,
      usage: fc.record({ inputTokens: fc.nat(), outputTokens: fc.nat() }),
      durationMs: fc.nat(),
      status: statusArb,
    },
    { requiredKeys: ['nodeId', 'output', 'durationMs', 'status'] },
  ),
  'node.error': fc.record({ nodeId: idArb, error: errorInfoArb }),
  'exec.paused': fc.record({ pauseId: idArb, nodeId: idArb, point: pointArb }),
  'exec.resumed': fc.record({ pauseId: idArb, action: actionArb }),
  'exec.resume': fc.record(
    { pauseId: idArb, action: actionArb, output: jsonArb },
    { requiredKeys: ['pauseId', 'action'] },
  ),
  'breakpoint.set': fc.record({ matcher: matcherArb }),
  'breakpoint.clear': fc.record({ matcher: matcherArb }),
  'mode.set': fc.record({ mode: modeArb }),
  hello: fc.record(
    {
      versions: fc.record({ protocol: fc.constant(PROTOCOL_VERSION), client: fc.string() }),
      capabilities: fc.array(fc.string()),
      app: fc.string(),
      sdk: fc.record({ name: fc.string(), version: fc.string() }),
    },
    { requiredKeys: ['versions', 'capabilities'] },
  ),
  'hello.ack': fc.record({
    versions: fc.record({ protocol: fc.constant(PROTOCOL_VERSION), viewer: fc.string() }),
    capabilities: fc.array(fc.string()),
    breakpoints: fc.array(matcherArb),
    mode: modeArb,
  }),
};

const envelopeArb: fc.Arbitrary<Envelope> = fc
  .constantFrom(...MESSAGE_TYPES)
  .chain((type) =>
    fc
      .record({
        seq: fc.nat(),
        ts: fc.nat(),
        runId: fc.string({ minLength: 1, maxLength: 20 }),
        payload: payloadArbs[type],
      })
      .map(({ seq, ts, runId, payload }) =>
        createEnvelope({ type, payload, seq, runId, ts } as never),
      ),
  );

describe('round-trip', () => {
  it('covers every known message type', () => {
    expect(Object.keys(payloadArbs).sort()).toEqual([...MESSAGE_TYPES].sort());
  });

  it('serialize -> parse returns ok and preserves the envelope', () => {
    fc.assert(
      fc.property(envelopeArb, (envelope) => {
        const result = parseEnvelopeJson(serializeEnvelope(envelope));
        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          // Compare against the JSON-canonical form (what actually crossed the wire).
          expect(result.envelope).toEqual(JSON.parse(JSON.stringify(envelope)));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('parseEnvelope accepts already-decoded values too', () => {
    fc.assert(
      fc.property(envelopeArb, (envelope) => {
        const result = parseEnvelope(JSON.parse(serializeEnvelope(envelope)));
        expect(result.kind).toBe('ok');
      }),
      { numRuns: 100 },
    );
  });

  it('never throws on arbitrary junk input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = parseEnvelope(value);
        expect(['ok', 'unknown-type', 'version-mismatch', 'invalid']).toContain(result.kind);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary junk strings', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = parseEnvelopeJson(text);
        expect(['ok', 'unknown-type', 'version-mismatch', 'invalid']).toContain(result.kind);
      }),
      { numRuns: 500 },
    );
  });
});
