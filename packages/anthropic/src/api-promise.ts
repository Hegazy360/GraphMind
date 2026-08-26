/**
 * The gated call primitive.
 *
 * `client.messages.create()` returns an `APIPromise` and issues the HTTP
 * request immediately. GraphMind's core guarantee is that a held `before` gate
 * has NOTHING in flight, so the adapter cannot call the SDK until the gate
 * resolves — which means it cannot hand back the SDK's own `APIPromise`.
 *
 * `gatedApiPromise` returns a promise-shaped stand-in that:
 *  - resolves to exactly what the SDK call resolved to (after `onValue`,
 *    which is where a streaming result gets its observer),
 *  - re-exposes the `APIPromise` helpers the SDK and host apps use
 *    (`withResponse()` / `asResponse()`), deferring them onto the real
 *    `APIPromise` once it exists — `MessageStream` drives `.stream()`
 *    through `create(...).withResponse()`, so this is load-bearing,
 *  - reports the first failure exactly once, whichever consumer sees it,
 *  - never produces an unhandled rejection when only `withResponse()` is
 *    consumed (as `MessageStream` does).
 */
import type { ApiPromiseLike, ApiResponseEnvelope } from './sdk-types.js';

export interface GatedCall<T> {
  /**
   * Awaits the `before` gate and then issues the SDK call. The result is
   * boxed so `await` cannot flatten the SDK's own thenable too early.
   */
  start: () => Promise<{ api: ApiPromiseLike<T> }>;
  /** Observe / wrap the resolved value. Called at most once per call. */
  onValue: (value: T) => T;
  /** Report the failure. Called at most once per call. */
  onError: (error: unknown) => void;
}

function helperUnavailable(name: string): Error {
  return new Error(
    `[graphmind] the installed @anthropic-ai/sdk does not expose APIPromise.${name}(); ` +
      'unwrap the client (or upgrade the SDK) to use it.',
  );
}

export function gatedApiPromise<T>(call: GatedCall<T>): ApiPromiseLike<T> {
  const pending = call.start();

  let valueMemo: { value: T } | undefined;
  const transform = (value: T): T => {
    if (valueMemo === undefined) {
      let next = value;
      try {
        next = call.onValue(value);
      } catch {
        // observation must never change what the host receives
      }
      valueMemo = { value: next };
    }
    return valueMemo.value;
  };

  let reported = false;
  const report = (error: unknown): never => {
    if (!reported) {
      reported = true;
      try {
        call.onError(error);
      } catch {
        // reporting failures never reach the host
      }
    }
    throw error;
  };

  const settled = pending.then(({ api }) => api).then(transform, report);
  // Only `withResponse()` may ever be consumed (MessageStream does exactly
  // that). Mark the primary chain handled so a failure is not reported by the
  // runtime as an unhandled rejection; `settled` itself still rejects for a
  // host that does await it.
  void settled.catch(() => undefined);

  const asResponse = async (): Promise<Response> => {
    const { api } = await pending.catch(report);
    if (typeof api.asResponse !== 'function') throw helperUnavailable('asResponse');
    return await api.asResponse().catch(report);
  };

  const withResponse = async (): Promise<ApiResponseEnvelope<T>> => {
    const { api } = await pending.catch(report);
    if (typeof api.withResponse !== 'function') {
      const data = transform(await (api as PromiseLike<T>).then((v) => v, report));
      return { data, response: undefined as unknown as Response };
    }
    const envelope = await api.withResponse().catch(report);
    return { ...envelope, data: transform(envelope.data) };
  };

  return Object.defineProperties(settled, {
    asResponse: { value: asResponse, writable: true, configurable: true },
    withResponse: { value: withResponse, writable: true, configurable: true },
  }) as ApiPromiseLike<T>;
}
