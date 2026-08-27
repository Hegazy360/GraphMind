/**
 * Client wrapping: a Proxy tree over the OpenAI client. Nothing is mutated —
 * the original client keeps working uninstrumented, and the wrapper can be
 * created and thrown away freely.
 *
 * What gets intercepted:
 *
 *   client.chat.completions.create   -> gated (Chat Completions)
 *   client.responses.create          -> gated (Responses API)
 *
 * The SDK's convenience helpers — `chat.completions.stream()`, `.parse()`,
 * `.runTools()`, `responses.stream()`, `.parse()` — all build on
 * `this._client.<resource>.create(...)` internally. Calling them on the plain
 * resource would reach the ORIGINAL client and slip past instrumentation, so
 * the wrapper invokes them against a view of the resource whose `_client`
 * resolves back to the wrapped client. One interception point (`create`) then
 * covers every helper: they gate before the request, tee their streams, and
 * report usage exactly like a direct `create` call. No helper is
 * double-instrumented, because only `create` is wrapped.
 *
 * Everything else on the client is passed through. Methods are returned bound
 * to the real object: the OpenAI client class uses `#private` fields, and
 * calling such a method with a Proxy as `this` would throw. Resource classes
 * (`Completions`, `Responses`) have no private fields, which is what makes the
 * `_client` redirect above safe.
 *
 * NOT instrumented (deliberate, see README): `client.beta.*`, the Realtime
 * API, Assistants, `responses.retrieve(..., {stream:true})` continuations, and
 * the tool execution inside `runTools()` — wrap those functions with
 * `gm.wrapTools()` to gate them.
 */
import type { AdapterCore } from './core.js';
import { chatFlavor } from './chat.js';
import { makeGatedCreate } from './llm-step.js';
import { responsesFlavor } from './responses.js';
import { isObject } from './sdk-types.js';

/** Marks an already-wrapped client so `wrapClient` is idempotent. */
export const GRAPHMIND_WRAPPED: unique symbol = Symbol.for('graphmind.openai.wrapped');

/** Helper methods that must see a `_client` pointing back at the wrapper. */
const CHAT_HELPERS = ['stream', 'parse', 'runTools'] as const;
const RESPONSES_HELPERS = ['stream', 'parse'] as const;

type AnyRecord = Record<string | symbol, unknown>;

function isWrapped(value: unknown): boolean {
  try {
    return isObject(value) && (value as AnyRecord)[GRAPHMIND_WRAPPED] === true;
  } catch {
    return false;
  }
}

/**
 * Wrap an OpenAI client (or any client exposing the same resources — Azure
 * OpenAI, OpenAI-compatible gateways) so its model calls stream to GraphMind
 * and honour debugger gates. Returns the input unchanged when GraphMind is
 * disabled, when the value is not an object, or when it is already wrapped.
 */
export function wrapClient<T>(client: T, core: AdapterCore): T {
  if (!core.session.enabled || !isObject(client) || isWrapped(client)) return client;
  try {
    return makeClientProxy(client, core) as T;
  } catch (error) {
    core.warner.warn(
      'wrap-client-failed',
      `wrapClient failed; returning the client uninstrumented (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return client;
  }
}

function makeClientProxy(client: object, core: AdapterCore): object {
  const cache = new Map<string | symbol, unknown>();
  let proxy: object;

  const resolve = (target: object, prop: string | symbol): unknown => {
    if (prop === GRAPHMIND_WRAPPED) return true;
    if (cache.has(prop)) return cache.get(prop);
    const value = Reflect.get(target, prop);
    let out: unknown = value;
    if (prop === 'chat' && isObject(value)) {
      out = makeChatProxy(value, core, () => proxy);
    } else if (prop === 'responses' && isObject(value)) {
      out = makeResourceProxy(value, core, () => proxy, responsesFlavor, RESPONSES_HELPERS);
    } else if (typeof value === 'function') {
      // The client class uses #private fields: never let `this` be the proxy.
      out = (value as (...args: unknown[]) => unknown).bind(target);
    }
    cache.set(prop, out);
    return out;
  };

  proxy = new Proxy(client, {
    get: (target, prop) => resolve(target, prop),
    set: (target, prop, value) => {
      cache.delete(prop);
      return Reflect.set(target, prop, value, target);
    },
  });
  return proxy;
}

/** `client.chat` — only `completions` is special. */
function makeChatProxy(chat: object, core: AdapterCore, clientProxy: () => object): object {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(chat, {
    get(target, prop) {
      if (cache.has(prop)) return cache.get(prop);
      const value = Reflect.get(target, prop);
      let out: unknown = value;
      if (prop === 'completions' && isObject(value)) {
        out = makeResourceProxy(value, core, clientProxy, chatFlavor, CHAT_HELPERS);
      } else if (typeof value === 'function') {
        out = (value as (...args: unknown[]) => unknown).bind(target);
      }
      cache.set(prop, out);
      return out;
    },
    set: (target, prop, value) => Reflect.set(target, prop, value, target),
  });
}

/**
 * A resource whose `create` is gated and whose convenience helpers are
 * re-pointed at the wrapped client (so their internal `create` is gated too).
 */
function makeResourceProxy(
  resource: object,
  core: AdapterCore,
  clientProxy: () => object,
  flavor: Parameters<typeof makeGatedCreate>[1],
  helpers: readonly string[],
): object {
  const cache = new Map<string | symbol, unknown>();
  // A view of the resource whose `_client` is the WRAPPED client. Helper
  // methods run against it, so the `create` they call is the gated one.
  const redirected = new Proxy(resource, {
    get: (target, prop) => (prop === '_client' ? clientProxy() : Reflect.get(target, prop)),
    set: (target, prop, value) => Reflect.set(target, prop, value, target),
  });

  return new Proxy(resource, {
    get(target, prop) {
      if (cache.has(prop)) return cache.get(prop);
      const value = Reflect.get(target, prop);
      let out: unknown = value;
      if (prop === 'create' && typeof value === 'function') {
        out = makeGatedCreate(
          core,
          flavor,
          target,
          value as (body: unknown, options?: unknown) => unknown,
        );
      } else if (typeof prop === 'string' && helpers.includes(prop) && typeof value === 'function') {
        const helper = value as (...args: unknown[]) => unknown;
        out = (...args: unknown[]): unknown => helper.apply(redirected, args);
      } else if (typeof value === 'function') {
        out = (value as (...args: unknown[]) => unknown).bind(target);
      }
      cache.set(prop, out);
      return out;
    },
    set: (target, prop, value) => Reflect.set(target, prop, value, target),
  });
}
