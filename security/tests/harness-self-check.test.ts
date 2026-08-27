/**
 * Does this audit actually work?
 *
 * A leak suite that can never fail is worse than no suite: it converts silence
 * into false confidence. These tests deliberately POISON the data path — an
 * agent that hands its own API key to a tool as an argument — and require the
 * harness to find that canary on every single surface it inspects. If any
 * surface stops being collected, or the scanner stops matching, this file goes
 * red and `adapter-leaks.test.ts` is known to be trustworthy again.
 *
 * (The poisoned agent is not a GraphMind defect. Recording a tool argument is
 * the product working exactly as documented; the point here is that the
 * pipeline from agent -> database -> HTTP -> WebSocket -> exports really is
 * being read end to end.)
 */
import { describe, expect, it } from 'vitest';
import { graphmind } from '@graphmind-ai/anthropic';
import { makeCanaries } from '../src/canaries.js';
import { cleanupAudit, runAudit } from '../src/harness.js';
import { audit, contains, scanArtifact, type Artifact } from '../src/scan.js';

describe('scanner', () => {
  const canaries = makeCanaries('SELFCHECK');
  const secret = canaries.get('providerApiKey');

  const artifactOf = (content: string | Buffer): Artifact => ({
    name: 'synthetic',
    surface: 'test',
    content,
  });

  it('finds a literal match', () => {
    expect(contains(artifactOf(`prefix ${secret.value} suffix`), secret)).toBe(true);
  });

  it('finds a case-folded match', () => {
    expect(contains(artifactOf(secret.value.toLowerCase()), secret)).toBe(true);
  });

  it('finds a percent-encoded match', () => {
    const pii = canaries.get('envPii'); // contains '@' and '.', so encoding differs
    expect(contains(artifactOf(encodeURIComponent(pii.value)), pii)).toBe(true);
  });

  it('finds a base64 match', () => {
    const encoded = Buffer.from(secret.value, 'utf8').toString('base64');
    expect(contains(artifactOf(`data:application/json;base64,${encoded}`), secret)).toBe(true);
  });

  it('finds a match inside binary content', () => {
    const bytes = Buffer.concat([
      Buffer.from([0x00, 0x01, 0xff, 0xfe]),
      Buffer.from(secret.value, 'utf8'),
      Buffer.from([0x00]),
    ]);
    expect(contains(artifactOf(bytes), secret)).toBe(true);
  });

  it('does not match an unrelated string', () => {
    expect(contains(artifactOf('nothing to see here'), secret)).toBe(false);
  });

  it('redacts the canary out of the reported context', () => {
    const hits = scanArtifact(artifactOf(`left ${secret.value} right`), [secret]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.context).not.toContain(secret.value);
    expect(hits[0]?.context).toContain('<<<CANARY:');
  });
});

describe('poisoned run — every surface must report the leak', () => {
  it('catches a credential that really was put in the data path', async () => {
    const canaries = makeCanaries('POISON');
    const planted = canaries.get('providerApiKey');

    const result = await runAudit({
      env: canaries.envVars(),
      agent: async (ctx) => {
        const gm = graphmind({
          url: ctx.ingestUrl,
          enabled: true,
          app: 'audit-poisoned',
          waitForAttach: 3000,
          retryIntervalMs: 60_000,
          logger: () => {},
        });
        const tools = gm.wrapTools({
          // The agent hands its own API key to a tool. GraphMind records tool
          // arguments by design, so this MUST show up everywhere.
          leakyTool: async (input: { apiKey: string }) => ({ echoed: input.apiKey }),
        });
        try {
          await gm.run('poisoned', async () => {
            await tools.leakyTool({ apiKey: planted.value });
          });
        } finally {
          await gm.dispose();
        }
      },
    });

    try {
      const outcome = audit(result.artifacts, canaries);
      const leakedSurfaces = new Set(outcome.leaks.map((hit) => hit.surface));

      for (const surface of ['sqlite', 'http-api', 'websocket', 'html-export', 'ndjson-export']) {
        expect(
          leakedSurfaces.has(surface),
          `surface "${surface}" did not report the planted canary — it is not really being scanned`,
        ).toBe(true);
      }
      // Telemetry never carries run data, poisoned or not.
      expect(leakedSurfaces.has('telemetry')).toBe(false);
    } finally {
      cleanupAudit(result);
    }
  }, 90_000);
});
