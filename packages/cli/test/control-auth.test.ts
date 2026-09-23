/**
 * The pure half of the control plane (contract C3): credential parsing and
 * comparison, the level matrix, the content guard, and the operator label.
 * The same rules are exercised end to end in control-plane.test.ts.
 */
import { readFileSync } from 'node:fs';
import { proposedValueRefusal } from '@graphmind-ai/client';
import { TRUNCATION_SUFFIX } from '@graphmind-ai/schema';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_LEVELS,
  CredentialVerifier,
  MAX_OPERATOR_CHARS,
  acceptableRequestId,
  authorizeDebugState,
  authorizeResume,
  bearerToken,
  contentRefusal,
  generateTokens,
  parseControlLevel,
  resolveCredential,
  sanitizeOperator,
  subprotocolTokens,
  type ControlLevel,
} from '../src/control-auth.js';
import { REDACTED } from '../src/redact-secrets.js';

describe('tokens', () => {
  it('are two distinct 128-bit random values, prefixed by role', () => {
    const a = generateTokens();
    const b = generateTokens();
    expect(a.viewer).toMatch(/^gmv_[0-9a-f]{32}$/);
    expect(a.agent).toMatch(/^gma_[0-9a-f]{32}$/);
    expect(a.viewer).not.toBe(a.agent);
    expect(new Set([a.viewer, a.agent, b.viewer, b.agent]).size).toBe(4);
  });

  it('are compared as SHA-256 digests with timingSafeEqual (no length or prefix oracle)', () => {
    const tokens = generateTokens();
    const verifier = new CredentialVerifier(tokens);
    expect(verifier.identify(tokens.viewer)).toBe('viewer');
    expect(verifier.identify(tokens.agent)).toBe('agent');
    // Prefixes, extensions, case changes and other lengths never match — and
    // never throw (timingSafeEqual on raw strings would throw on a length
    // mismatch, which is itself a length oracle).
    for (const guess of [
      '',
      tokens.viewer.slice(0, -1),
      `${tokens.viewer}0`,
      tokens.viewer.toUpperCase(),
      'x'.repeat(10_000),
      tokens.agent.slice(0, 8),
    ]) {
      expect(verifier.identify(guess), guess.slice(0, 20)).toBeUndefined();
    }
    const source = readFileSync(new URL('../src/control-auth.ts', import.meta.url), 'utf8');
    expect(source).toContain("createHash('sha256')");
    expect(source).toContain('timingSafeEqual(digest, this.viewerDigest)');
    expect(source).toContain('timingSafeEqual(digest, this.agentDigest)');
  });
});

describe('credential parsing', () => {
  it('reads only a well-formed "Authorization: Bearer <token>"', () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('')).toBeUndefined();
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc  ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken('Token abc')).toBeNull();
  });

  it('finds gm.auth.<token> entries among the offered subprotocols', () => {
    expect(subprotocolTokens(undefined)).toEqual([]);
    expect(subprotocolTokens('graphmind.v1')).toEqual([]);
    expect(subprotocolTokens('graphmind.v1, gm.auth.abc')).toEqual(['abc']);
    expect(subprotocolTokens(['gm.auth.a', 'graphmind.v1,gm.auth.b'])).toEqual(['a', 'b']);
  });

  it('resolves to a principal, refusing unknown, malformed and conflicting credentials', () => {
    const tokens = generateTokens();
    const verifier = new CredentialVerifier(tokens);
    expect(resolveCredential([], verifier)).toEqual({ kind: 'none' });
    expect(resolveCredential([tokens.viewer], verifier)).toEqual({ kind: 'ok', principal: 'viewer' });
    expect(resolveCredential([tokens.agent, tokens.agent], verifier)).toEqual({ kind: 'ok', principal: 'agent' });
    expect(resolveCredential(['nope'], verifier).kind).toBe('invalid');
    expect(resolveCredential([null], verifier).kind).toBe('invalid');
    expect(resolveCredential([''], verifier).kind).toBe('invalid');
    // Two valid-but-different tokens: refused, never "the stronger one wins".
    expect(resolveCredential([tokens.agent, tokens.viewer], verifier)).toEqual({
      kind: 'invalid',
      message: 'conflicting credentials',
    });
  });

  it('parses --allow-control levels strictly', () => {
    for (const level of CONTROL_LEVELS) expect(parseControlLevel(level)).toBe(level);
    expect(parseControlLevel(' EDIT ')).toBe('edit');
    for (const bad of ['', 'on', 'full', 'yes', 'resume,inject', undefined]) {
      expect(parseControlLevel(bad)).toBeUndefined();
    }
  });
});

describe('the level matrix (authorizeResume)', () => {
  const actions = ['continue', 'retry', 'inject', 'abort'] as const;
  const rank = (level: ControlLevel): number => CONTROL_LEVELS.indexOf(level);
  const agentMayDo = (level: ControlLevel, action: (typeof actions)[number], input: boolean): boolean => {
    if (input) return level === 'edit';
    if (action === 'inject') return rank(level) >= rank('inject');
    return rank(level) >= rank('resume');
  };

  for (const level of CONTROL_LEVELS) {
    for (const action of actions) {
      for (const input of [false, true]) {
        it(`agent @ ${level}: ${action}${input ? ' + input' : ''} -> ${agentMayDo(level, action, input) ? 'allowed' : 'forbidden'}`, () => {
          const refusal = authorizeResume('agent', { agentLevel: level, editInput: true }, action, input);
          if (agentMayDo(level, action, input)) expect(refusal).toBeUndefined();
          else expect(refusal?.code).toBe('forbidden');
        });
      }
    }
  }

  it('the viewer token has full control at every agent level', () => {
    for (const level of CONTROL_LEVELS) {
      for (const action of actions) {
        for (const input of [false, true]) {
          expect(authorizeResume('viewer', { agentLevel: level, editInput: true }, action, input)).toBeUndefined();
        }
      }
    }
  });

  it('a tokenless (anonymous) socket keeps 0.5 behaviour and never edits', () => {
    for (const action of actions) {
      expect(authorizeResume('anonymous', { agentLevel: 'off', editInput: true }, action, false)).toBeUndefined();
      expect(authorizeResume('anonymous', { agentLevel: 'edit', editInput: true }, action, true)?.code).toBe(
        'edit-refused',
      );
    }
  });

  it('breakpoints and step mode need level resume for the agent token only', () => {
    expect(authorizeDebugState('agent', { agentLevel: 'off', editInput: true })?.code).toBe('forbidden');
    expect(authorizeDebugState('agent', { agentLevel: 'resume', editInput: true })).toBeUndefined();
    expect(authorizeDebugState('viewer', { agentLevel: 'off', editInput: true })).toBeUndefined();
    expect(authorizeDebugState('anonymous', { agentLevel: 'off', editInput: true })).toBeUndefined();
  });

  it('says how to raise the level, in words an agent can act on', () => {
    const refusal = authorizeResume('agent', { agentLevel: 'off', editInput: true }, 'continue', false);
    expect(refusal?.message).toContain('--allow-control=resume');
    const low = authorizeResume('agent', { agentLevel: 'inject', editInput: true }, 'retry', true);
    expect(low?.message).toContain('--allow-control=edit');
  });
});

describe('content guard (placeholder / truncation)', () => {
  it('refuses the redaction placeholder anywhere: value, substring, key, nested', () => {
    for (const value of [REDACTED, `x ${REDACTED} y`, { [REDACTED]: 1 }, { a: [{ b: REDACTED }] }]) {
      expect(contentRefusal(value, 'input')?.code).toBe('placeholder');
      expect(contentRefusal(value, 'output')?.code).toBe('placeholder');
    }
  });

  it('refuses every truncation marker: the shrink object, the string suffix, LangGraph previews', () => {
    const cases: unknown[] = [
      { __graphmindTruncated: true, bytes: 900_000, preview: '...' },
      { rows: [{ __graphmindTruncated: true }] },
      `abc${TRUNCATION_SUFFIX}`,
      { note: `long text${TRUNCATION_SUFFIX}` },
      { __graphmind: 'truncated', preview: '{...' },
      { __graphmind: 'unserializable', preview: 'Function' },
    ];
    for (const value of cases) expect(contentRefusal(value, 'input')?.code, JSON.stringify(value)).toBe('truncated');
  });

  it('is the client\'s own marker list: whatever the client refuses, the hub refuses with the same code', () => {
    const corpus: unknown[] = [
      REDACTED,
      { a: REDACTED },
      { __graphmindTruncated: true },
      `x${TRUNCATION_SUFFIX}`,
      { __graphmind: 'truncated', preview: '' },
      { __graphmind: 'unserializable', preview: '' },
      'clean',
      { clean: [1, 2, 3] },
      null,
    ];
    for (const value of corpus) {
      const client = proposedValueRefusal(value);
      const hub = contentRefusal(value, 'input');
      expect(hub?.code, JSON.stringify(value)).toBe(client?.code);
    }
    // No private copy of the markers in the hub to drift from the client's.
    const source = readFileSync(new URL('../src/control-auth.ts', import.meta.url), 'utf8');
    expect(source).toContain('proposedValueRefusal(value)');
    expect(source).not.toContain('__graphmindTruncated');
    expect(source).not.toContain('TRUNCATION_SUFFIX');
  });

  it('lets look-alikes through and never quotes the value it refuses', () => {
    for (const value of ['REDACTED', '__redacted__', { graphmindTruncated: true }, 'truncated', null, 0]) {
      expect(contentRefusal(value, 'input')).toBeUndefined();
    }
    const secret = `hunter2-${REDACTED}`;
    expect(contentRefusal(secret, 'input')?.message).not.toContain('hunter2');
    expect(contentRefusal(undefined, 'output')).toBeUndefined();
  });
});

describe('operator label', () => {
  it('keeps printable text, collapses spaces, trims, caps at 64 code points', () => {
    expect(sanitizeOperator('  claude   code  ')).toBe('claude code');
    expect(sanitizeOperator('a'.repeat(100))).toHaveLength(MAX_OPERATOR_CHARS);
    const emoji = '🙂'.repeat(70);
    expect([...(sanitizeOperator(emoji) as string)]).toHaveLength(MAX_OPERATOR_CHARS);
    expect(sanitizeOperator('José Müller (review) #1')).toBe('José Müller (review) #1');
  });

  it('drops control, bidi, zero-width and line-separator characters', () => {
    const hostile =
      'ag\u202Eent\u2066x\u2069\u200B\u200D\u2028\u2029\u0000\u0007\u001B[31m\r\nroot\u061C\uFEFF';
    const clean = sanitizeOperator(hostile) as string;
    expect(clean).toBe('agentx[31mroot');
    expect(clean).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/u);
  });

  it('is absent when nothing printable is left, or when it is not a string', () => {
    for (const value of ['', '   ', '\u202E\u200B', undefined, null, 42, { name: 'x' }, ['a']]) {
      expect(sanitizeOperator(value)).toBeUndefined();
    }
  });
});

describe('requestId', () => {
  it('keeps short plain ids and drops anything else', () => {
    expect(acceptableRequestId('req-1:abc.DEF_2')).toBe(true);
    for (const bad of ['', 'a'.repeat(129), 'has space', 'semi;colon', 'new\nline', 5, undefined]) {
      expect(acceptableRequestId(bad)).toBe(false);
    }
  });
});
