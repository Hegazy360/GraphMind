/**
 * The trip planner's tool belt. All four tools are deterministic (no network,
 * no clocks) so mock-mode runs replay identically.
 *
 * THE PLANTED BUG lives in `convertCurrency`: it DIVIDES by the exchange rate
 * instead of multiplying — i.e. it inverts the rate. Converting ¥402,000 to
 * USD at 0.0067 USD/JPY should give $2,693.40; the bug produces
 * $60,000,000.00, so `checkBudget` throws a BudgetExceededError with an
 * absurd total. That is the error the GraphMind demo pauses on.
 */
import { tool } from 'ai';
import { z } from 'zod';

/** Deterministic FX table: units of `to` per 1 unit of `from`. */
const RATES: Record<string, number> = {
  'JPY:USD': 0.0067,
  'USD:JPY': 149.25,
  'EUR:USD': 1.09,
  'USD:EUR': 0.92,
};

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
}

const usd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const demoTools = {
  searchFlights: tool({
    description: 'Search round-trip flights between two cities for a given month.',
    inputSchema: z.object({
      from: z.string().describe('Origin city or airport'),
      to: z.string().describe('Destination city or airport'),
      month: z.string(),
      travelers: z.number().int().positive(),
    }),
    execute: async ({ travelers }) => ({
      carrier: 'ANA',
      route: 'SFO → NRT (round trip)',
      pricePerPerson: 118500,
      currency: 'JPY',
      travelers,
      total: 118500 * travelers,
      note: 'cheapest nonstop found',
    }),
  }),

  getWeather: tool({
    description: 'Typical weather for a city in a given month.',
    inputSchema: z.object({
      city: z.string(),
      month: z.string(),
    }),
    execute: async ({ city, month }) => ({
      city,
      month,
      avgHighC: 16,
      avgLowC: 9,
      rainyDays: 6,
      summary: 'crisp and clear — pack layers',
    }),
  }),

  convertCurrency: tool({
    description: 'Convert an amount between currencies at the current rate.',
    inputSchema: z.object({
      amount: z.number().positive(),
      from: z.string().length(3),
      to: z.string().length(3),
    }),
    execute: async ({ amount, from, to }) => {
      const rate = RATES[`${from}:${to}`];
      if (rate === undefined) throw new Error(`no rate for ${from} → ${to}`);
      // BUG(planted): inverted conversion — divides instead of multiplies.
      // Correct: amount * rate. ¥402,000 → $60,000,000 instead of $2,693.40.
      const converted = Number((amount / rate).toFixed(2));
      return { amount, from, to, rate, converted };
    },
  }),

  checkBudget: tool({
    description: 'Check a total in USD against the trip budget in USD.',
    inputSchema: z.object({
      totalUsd: z.number(),
      budgetUsd: z.number().positive(),
    }),
    execute: async ({ totalUsd, budgetUsd }) => {
      if (totalUsd > budgetUsd) {
        throw new BudgetExceededError(
          `Trip total ${usd(totalUsd)} exceeds the ${usd(budgetUsd)} budget by ${usd(totalUsd - budgetUsd)}.`,
        );
      }
      return {
        ok: true,
        totalUsd,
        budgetUsd,
        remainingUsd: Number((budgetUsd - totalUsd).toFixed(2)),
      };
    },
  }),
};
