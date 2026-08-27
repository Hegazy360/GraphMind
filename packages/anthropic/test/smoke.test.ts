import { describe, expect, it } from 'vitest';
import { graphmind } from '../src/index.js';
import { runScenario } from './helpers/scenario.js';

describe('smoke', () => {
  it('runs the loop in all three transport modes while detached', async () => {
    for (const mode of ['create', 'create-stream', 'stream-helper'] as const) {
      const gm = graphmind({ enabled: true, webSocket: undefined });
      const result = await runScenario(gm, { mode });
      expect(result.runError, `mode=${mode}`).toBeUndefined();
      expect(result.turns, `mode=${mode}`).toBe(3);
      expect(result.requestCount, `mode=${mode}`).toBe(3);
      expect(result.text, `mode=${mode}`).toContain('TP1234');
      await gm.dispose();
    }
  });
});
