/**
 * `graphmind record` sanitises exported runs by default: values under an
 * exact list of secret-shaped keys become "__REDACTED__". The match rule is
 * binding (internal/research/phase6-plan-2026-09.md, "Shared contracts"):
 * case-insensitive, on the whole key or a `_`/`-`-delimited segment run of it
 * — `api_key`, `x-api-key`, `Authorization` match; `max_tokens`, `tokenizer`
 * do not.
 */
import { describe, expect, it } from 'vitest';
import { defaultFlags, parseCliArgs } from '../src/args.js';
import {
  REDACTED,
  SECRET_KEYS,
  containsRedacted,
  isSecretKey,
  redactSecrets,
  redactStoredEvents,
  redactionSummaryLine,
} from '../src/redact-secrets.js';
import type { StoredEvent } from '../src/storage.js';

describe('isSecretKey — the binding match rule', () => {
  it('pins the binding key list exactly', () => {
    expect([...SECRET_KEYS]).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'api_key',
      'apikey',
      'password',
      'passwd',
      'secret',
      'client_secret',
      'private_key',
      'access_token',
      'refresh_token',
      'token',
      'bearer',
    ]);
  });

  it('matches the whole key, case-insensitively', () => {
    for (const key of [
      'authorization',
      'Authorization',
      'AUTHORIZATION',
      'cookie',
      'Cookie',
      'set-cookie',
      'Set-Cookie',
      'set_cookie',
      'api_key',
      'API_KEY',
      'apiKey', // 'apikey' folded
      'ApiKey',
      'password',
      'Password',
      'passwd',
      'secret',
      'client_secret',
      'private_key',
      'PRIVATE-KEY',
      'access_token',
      'refresh_token',
      'token',
      'TOKEN',
      'bearer',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('treats camelCase boundaries as delimiters (a strict superset of the binding rule)', () => {
    for (const key of [
      'clientSecret',
      'accessToken',
      'refreshToken',
      'privateKey',
      'setCookie',
      'xApiKey',
      'APIKey',
      'HTTPToken',
      'IdToken',
      'bearerToken',
      'authorizationUrl', // same as authorization_url under the binding rule
      'sessionToken',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('matches a `_`/`-`-delimited segment run (x-api-key, http_authorization, session-token)', () => {
    for (const key of [
      'x-api-key',
      'X-API-KEY',
      'x_api_key',
      'X-Api-Key',
      'http_authorization',
      'proxy-authorization',
      'session-token',
      'id_token',
      'my_password',
      'db-passwd',
      'aws_secret',
      'openai-api-key',
      'PRIVATE_KEY_PEM',
      'x-refresh-token',
      'set-cookie-header',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('does NOT match look-alikes: substrings are not segments', () => {
    for (const key of [
      'max_tokens',
      'maxTokens',
      'tokens',
      'tokens_used',
      'tokenizer',
      'apiKeys',
      'passwordless',
      'secrets',
      'secretary',
      'secrets_manager_arn',
      'cookies',
      'authorized',
      'tokenised',
      'top_secretive',
      'private_keys',
      'keys',
      'api',
      'key',
      'x',
      '',
      '_',
      '-',
      'headers.authorization', // dots are not delimiters (nested objects are walked instead)
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('is exactly the rule, even where it over-approximates: token_count and secret_expires_at match', () => {
    // Documented: a segment run equal to a listed key matches regardless of
    // what the rest of the key says. Over-redaction is the safe direction.
    expect(isSecretKey('token_count')).toBe(true);
    expect(isSecretKey('client_secret_expires_at')).toBe(true);
    expect(isSecretKey('access_token_expires_in')).toBe(true);
  });

  it('treats empty segments from doubled or edge delimiters harmlessly', () => {
    expect(isSecretKey('--token')).toBe(true);
    expect(isSecretKey('token__')).toBe(true);
    expect(isSecretKey('x--api--key')).toBe(true);
    expect(isSecretKey('__proto__')).toBe(false);
  });
});

describe('redactSecrets — the walk', () => {
  it('replaces matched values at any depth, arrays included, and counts them', () => {
    const input = {
      headers: { Authorization: 'Bearer abc', 'x-api-key': 'k1', 'content-type': 'json' },
      body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 },
      list: [{ token: 't1' }, { token: 't2', name: 'n' }, 'plain', 7, null],
      nested: [[{ password: 'p' }]],
    };
    const { value, count, keys } = redactSecrets(input);
    expect(value).toEqual({
      headers: { Authorization: REDACTED, 'x-api-key': REDACTED, 'content-type': 'json' },
      body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 },
      list: [{ token: REDACTED }, { token: REDACTED, name: 'n' }, 'plain', 7, null],
      nested: [[{ password: REDACTED }]],
    });
    expect(count).toBe(5);
    expect([...keys].sort()).toEqual(['Authorization', 'password', 'token', 'x-api-key']);
  });

  it('replaces whole objects and arrays sitting under a matched key', () => {
    const { value, count } = redactSecrets({ secret: { a: 1, b: [2] }, cookie: ['a=b', 'c=d'] });
    expect(value).toEqual({ secret: REDACTED, cookie: REDACTED });
    expect(count).toBe(2);
  });

  it('keys differing only by case are each redacted and each counted as their own spelling', () => {
    const { value, count, keys } = redactSecrets({ Token: 'a', token: 'b', TOKEN: 'c' });
    expect(value).toEqual({ Token: REDACTED, token: REDACTED, TOKEN: REDACTED });
    expect(count).toBe(3);
    expect([...keys].sort()).toEqual(['TOKEN', 'Token', 'token']);
  });

  it('never un-redacts: a second pass changes nothing and counts nothing', () => {
    const once = redactSecrets({ a: { api_key: 'x' }, b: [{ token: 'y' }] });
    const twice = redactSecrets(once.value);
    expect(twice.value).toEqual(once.value);
    expect(twice.count).toBe(0);
    expect(twice.keys.size).toBe(0);
  });

  it('leaves null, undefined and empty-string values alone (nothing to hide, and a placeholder would lie)', () => {
    const { value, count } = redactSecrets({ token: null, secret: '', password: undefined, api_key: 0 });
    expect(value).toEqual({ token: null, secret: '', password: undefined, api_key: REDACTED });
    expect(count).toBe(1);
  });

  it('does not mutate its input', () => {
    const input = { headers: { Authorization: 'x' }, list: [{ token: 'y' }] };
    const snapshot = JSON.stringify(input);
    redactSecrets(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns scalars and empty containers untouched', () => {
    expect(redactSecrets('token').value).toBe('token');
    expect(redactSecrets(42).value).toBe(42);
    expect(redactSecrets(null).value).toBe(null);
    expect(redactSecrets([]).value).toEqual([]);
    expect(redactSecrets({}).value).toEqual({});
  });

  it('does not match on VALUES, only keys: a prompt containing "password" survives', () => {
    const { value, count } = redactSecrets({ content: 'my password is hunter2', note: 'Authorization: Bearer x' });
    expect(value).toEqual({ content: 'my password is hunter2', note: 'Authorization: Bearer x' });
    expect(count).toBe(0);
  });

  it('is safe against __proto__ keys coming out of JSON.parse', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"token":"t"}') as Record<string, unknown>;
    const { value } = redactSecrets(parsed);
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((value as Record<string, unknown>)['token']).toBe(REDACTED);
  });

  it('survives very deep nesting without a stack overflow', () => {
    let deep: unknown = { token: 'leaf' };
    for (let i = 0; i < 5000; i += 1) deep = { d: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

describe('redactStoredEvents + the summary line', () => {
  const event = (seq: number, type: string, payload: unknown): StoredEvent => ({
    runId: 'r',
    seq,
    ts: seq,
    type,
    nodeId: null,
    payload,
  });

  it('walks every payload, keeps envelope fields, aggregates count and distinct keys', () => {
    const events = [
      event(0, 'run.started', { app: 'a', sdk: { name: 's', version: '1' }, meta: { api_key: 'k' } }),
      event(1, 'node.started', { nodeId: 'tool:x', kind: 'tool', name: 'x', instanceId: '1', input: { headers: { Authorization: 'B' } } }),
      event(2, 'node.finished', { nodeId: 'tool:x', output: [{ token: 't' }, { token: 'u' }], durationMs: 1, status: 'ok' }),
      event(3, 'node.error', { nodeId: 'tool:x', error: { name: 'E', message: 'token was bad' } }),
    ];
    const result = redactStoredEvents(events);
    expect(result.count).toBe(4);
    expect([...result.keys].sort()).toEqual(['Authorization', 'api_key', 'token']);
    expect(result.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(result.events[0]?.payload).toEqual({ app: 'a', sdk: { name: 's', version: '1' }, meta: { api_key: REDACTED } });
    expect(result.events[2]?.payload).toEqual({
      nodeId: 'tool:x',
      output: [{ token: REDACTED }, { token: REDACTED }],
      durationMs: 1,
      status: 'ok',
    });
    // Error MESSAGES are values, not keys: untouched (documented).
    expect(result.events[3]?.payload).toEqual(events[3]?.payload);
    // Untouched events keep their identity (no needless copies).
    expect(result.events[3]).toBe(events[3]);
    expect(result.events[0]).not.toBe(events[0]);
  });

  it('prints the exact line the docs promise', () => {
    expect(redactionSummaryLine(4, 3)).toBe(
      'redacted 4 values under 3 distinct keys (--no-redact-secrets keeps them)',
    );
    expect(redactionSummaryLine(1, 1)).toBe(
      'redacted 1 value under 1 distinct key (--no-redact-secrets keeps them)',
    );
    expect(redactionSummaryLine(0, 0)).toBe(
      'redacted 0 values under 0 distinct keys (--no-redact-secrets keeps them)',
    );
  });
});

describe('containsRedacted — the inject guard predicate', () => {
  it('finds the placeholder anywhere in the JSON form', () => {
    expect(containsRedacted(REDACTED)).toBe(true);
    expect(containsRedacted({ a: [1, { b: REDACTED }] })).toBe(true);
    expect(containsRedacted({ [REDACTED]: 1 })).toBe(true);
    expect(containsRedacted(`prefix ${REDACTED} suffix`)).toBe(true);
  });
  it('passes clean values, including ones that merely look similar', () => {
    expect(containsRedacted({ a: 'REDACTED', b: '__redacted__', c: '_REDACTED_' })).toBe(false);
    expect(containsRedacted(undefined)).toBe(false);
    expect(containsRedacted(null)).toBe(false);
    expect(containsRedacted(42)).toBe(false);
  });
  it('never throws on unserialisable values', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(containsRedacted(cyc)).toBe(false);
    expect(containsRedacted(BigInt(1) as unknown)).toBe(false);
  });
});

describe('args: --redact-secrets / --no-redact-secrets', () => {
  it('is on by default', () => {
    expect(defaultFlags().redactSecrets).toBe(true);
    expect(parseCliArgs(['record', 'run-1']).flags.redactSecrets).toBe(true);
  });
  it('--no-redact-secrets turns it off; --redact-secrets turns it back on; last one wins', () => {
    expect(parseCliArgs(['record', 'run-1', '--no-redact-secrets']).flags.redactSecrets).toBe(false);
    expect(parseCliArgs(['record', 'run-1', '--no-redact-secrets', '--redact-secrets']).flags.redactSecrets).toBe(true);
    expect(parseCliArgs(['record', 'run-1', '--redact-secrets', '--no-redact-secrets']).flags.redactSecrets).toBe(false);
    expect(parseCliArgs(['record', 'run-1', '--no-redact-secrets']).errors).toEqual([]);
  });
  it('is mentioned in --help', async () => {
    const { OPTION_HELP } = await import('../src/args.js');
    expect(OPTION_HELP.join('\n')).toContain('--no-redact-secrets');
  });
});

// ── Adversarial verification (W7) ────────────────────────────────────────────
// Two leaks found by the verifier through the real pipeline (client -> hub ->
// SQLite -> `graphmind record`, default flags): (1) the camelCase splitter ran
// BEFORE the case-insensitive whole-key test, so keys the binding rule matches
// (`PassWord`, `APIkey`, `CLIENTsecret`, `x-APIkey`) were exported in clear;
// (2) the walk stopped descending at depth 256 and left the subtree as it was,
// so a secret nested 257+ levels deep was exported in clear with "redacted 0".
describe('verifier: the camelCase extension is a true superset of the binding rule', () => {
  it('matches every mixed-case spelling the case-insensitive binding rule matches', () => {
    for (const key of [
      'PassWord',
      'PASSword',
      'pASSWORD',
      'APIkey',
      'ApIkEy',
      'Client_SECRET',
      'CLIENT-secret',
      'ToKeN',
      'x-APIkey',
      'JWT_toKEN',
      'SET-cookie',
      'SetCOOKIE',
      'BEARER',
      'aPiKeY',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('agrees with a plain implementation of the binding rule on every key it matches', () => {
    // The binding rule, literally: lower-case, `-` == `_`, whole key or a
    // contiguous run of delimited segments equals a listed key.
    const listed = new Set(SECRET_KEYS.map((k) => k.replace(/-/g, '_')));
    const binding = (key: string): boolean => {
      const segs = key.toLowerCase().replace(/-/g, '_').split('_').filter((s) => s !== '');
      for (let i = 0; i < segs.length; i += 1) {
        for (let j = i + 1; j <= segs.length; j += 1) if (listed.has(segs.slice(i, j).join('_'))) return true;
      }
      return listed.has(key.toLowerCase().replace(/-/g, '_'));
    };
    const alphabet = ['pass', 'PASS', 'Word', 'WORD', 'word', 'api', 'API', 'Key', 'KEY', 'key', 'to', 'TO', 'Ken', 'KEN', 'x', '-', '_', 'Secret', 'CLIENT', 'client'];
    let checked = 0;
    for (const a of alphabet) {
      for (const b of alphabet) {
        for (const c of alphabet) {
          const key = `${a}${b}${c}`;
          if (binding(key)) {
            checked += 1;
            expect(isSecretKey(key), key).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('a segment run matches however many segments the key has (no segment cap that leaks)', () => {
    expect(isSecretKey(`${'a_'.repeat(200)}token`)).toBe(true);
    expect(isSecretKey(`${'a-'.repeat(100_000)}api-key`)).toBe(true);
    expect(isSecretKey(`${'a_'.repeat(100_000)}b`)).toBe(false);
  });

  it('splits camelCase exactly as before, in linear time on hostile keys', () => {
    for (const key of ['HTTPToken', 'APIKey', 'OAuthToken', 'XSRFToken', 'ABCDefAccessToken']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['HTTPTokens', 'APIKeys', 'ABCDef']) expect(isSecretKey(key), key).toBe(false);
    // /([A-Z]+)([A-Z][a-z])/ backtracked quadratically: 50k capitals took 3.5 s,
    // 200k would take about a minute. Linear, this is milliseconds.
    const started = performance.now();
    expect(isSecretKey('A'.repeat(200_000))).toBe(false);
    expect(isSecretKey(`${'A'.repeat(200_000)}Token`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('still does not match the binding non-matches', () => {
    for (const key of ['max_tokens', 'maxTokens', 'MAX_TOKENS', 'MaxTokens', 'tokenizer', 'Tokenizer', 'TOKENIZER']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('verifier: the walk has no depth at which secrets start leaking', () => {
  function nested(depth: number, leaf: unknown, wrap: 'object' | 'array'): unknown {
    let value = leaf;
    for (let i = 0; i < depth; i += 1) value = wrap === 'object' ? { child: value } : [value];
    return value;
  }

  it.each([256, 257, 300, 5_000])('redacts a secret nested %i levels deep (objects)', (depth) => {
    const input = nested(depth, { api_key: 'DEEP-CANARY', keep: 'visible' }, 'object');
    const { value, count, keys } = redactSecrets(input);
    const json = JSON.stringify(value);
    expect(json).not.toContain('DEEP-CANARY');
    expect(json).toContain('visible');
    expect(count).toBe(1);
    expect([...keys]).toEqual(['api_key']);
  });

  it.each([257, 5_000])('redacts a secret nested %i levels deep (arrays)', (depth) => {
    const input = nested(depth, [{ password: 'DEEP-ARRAY-CANARY' }, 'visible'], 'array');
    const { value, count } = redactSecrets(input);
    const json = JSON.stringify(value);
    expect(json).not.toContain('DEEP-ARRAY-CANARY');
    expect(json).toContain('visible');
    expect(count).toBe(1);
  });

  it('keeps the structure of a deep value exactly (only the secret changes) and does not mutate', () => {
    const input = nested(1_000, { token: 't', n: 1 }, 'object');
    const before = JSON.stringify(input);
    const { value } = redactSecrets(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(value)).toBe(before.replace('"token":"t"', `"token":"${REDACTED}"`));
  });

  it('shares untouched subtrees and returns the same reference when nothing matched', () => {
    const clean = { a: [{ b: 1 }, { c: [2, 3] }], d: { e: 'f' } };
    expect(redactSecrets(clean).value).toBe(clean);
    const mixed = { clean: { x: [1, 2] }, dirty: { token: 'y' } };
    const out = redactSecrets(mixed).value as typeof mixed;
    expect(out).not.toBe(mixed);
    expect(out.clean).toBe(mixed.clean);
  });

  it('never throws and never loops on a cyclic value (not JSON, but the function is exported)', () => {
    const cyc: Record<string, unknown> = { token: 'secret-in-cycle' };
    cyc['self'] = cyc;
    const arr: unknown[] = [];
    arr.push(arr, { password: 'p' });
    let result: ReturnType<typeof redactSecrets> | undefined;
    expect(() => {
      result = redactSecrets(cyc);
    }).not.toThrow();
    expect((result?.value as Record<string, unknown>)['token']).toBe(REDACTED);
    expect(() => redactSecrets(arr)).not.toThrow();
    expect(redactSecrets(arr).count).toBe(1);
  });

  it('redactStoredEvents: a deep secret inside a stored payload is redacted and counted', () => {
    const deep = nested(400, { Authorization: 'Bearer DEEP-EVENT-CANARY' }, 'object');
    const events: StoredEvent[] = [
      { runId: 'r', seq: 0, ts: 0, type: 'node.started', nodeId: 'tool:x', payload: { nodeId: 'tool:x', kind: 'tool', name: 'x', instanceId: '1', input: deep } },
    ];
    const result = redactStoredEvents(events);
    expect(JSON.stringify(result.events)).not.toContain('DEEP-EVENT-CANARY');
    expect(result.count).toBe(1);
  });
});
