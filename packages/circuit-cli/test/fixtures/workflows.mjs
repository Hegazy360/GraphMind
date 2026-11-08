// A user workflow module as `circuit dev --workflows` would load it.
import { workflow } from '@graphmind-ai/circuit-sdk';

export const greet = workflow({ name: 'greet' }, async (ctx, input) => {
  const name = await ctx.step('pick-name', () => (input && input.name) || 'world');
  return `hello ${name}`;
});

export const sum = workflow({ name: 'sum' }, async (ctx, input) => {
  const a = await ctx.step('a', () => input.a);
  const b = await ctx.step('b', () => input.b);
  return a + b;
});

export const notAWorkflow = { config: { name: 42 } };
