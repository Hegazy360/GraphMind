/**
 * The central claim under test:
 *
 *   GraphMind records what the agent DID — prompts, tool arguments, tool
 *   results — and nothing about how the app AUTHENTICATED. A credential that
 *   only ever lived in the provider client's configuration, in an HTTP header,
 *   in a URL, or in the process environment must not appear in any artifact
 *   GraphMind can hand to a human.
 *
 * Each adapter is run for real, against a real GraphMind server, with every
 * credential replaced by a unique canary. The suite then:
 *
 *   1. proves the canaries were genuinely on the wire (otherwise "no leak"
 *      would be a tautology),
 *   2. greps all six artifact surfaces for the forbidden canaries, and
 *   3. asserts the by-design canaries ARE recorded, because a debugger that
 *      dropped them would be broken — and because that is precisely what
 *      `graphmind record --html` warns about before you share the file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAiSdkAgent } from '../src/agents/ai-sdk-agent.js';
import { runAnthropicAgent } from '../src/agents/anthropic-agent.js';
import { runOpenAiAgent } from '../src/agents/openai-agent.js';
import { makeCanaries, type CanarySet } from '../src/canaries.js';
import { cleanupAudit, runAudit, type AuditArtifacts } from '../src/harness.js';
import { MockProvider } from '../src/mock-provider.js';
import { audit, contains, describeHits, scanAll, type Artifact } from '../src/scan.js';

interface AdapterCase {
  readonly name: string;
  readonly scope: string;
  readonly run: typeof runAnthropicAgent;
  /** Canaries this adapter genuinely puts on the provider wire. */
  readonly wireCanaries: readonly string[];
}

const ADAPTERS: AdapterCase[] = [
  {
    name: 'anthropic',
    scope: 'ANT',
    run: runAnthropicAgent,
    wireCanaries: [
      'providerApiKey',
      'authHeader',
      'orgHeader',
      'baseUrlToken',
      'baseUrlPathToken',
      'perRequestHeader',
    ],
  },
  {
    name: 'openai',
    scope: 'OAI',
    run: runOpenAiAgent,
    wireCanaries: [
      'providerApiKey',
      'authHeader',
      'orgHeader',
      'baseUrlToken',
      'baseUrlPathToken',
      'perRequestHeader',
    ],
  },
  {
    name: 'ai-sdk',
    scope: 'AISDK',
    run: runAiSdkAgent,
    wireCanaries: [
      'providerApiKey',
      'authHeader',
      'orgHeader',
      'baseUrlToken',
      'baseUrlPathToken',
      'perRequestHeader',
    ],
  },
];

describe.each(ADAPTERS)('$name adapter', (adapter) => {
  let canaries: CanarySet;
  let provider: MockProvider;
  let result: AuditArtifacts;
  let envDuringRun: Record<string, string | undefined> = {};

  const bySurface = (...surfaces: string[]): Artifact[] =>
    result.artifacts.filter((a) => surfaces.includes(a.surface));

  beforeAll(async () => {
    canaries = makeCanaries(adapter.scope);
    provider = await MockProvider.start({ toolArg: canaries.value('toolArg') });
    result = await runAudit({
      env: canaries.envVars(),
      captureTelemetry: true,
      agent: async (ctx) => {
        envDuringRun = {
          AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
          AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
          DATABASE_PASSWORD: process.env['DATABASE_PASSWORD'],
          APP_SESSION_TOKEN: process.env['APP_SESSION_TOKEN'],
          SUPPORT_CONTACT_EMAIL: process.env['SUPPORT_CONTACT_EMAIL'],
        };
        await adapter.run({ ingestUrl: ctx.ingestUrl, canaries, provider });
      },
    });
  }, 90_000);

  afterAll(async () => {
    await provider?.close();
    if (result !== undefined) cleanupAudit(result);
  });

  // -- anti-vacuous guards --------------------------------------------------

  it('actually produced a recorded run with events', () => {
    expect(result.runIds.length).toBeGreaterThan(0);
    const events = bySurface('http-api').find((a) => a.name.includes('/events'));
    expect(events).toBeDefined();
    const parsed = JSON.parse(String(events?.content)) as { total?: number };
    expect(parsed.total ?? 0).toBeGreaterThan(3);
  });

  it('the credential canaries were genuinely on the provider wire', () => {
    const wire: Artifact = {
      name: 'mock provider request log',
      surface: 'wire',
      content: provider.wireText(),
    };
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const id of adapter.wireCanaries) {
      expect(
        contains(wire, canaries.get(id)),
        `canary "${id}" never reached the provider — the leak test for it would be vacuous`,
      ).toBe(true);
    }
  });

  it('the environment canaries were genuinely set on the app process', () => {
    expect(envDuringRun['AWS_SECRET_ACCESS_KEY']).toBe(canaries.value('envAwsSecret'));
    expect(envDuringRun['DATABASE_PASSWORD']).toBe(canaries.value('envDbPassword'));
    expect(envDuringRun['SUPPORT_CONTACT_EMAIL']).toBe(canaries.value('envPii'));
  });

  // -- surface 1: the SQLite database --------------------------------------

  it('SQLite database (bytes, incl. WAL) contains no credential', () => {
    const artifacts = bySurface('sqlite');
    expect(artifacts.length).toBeGreaterThan(0);
    const hits = scanAll(artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  });

  // -- surface 2: the HTTP API ---------------------------------------------

  it('GET /api/runs and /api/runs/:id/events contain no credential', () => {
    const artifacts = bySurface('http-api');
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
    const hits = scanAll(artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  });

  // -- surface 3: the viewer WebSocket -------------------------------------

  it('the WebSocket envelopes the viewer receives contain no credential', () => {
    const artifacts = bySurface('websocket');
    expect(artifacts.length).toBe(1);
    expect(String(artifacts[0]?.content).length).toBeGreaterThan(100);
    const hits = scanAll(artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  });

  // -- surface 4: the shareable HTML export --------------------------------

  it('the `graphmind record --html` page contains no credential', () => {
    const artifacts = bySurface('html-export');
    expect(artifacts.length).toBe(1);
    expect(String(artifacts[0]?.content)).toContain('__GRAPHMIND_RUN__');
    const hits = scanAll(artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  });

  // -- surface 5: the NDJSON export ----------------------------------------

  it('the `graphmind record` NDJSON export contains no credential', () => {
    const artifacts = bySurface('ndjson-export');
    expect(artifacts.length).toBe(1);
    const lines = String(artifacts[0]?.content).trim().split('\n');
    expect(lines.length).toBeGreaterThan(3);
    const hits = scanAll(artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  });

  // -- surface 6: telemetry -------------------------------------------------

  it('telemetry payloads contain no canary at all — not even by-design data', () => {
    expect(result.telemetryBodies.length).toBeGreaterThan(0);
    const artifacts = bySurface('telemetry');
    const hits = scanAll(artifacts, canaries.all);
    expect(describeHits(hits)).toBe('no leaks');

    for (const raw of result.telemetryBodies) {
      const captured = JSON.parse(raw) as { body: string };
      const payload = JSON.parse(captured.body) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['event', 'installId', 'ts', 'version']);
      expect(payload['event']).toBe('record');
    }
  });

  // -- every surface at once, plus the by-design half of the contract -------

  it('no credential leaks anywhere, and the prompt/tool payloads ARE recorded', () => {
    const outcome = audit(result.artifacts, canaries);
    expect(describeHits(outcome.leaks)).toBe('no leaks');
    expect(
      outcome.missingByDesign,
      'GraphMind is supposed to record prompts and tool payloads; if these are ' +
        'missing the agent did not really run and the leak assertions are vacuous',
    ).toEqual([]);
  });

  it('the HTML export is a full record of the run — which is why it warns', () => {
    const html = bySurface('html-export')[0];
    expect(html).toBeDefined();
    if (html === undefined) return;
    for (const canary of canaries.byDesign()) {
      expect(
        contains(html, canary),
        `by-design canary "${canary.id}" (${canary.where}) is missing from the HTML export`,
      ).toBe(true);
    }
  });
});
