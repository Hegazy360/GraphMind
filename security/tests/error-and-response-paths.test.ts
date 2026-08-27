/**
 * Two paths that are easy to get wrong and are not covered by the happy-path
 * audit:
 *
 * 1. THE ERROR PATH. When a provider request fails, GraphMind emits
 *    `node.error` with the error's name, message and stack. Those strings come
 *    from the provider SDK, which knows the request URL, the headers and the
 *    api key. If any of that ends up in the message or the stack, it is
 *    recorded forever.
 *
 * 2. THE RESPONSE PATH. Adapters must field-pick a provider response, not
 *    record it wholesale — because an OpenAI-compatible gateway is free to put
 *    anything in the JSON it returns, including a copy of your own
 *    Authorization header. The mock provider does exactly that on every
 *    successful call (`_debug_echo`).
 *
 * The last test documents a RESIDUAL RISK rather than a defect: if the
 * provider itself puts your credential into an error *message*, the SDK puts
 * that message on the Error, and GraphMind records the Error. GraphMind is
 * relaying what the provider said; it is still worth knowing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runAnthropicAgent } from '../src/agents/anthropic-agent.js';
import { runOpenAiAgent } from '../src/agents/openai-agent.js';
import { makeCanaries } from '../src/canaries.js';
import { cleanupAudit, runAudit, type AuditArtifacts } from '../src/harness.js';
import { MockProvider } from '../src/mock-provider.js';
import { contains, describeHits, scanAll, type Artifact } from '../src/scan.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function envelopeText(result: AuditArtifacts): string {
  return result.artifacts
    .filter((a) => a.surface !== 'sqlite')
    .map((a) => String(a.content))
    .join('\n');
}

const ADAPTERS = [
  { name: 'anthropic', scope: 'ERRANT', run: runAnthropicAgent },
  { name: 'openai', scope: 'ERROAI', run: runOpenAiAgent },
];

describe.each(ADAPTERS)('$name adapter — provider failure', (adapter) => {
  it('records node.error without leaking the URL, headers or api key', async () => {
    const canaries = makeCanaries(adapter.scope);
    const provider = await MockProvider.start({
      toolArg: canaries.value('toolArg'),
      failWith: 401,
    });
    cleanups.push(() => provider.close());

    const result = await runAudit({
      env: canaries.envVars(),
      agent: async (ctx) => {
        // The provider fails; the agent's own error propagates out of gm.run.
        await adapter
          .run({ ingestUrl: ctx.ingestUrl, canaries, provider })
          .catch(() => undefined);
      },
    });
    cleanups.push(() => cleanupAudit(result));

    // The failure really happened and really was recorded.
    expect(provider.requests.length).toBeGreaterThan(0);
    const text = envelopeText(result);
    expect(text).toContain('node.error');

    // ...and none of the credentials rode along with it.
    const hits = scanAll(result.artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  }, 90_000);
});

describe('provider response is field-picked, not recorded wholesale', () => {
  it('drops an unknown top-level field that echoes the caller Authorization header', async () => {
    const canaries = makeCanaries('ECHO');
    const provider = await MockProvider.start({ toolArg: canaries.value('toolArg') });
    cleanups.push(() => provider.close());

    const result = await runAudit({
      env: canaries.envVars(),
      agent: async (ctx) => {
        await runOpenAiAgent({ ingestUrl: ctx.ingestUrl, canaries, provider });
      },
    });
    cleanups.push(() => cleanupAudit(result));

    // Proof the gateway really echoed the credential back in its response.
    const responded: Artifact = {
      name: 'mock provider response bodies',
      surface: 'wire',
      content: provider.responseText(),
    };
    expect(provider.responseText()).toContain('_debug_echo');
    expect(contains(responded, canaries.get('providerApiKey'))).toBe(true);

    // GraphMind recorded the completion but not the gateway's extra field.
    const text = envelopeText(result);
    expect(text).not.toContain('_debug_echo');
    const hits = scanAll(result.artifacts, canaries.forbidden());
    expect(describeHits(hits)).toBe('no leaks');
  }, 90_000);
});

describe('RESIDUAL RISK (documented, not a GraphMind defect)', () => {
  /**
   * If your gateway writes your credential into the error MESSAGE, the SDK
   * attaches that message to the Error it throws and GraphMind records the
   * Error like any other. Nothing GraphMind reads is at fault — but the
   * mitigation, if one is ever wanted, is a redaction pass over
   * `toErrorInfo()` in packages/client/src/errors.ts. This test pins the
   * current behaviour so a future change to it is a deliberate one.
   */
  it('a credential the PROVIDER puts in its error message is recorded', async () => {
    const canaries = makeCanaries('GWECHO');
    const provider = await MockProvider.start({
      toolArg: canaries.value('toolArg'),
      failWith: 401,
      echoAuthInError: true,
    });
    cleanups.push(() => provider.close());

    const result = await runAudit({
      env: canaries.envVars(),
      agent: async (ctx) => {
        await runOpenAiAgent({ ingestUrl: ctx.ingestUrl, canaries, provider }).catch(
          () => undefined,
        );
      },
    });
    cleanups.push(() => cleanupAudit(result));

    const hits = scanAll(result.artifacts, [canaries.get('providerApiKey')]);
    // Documented, deliberate: the leak here originates in the provider's own
    // response body, which GraphMind treats as data. If this ever flips to
    // "no leaks", someone added redaction — update the README.
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.surface))).toContain('sqlite');

    // Every OTHER credential — the ones the provider never echoed — is clean.
    const others = canaries.forbidden().filter((c) => c.id !== 'providerApiKey');
    expect(describeHits(scanAll(result.artifacts, others))).toBe('no leaks');
  }, 90_000);
});
