import { describe, expect, it } from 'vitest';
import {
  authConfig,
  canonicalJson,
  diffManifests,
  manifestHash,
  parseManifest,
  projectSlug,
  toolHash,
  type Manifest,
} from '../src/index.js';

const base = (): Manifest =>
  parseManifest({
    version: 1,
    name: 'Petstore',
    upstream: 'https://api.petstore.test',
    tools: [
      {
        name: 'get_pet',
        description: 'Fetch one pet by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: true },
        http: { method: 'GET', path: '/pets/{id}', params: [{ arg: 'id', in: 'path' }] },
      },
    ],
    toolsets: [{ name: 'pets', tools: ['get_pet'] }],
  });

describe('manifest', () => {
  it('fills defaults and keeps the http mapping', () => {
    const m = base();
    const t = m.tools[0]!;
    expect(t.http.timeoutMs).toBe(30_000);
    expect(t.response.maxBytes).toBe(50_000);
    expect(t.requiredScopes).toEqual([]);
    expect(t.confirm).toBe(false);
  });

  it('rejects duplicate tool names, dangling toolsets and unmapped path variables', () => {
    const raw = JSON.parse(JSON.stringify(base())) as Manifest;
    raw.tools.push({ ...raw.tools[0]! });
    expect(() => parseManifest(raw)).toThrow(/duplicate tool name/);

    const bad = JSON.parse(JSON.stringify(base())) as Manifest;
    bad.toolsets[0]!.tools = ['nope'];
    expect(() => parseManifest(bad)).toThrow(/unknown tool 'nope'/);

    const unmapped = JSON.parse(JSON.stringify(base())) as Manifest;
    unmapped.tools[0]!.http.params = [];
    expect(() => parseManifest(unmapped)).toThrow(/path variable \{id\} has no path param/);
  });

  it('rejects tool names clients will not accept', () => {
    const raw = JSON.parse(JSON.stringify(base())) as Manifest;
    raw.tools[0]!.name = 'GetPet';
    expect(() => parseManifest(raw)).toThrow();
  });

  it('hashes independently of key order', () => {
    const a = base();
    const b = JSON.parse(canonicalJson(a)) as Manifest;
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(manifestHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('diffs: added / removed / changed (client-visible) / rewired (http only)', () => {
    const before = base();
    const after = JSON.parse(JSON.stringify(before)) as Manifest;
    after.tools[0]!.http.timeoutMs = 5_000; // rewired only
    after.tools.push({
      ...after.tools[0]!,
      name: 'list_pets',
      http: { ...after.tools[0]!.http, path: '/pets', params: [] },
    });
    expect(diffManifests(before, parseManifest(after))).toEqual({
      added: ['list_pets'],
      removed: [],
      changed: [],
      rewired: ['get_pet'],
    });

    const changed = JSON.parse(JSON.stringify(before)) as Manifest;
    changed.tools[0]!.description = 'Fetch one pet by its id (rewritten).';
    expect(diffManifests(before, parseManifest(changed)).changed).toEqual(['get_pet']);
    expect(toolHash(before.tools[0]!)).not.toBe(toolHash(changed.tools[0]!));
    expect(diffManifests(null, before)).toMatchObject({ added: ['get_pet'] });
  });
});

describe('project', () => {
  it('slugs are DNS labels', () => {
    expect(projectSlug.safeParse('acme-billing').success).toBe(true);
    expect(projectSlug.safeParse('Acme').success).toBe(false);
    expect(projectSlug.safeParse('-x-').success).toBe(false);
    expect(projectSlug.safeParse('ab').success).toBe(false);
  });

  it('auth config is a discriminated union with defaults per mode', () => {
    expect(authConfig.parse({ mode: 'none' })).toEqual({ mode: 'none', requireSignIn: false });
    expect(authConfig.parse({ mode: 'apikey' })).toMatchObject({ header: 'authorization', prefix: 'Bearer ' });
    expect(
      authConfig.parse({ mode: 'oidc', issuer: 'https://auth.acme.test', clientId: 'x', clientSecretRef: 'sec_1' }),
    ).toMatchObject({ scopes: ['openid'] });
    expect(authConfig.safeParse({ mode: 'oidc', issuer: 'https://auth.acme.test' }).success).toBe(false);
  });
});
