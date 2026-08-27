/**
 * A global `fetch` probe.
 *
 * Every adapter under test ultimately dispatches provider traffic through
 * `globalThis.fetch` (the Anthropic SDK, the OpenAI SDK — and therefore
 * `@langchain/openai` — and the Vercel AI SDK all do). Wrapping it once gives
 * the suite an out-of-band, adapter-agnostic answer to the only question that
 * really matters about a gate hold: *did a real HTTP request go out while
 * execution was supposed to be held?*
 *
 * GraphMind's own transport is a WebSocket (`ws`), not fetch, so nothing the
 * debugger does shows up here.
 *
 * Install BEFORE any provider client is constructed: the OpenAI SDK captures
 * `globalThis.fetch` in its constructor.
 */

export interface HttpCall {
  url: string;
  host: string;
  method: string;
  /** `performance.now()` when fetch was entered. */
  startedAt: number;
  /** `performance.now()` when the response headers resolved (or it threw). */
  headersAt: number | undefined;
  failed: boolean;
}

const calls: HttpCall[] = [];
let installed = false;

const PROVIDER_HOSTS = ['api.anthropic.com', 'api.openai.com'];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const request = input as { url?: unknown };
  return typeof request?.url === 'string' ? request.url : String(input);
}

export function installHttpProbe(): void {
  if (installed) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function') {
    throw new Error('live-check needs a global fetch (Node >= 22)');
  }
  installed = true;
  const probed: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const method =
      (init?.method as string | undefined) ??
      ((input as { method?: string } | undefined)?.method ?? 'GET');
    const call: HttpCall = {
      url,
      host: hostOf(url),
      method: String(method).toUpperCase(),
      startedAt: performance.now(),
      headersAt: undefined,
      failed: false,
    };
    calls.push(call);
    try {
      const response = await original(input as Parameters<typeof fetch>[0], init);
      call.headersAt = performance.now();
      return response;
    } catch (error) {
      call.headersAt = performance.now();
      call.failed = true;
      throw error;
    }
  };
  globalThis.fetch = probed;
}

/** Provider calls (Anthropic / OpenAI) that STARTED in `[from, to)`. */
export function providerCallsBetween(from: number, to: number): HttpCall[] {
  return calls.filter(
    (call) =>
      PROVIDER_HOSTS.includes(call.host) && call.startedAt >= from && call.startedAt < to,
  );
}

/** All provider calls started at or after `from`. */
export function providerCallsSince(from: number): HttpCall[] {
  return calls.filter((call) => PROVIDER_HOSTS.includes(call.host) && call.startedAt >= from);
}

/** The first provider call started at or after `from`, if any. */
export function firstProviderCallSince(from: number): HttpCall | undefined {
  return providerCallsSince(from)[0];
}

export function totalProviderCalls(): number {
  return calls.filter((call) => PROVIDER_HOSTS.includes(call.host)).length;
}

export function clock(): number {
  return performance.now();
}
