/**
 * Cross-major fixture plumbing for the advertised `ai` peer range (>=6 <8).
 *
 * `ai@7` exports its language-model mock as `MockLanguageModelV4` (provider
 * spec V4). `ai@6` exports only `MockLanguageModelV3` (spec V3). Naming
 * either one directly kills the whole test file at module load on the other
 * major, so both the mock class and the provider types the scripted stream
 * parts are written against are resolved from what the INSTALLED SDK
 * actually exports.
 *
 * One set of scripted parts is enough for both majors: `@ai-sdk/provider@3`
 * (shipped with ai@6) already uses the nested `usage` object and the
 * `{ unified, raw }` finish reason that V4 uses, so the V3 and V4 shapes the
 * fixtures touch are identical. The type aliases below are derived from the
 * mock constructor rather than restated, so a future divergence is a
 * compile error here instead of a silent `any`.
 */
import { createRequire } from 'node:module';
import * as ai from 'ai';
import * as aiTest from 'ai/test';

type TestExports = typeof aiTest;

/** `typeof MockLanguageModelV4` on ai@7, `typeof MockLanguageModelV3` on ai@6. */
type MockLanguageModelCtor = TestExports extends { MockLanguageModelV4: infer C }
  ? C
  : TestExports extends { MockLanguageModelV3: infer C }
    ? C
    : never;

type MockOptions =
  MockLanguageModelCtor extends abstract new (options?: infer O) => unknown
    ? NonNullable<O>
    : never;

type DoStreamFn = Extract<
  NonNullable<MockOptions extends { doStream?: infer D } ? D : never>,
  (...args: never[]) => unknown
>;
type DoGenerateFn = Extract<
  NonNullable<MockOptions extends { doGenerate?: infer D } ? D : never>,
  (...args: never[]) => unknown
>;

/** `LanguageModelV{3,4}CallOptions`. */
export type CallOptions = Parameters<DoStreamFn>[0];
/** `LanguageModelV{3,4}Prompt`. */
export type Prompt = CallOptions['prompt'];
/** `LanguageModelV{3,4}StreamPart`. */
export type StreamPart =
  Awaited<ReturnType<DoStreamFn>>['stream'] extends ReadableStream<infer P> ? P : never;
/** `LanguageModelV{3,4}Usage`. */
export type Usage = Extract<StreamPart, { type: 'finish' }>['usage'];
/** `LanguageModelV{3,4}GenerateResult`. */
export type GenerateResult = Awaited<ReturnType<DoGenerateFn>>;
/** An instance of whichever mock class this major exports. */
export type MockLanguageModel =
  MockLanguageModelCtor extends abstract new (...args: never[]) => infer I ? I : never;

const testExports = aiTest as unknown as Record<string, unknown>;

/** The mock language model class this major exports. */
export const MockLanguageModel = (testExports['MockLanguageModelV4'] ??
  testExports['MockLanguageModelV3']) as MockLanguageModelCtor;

/** Installed `ai` version, for skip messages. Never throws. */
export const aiVersion: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('ai/package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * ai@7 added per-tool timeouts (`timeout: { toolMs }`, `timeout: { tools }`)
 * and the `getToolTimeoutMs` reader that implements them. ai@6's
 * `TimeoutConfiguration` is only `{ totalMs, stepMs, chunkMs }` — nothing
 * ever arms an abort around a tool body there, so a tool-timeout test has no
 * behaviour to assert on that major. Probed from the export rather than from
 * a version string so it stays true for prereleases and forks.
 */
export const supportsToolTimeout: boolean = 'getToolTimeoutMs' in ai;

/**
 * `timeout` option for `streamText`, typed loosely on purpose: `toolMs` does
 * not exist in ai@6's `TimeoutConfiguration`, and the fixtures pass it
 * through only when {@link supportsToolTimeout} says the SDK understands it.
 */
export type TimeoutOption = number | Record<string, unknown>;

/**
 * Options for calling a wrapped tool's `execute` directly. ai@7's
 * `ToolExecutionOptions` carries a required `context`; ai@6's has no such
 * field and its `ToolExecutionOptions` is not generic, so neither type can be
 * named portably. The extra key is always set (harmless on ai@6) and the
 * result adopts the call site's expected parameter type.
 */
export function toolExecutionOptions<T>(toolCallId: string): T {
  return { toolCallId, messages: [], context: undefined } as T;
}
