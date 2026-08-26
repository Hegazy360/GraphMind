/**
 * Model middleware built ONLY on the public `wrapLanguageModel` middleware
 * contract (LanguageModelV4Middleware in ai@7): no SDK forking, no patching.
 *
 * In wrapStream we:
 *  1. emit a node-start event,
 *  2. await gate('before-step') BEFORE calling doStream() — nothing is in
 *     flight while the gate is held,
 *  3. tee the provider stream so we can observe text deltas without
 *     disturbing what the SDK consumes.
 */

import type { LanguageModelMiddleware } from 'ai';
import type { GateEngine } from './gate.js';

export function debuggerMiddleware(engine: GateEngine): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',

    wrapStream: async ({ doStream, params }) => {
      const stepIndex = engine.nextStepIndex();
      engine.recordDoStreamParams(stepIndex, params);
      engine.emitNode('step-start', { kind: 'step', stepIndex });

      const action = await engine.timedGate('before-step', { kind: 'step', stepIndex });
      if (action.type === 'abort') {
        throw new Error(`aborted by debugger at before-step:${stepIndex}`);
      }
      // 'inject'/'retry' are not meaningful before a model step; treat as continue.

      engine.trace.mark('doStream:invoked', { stepIndex });
      const { stream, ...rest } = await doStream();

      // Tee: SDK consumes branch A, we observe branch B.
      const [forSdk, forObserver] = stream.tee();
      const observerDone = (async () => {
        let text = '';
        const reader = forObserver.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === 'text-delta') {
            text += value.delta;
            engine.trace.mark('tee:text-delta', { stepIndex, delta: value.delta });
          }
        }
        engine.setObservedText(stepIndex, text);
      })();
      engine.trackObserver(observerDone);

      return { stream: forSdk, ...rest };
    },
  };
}
