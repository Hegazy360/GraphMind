/**
 * `GatedApiPromise` — what a gated `create()` hands back.
 *
 * The OpenAI SDK returns an `APIPromise<T>`: a Promise subclass that parses
 * the response body lazily and adds `asResponse()` / `withResponse()` /
 * `_thenUnwrap()`. GraphMind has to await a debugger gate BEFORE the request
 * is dispatched, so it cannot hand the SDK's own `APIPromise` straight back —
 * that object only exists once the gate releases.
 *
 * This class fills the gap: it is a real `Promise` subclass (so `instanceof
 * Promise`, `await`, `Promise.all`, `.catch`, `.finally` all behave), it runs
 * the gated request exactly once, and it re-implements the three `APIPromise`
 * helpers on top of the eventual SDK promise. The technique — `super()` with a
 * no-op executor plus overridden `then`/`catch`/`finally` — is the same one
 * `APIPromise` itself uses.
 *
 * `_thenUnwrap` is re-implemented rather than delegated: the SDK's version
 * re-parses the HTTP body from scratch, which fails once the body has been
 * read. Ours transforms the value GraphMind already produced, so the SDK's own
 * `chat.completions.parse()` / `responses.parse()` helpers keep working
 * through the wrapper.
 *
 * The only fidelity gap vs a real `APIPromise`: `instanceof APIPromise` is
 * false. Nothing in the SDK branches on that.
 */
import type { ApiPromiseLike } from './sdk-types.js';

/** Called by the runner with the SDK promise, as soon as it exists. */
export type ApiTracker = (api: ApiPromiseLike) => void;

/** The `props` second argument the SDK passes to `_thenUnwrap` transforms. */
export interface UnwrapProps {
  response: unknown;
}

function readRequestId(response: unknown): string | null {
  try {
    const headers = (response as { headers?: { get?: (name: string) => string | null } } | null)
      ?.headers;
    return headers?.get?.('x-request-id') ?? null;
  } catch {
    return null;
  }
}

/** Carry the SDK's non-enumerable `_request_id` across a transform. */
function carryRequestId(from: unknown, to: unknown): unknown {
  try {
    if (to === null || typeof to !== 'object') return to;
    const id = (from as { _request_id?: unknown } | null)?._request_id;
    if (id === undefined || Object.hasOwn(to, '_request_id')) return to;
    Object.defineProperty(to, '_request_id', { value: id, enumerable: false });
  } catch {
    // never throw into the host
  }
  return to;
}

export class GatedApiPromise extends Promise<unknown> {
  #run: ((track: ApiTracker) => Promise<unknown>) | undefined;
  #settled: Promise<unknown> | undefined;
  #api: ApiPromiseLike | undefined;

  /**
   * @param run performs gates + the request and resolves to the value the
   *   caller should receive. It calls `track(api)` with the SDK's own promise
   *   so `asResponse()` / `withResponse()` can reach the raw HTTP response.
   * @param eager dispatch immediately (matching the SDK, where calling
   *   `create()` puts the request in flight). Rejections are pre-caught so an
   *   un-awaited call never trips `unhandledRejection`.
   */
  constructor(run: (track: ApiTracker) => Promise<unknown>, eager = true) {
    // No-op executor: `then`/`catch`/`finally` below drive everything. Mirrors
    // the SDK's own APIPromise so the body is never parsed implicitly.
    super((resolve) => resolve(null));
    this.#run = run;
    if (eager) void this.#settle().then(undefined, () => undefined);
  }

  #settle(): Promise<unknown> {
    if (this.#settled === undefined) {
      const run = this.#run;
      this.#run = undefined;
      this.#settled =
        run === undefined
          ? Promise.reject(new Error('GraphMind: gated request has no runner'))
          : run((api) => {
              this.#api = api;
            });
    }
    return this.#settled;
  }

  override then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return this.#settle().then(onfulfilled, onrejected);
  }

  override catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | undefined | null,
  ): Promise<unknown> {
    return this.#settle().catch(onrejected);
  }

  override finally(onfinally?: (() => void) | undefined | null): Promise<unknown> {
    return this.#settle().finally(onfinally);
  }

  /** The raw `Response`, once the gated request has been dispatched. */
  async asResponse(): Promise<unknown> {
    await this.#settle();
    return await this.#api?.asResponse?.();
  }

  /** Parsed data + raw `Response` + request id, like `APIPromise.withResponse()`. */
  async withResponse(): Promise<{ data: unknown; response: unknown; request_id: string | null }> {
    const data = await this.#settle();
    const response = await this.asResponse();
    return { data, response, request_id: readRequestId(response) };
  }

  /**
   * The SDK's structured-output helpers (`chat.completions.parse`,
   * `responses.parse`) call this on whatever `create()` returned.
   */
  _thenUnwrap(transform: (data: unknown, props: UnwrapProps) => unknown): GatedApiPromise {
    return new GatedApiPromise(async (track) => {
      const data = await this.#settle();
      if (this.#api !== undefined) track(this.#api);
      let response: unknown;
      try {
        response = await this.asResponse();
      } catch {
        response = undefined;
      }
      return carryRequestId(data, transform(data, { response }));
    });
  }
}
