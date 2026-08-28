/**
 * Injected values must arrive as the result shape the method requires.
 *
 * The failure this prevents is silent, which is what makes it dangerous:
 * injecting `{"price": 42}` at a `tools/call` gate used to send
 * `{"jsonrpc":"2.0","id":1,"result":{"price":42}}`, which is a well-formed
 * JSON-RPC response carrying an invalid `CallToolResult`. The host's SDK finds
 * no `content`, reports no error, and shows an empty tool result — so the one
 * feature the product is named for appears to do nothing.
 *
 * The second half of this file is a PARITY suite against `@graphmind-ai/mcp`.
 * The proxy cannot import that package (it declares the MCP SDK as a peer
 * dependency, and `npx graphmind-ai` must not require it), so the coercion is
 * duplicated. These tests run the same inputs through both and assert
 * identical output, so the copies cannot drift apart unnoticed.
 */
import { describe, expect, it } from 'vitest';
import { coerceInjected as mcpCoerce } from '@graphmind-ai/mcp/coerce';
import {
  coerceInjected,
  coerceInjectedFor,
  injectShapeFor,
  type InjectShape,
} from '../../src/mcp-proxy/coerce.js';

describe('injectShapeFor', () => {
  it('maps the four gateable MCP methods', () => {
    expect(injectShapeFor('tools/call')).toBe('tool');
    expect(injectShapeFor('resources/read')).toBe('resource');
    expect(injectShapeFor('prompts/get')).toBe('prompt');
    expect(injectShapeFor('sampling/createMessage')).toBe('sampling');
  });

  it('leaves a method it does not model alone', () => {
    // Guessing at an unknown result shape would be worse than passing the
    // value through and letting the peer's own validation decide.
    expect(injectShapeFor('tools/list')).toBeUndefined();
    expect(injectShapeFor('initialize')).toBeUndefined();
    expect(injectShapeFor('completion/complete')).toBeUndefined();
  });
});

describe('coerceInjectedFor', () => {
  it('lifts a bare object into a valid CallToolResult', () => {
    const result = coerceInjectedFor('tools/call', { name: 'price' }, { price: 42 }) as {
      content: { type: string; text: string }[];
      structuredContent: unknown;
    };
    expect(result.content).toEqual([{ type: 'text', text: '{"price":42}' }]);
    // A tool declaring an `outputSchema` MUST return structuredContent, so
    // supplying it makes inject work on typed tools too.
    expect(result.structuredContent).toEqual({ price: 42 });
  });

  it('lifts a bare string into a valid CallToolResult', () => {
    expect(coerceInjectedFor('tools/call', {}, 'sunny')).toEqual({
      content: [{ type: 'text', text: 'sunny' }],
    });
  });

  it('passes a value that is already a CallToolResult through untouched', () => {
    const exact = { content: [{ type: 'text', text: 'mine' }], isError: true };
    expect(coerceInjectedFor('tools/call', {}, exact)).toBe(exact);
  });

  it('uses the request uri when lifting a resources/read value', () => {
    expect(coerceInjectedFor('resources/read', { uri: 'file:///notes.txt' }, 'hello')).toEqual({
      contents: [{ uri: 'file:///notes.txt', text: 'hello' }],
    });
  });

  it('falls back to a placeholder uri when the request had none', () => {
    const result = coerceInjectedFor('resources/read', undefined, 'hello') as {
      contents: { uri: string }[];
    };
    expect(result.contents[0]?.uri).toBe('graphmind://injected');
  });

  it('lifts a prompts/get value into messages', () => {
    expect(coerceInjectedFor('prompts/get', {}, 'be brief')).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'be brief' } }],
    });
  });

  it('lifts a sampling value into a CreateMessageResult', () => {
    expect(coerceInjectedFor('sampling/createMessage', {}, 'the answer')).toEqual({
      model: 'graphmind-injected',
      role: 'assistant',
      content: { type: 'text', text: 'the answer' },
      stopReason: 'endTurn',
    });
  });

  it('leaves an unmodelled method alone', () => {
    expect(coerceInjectedFor('tools/list', {}, { tools: [] })).toEqual({ tools: [] });
  });

  it('leaves a whole JSON-RPC frame alone — the byte-level escape hatch', () => {
    // Someone injecting a complete frame wants exactly that frame, including
    // the ability to reply with an `error` instead of a `result`.
    const frame = { jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'nope' } };
    expect(coerceInjectedFor('tools/call', {}, frame)).toBe(frame);
  });

  it('never throws on a hostile value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => coerceInjectedFor('tools/call', {}, cyclic)).not.toThrow();
    expect(() => coerceInjectedFor('resources/read', {}, 10n)).not.toThrow();
  });
});

describe('parity with @graphmind-ai/mcp', () => {
  const SHAPES: InjectShape[] = ['tool', 'resource', 'prompt', 'sampling'];
  const VALUES: unknown[] = [
    undefined,
    null,
    '',
    'a string',
    0,
    42,
    true,
    false,
    [],
    [1, 2, 3],
    {},
    { price: 42 },
    { content: [{ type: 'text', text: 'already a tool result' }] },
    { content: [], structuredContent: { a: 1 } },
    { contents: [{ uri: 'file:///x', text: 'already a resource result' }] },
    { messages: [{ role: 'user', content: { type: 'text', text: 'already a prompt' } }] },
    { model: 'm', role: 'assistant', content: { type: 'text', text: 'already sampling' } },
    { nested: { deep: { deeper: [1, { two: 2 }] } } },
  ];

  for (const shape of SHAPES) {
    it(`produces byte-identical output to the in-process adapter for ${shape}`, () => {
      for (const value of VALUES) {
        const mine = coerceInjected(shape, value, 'file:///parity');
        const theirs = mcpCoerce(shape, value, 'file:///parity');
        expect(mine, `${shape} <- ${JSON.stringify(value) ?? 'undefined'}`).toEqual(theirs);
      }
    });
  }
});
