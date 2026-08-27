/**
 * Transport parity: the same loop, the same graph, whichever way the host
 * talks to the API — `messages.create`, `messages.create({stream:true})`, or
 * the `messages.stream()` helper.
 */
import { describe, expect, it } from 'vitest';
import { graphmind } from '../src/index.js';
import { runScenario, type TransportMode } from './helpers/scenario.js';

const MODES: TransportMode[] = ['create', 'create-stream', 'stream-helper'];

describe('transport parity', () => {
  for (const mode of MODES) {
    it(`instruments the loop identically in ${mode} mode`, async () => {
      const gm = graphmind({ enabled: true, webSocket: undefined });
      try {
        const result = await runScenario(gm, { mode });
        expect(result.runError).toBeUndefined();
        expect(result.turns).toBe(3);
        expect(result.requestCount).toBe(3);
        expect(result.text).toContain('TP1234');
        expect(result.text).toContain('sunny');
        expect(result.text).toContain('91.3');
        expect(result.marks.count('tool:body-end')).toBe(3);
      } finally {
        await gm.dispose();
      }
    });
  }
});
