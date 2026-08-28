/**
 * Kind identity. The regression this file exists to stop: the schema gains a
 * node kind, nothing in the viewer knows about it, and it renders as an
 * anonymous "TOOL" card that cannot be filtered.
 */
import { describe, expect, it } from 'vitest';
import { NodeKindSchema } from '@graphmind-ai/schema';
import { KIND_ORDER, MCP_KINDS, isContainerKind, isMcpKind, kindLabel, kindMeta } from '../src/lib/kinds.js';
import { NODE_DIMENSIONS, flowNodeType } from '../src/store/runStateToFlow.js';

/** Every kind the wire contract can actually carry. */
const SCHEMA_KINDS = NodeKindSchema.options;

describe('kind table', () => {
  it('covers every kind in the schema — including any added later', () => {
    for (const kind of SCHEMA_KINDS) {
      const meta = kindMeta(kind);
      expect(meta.kind, `missing meta for ${kind}`).toBe(kind);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.hint.length).toBeGreaterThan(0);
    }
  });

  it('orders every schema kind exactly once', () => {
    expect([...KIND_ORDER].sort()).toEqual([...SCHEMA_KINDS].sort());
    expect(new Set(KIND_ORDER).size).toBe(KIND_ORDER.length);
  });

  it('names the MCP family', () => {
    expect([...MCP_KINDS]).toEqual(['server', 'resource', 'prompt']);
    for (const kind of MCP_KINDS) expect(isMcpKind(kind)).toBe(true);
    expect(isMcpKind('tool')).toBe(false);
  });

  it('degrades gracefully for a kind from the future', () => {
    const meta = kindMeta('quantum' as never);
    expect(meta.card).toBe('tool');
    expect(meta.label).toBe('quantum');
    expect(meta.container).toBe(false);
  });
});

describe('kind → card', () => {
  it('routes every kind to a card that exists', () => {
    for (const kind of SCHEMA_KINDS) {
      expect(NODE_DIMENSIONS[flowNodeType(kind)]).toBeDefined();
    }
  });

  it('keeps the established mapping', () => {
    expect(flowNodeType('agent')).toBe('invocation');
    expect(flowNodeType('llm')).toBe('llmStep');
    expect(flowNodeType('tool')).toBe('tool');
    expect(flowNodeType('custom')).toBe('tool');
  });

  it('draws an MCP server session as a container, its requests as leaves', () => {
    expect(flowNodeType('server')).toBe('invocation');
    expect(flowNodeType('resource')).toBe('tool');
    expect(flowNodeType('prompt')).toBe('tool');
    expect(isContainerKind('server')).toBe(true);
    expect(isContainerKind('resource')).toBe(false);
    expect(isContainerKind('prompt')).toBe(false);
  });

  it('labels a custom span as a span, not as "custom"', () => {
    expect(kindLabel('custom')).toBe('span');
  });
});
