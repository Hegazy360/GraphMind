// Unit tests for scripts/telemetry-charts.mjs — pure string rendering, so no
// mocks and no blob token. Run from apps/web: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fillDateRange,
  niceCeiling,
  renderDashboard,
  svgStackedByDay,
  svgTotalsBars,
} from '../scripts/telemetry-charts.mjs';

test('fillDateRange fills the gaps between first and last day', () => {
  assert.deepEqual(fillDateRange(['2026-10-03', '2026-09-30']), [
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
  ]);
  assert.deepEqual(fillDateRange(['2026-10-03']), ['2026-10-03']);
  assert.deepEqual(fillDateRange([]), []);
});

test('fillDateRange crosses a month and a year boundary', () => {
  assert.deepEqual(fillDateRange(['2025-12-31', '2026-01-02']), [
    '2025-12-31',
    '2026-01-01',
    '2026-01-02',
  ]);
});

test('niceCeiling lands on 1/2/5 × 10^k', () => {
  assert.equal(niceCeiling(0), 1);
  assert.equal(niceCeiling(1), 1);
  assert.equal(niceCeiling(3), 5);
  assert.equal(niceCeiling(7), 10);
  assert.equal(niceCeiling(10), 10);
  assert.equal(niceCeiling(11), 20);
  assert.equal(niceCeiling(130), 200);
  assert.equal(niceCeiling(600), 1000);
});

test('stacked bars draw one rect per non-zero value and skip empty days', () => {
  const svg = svgStackedByDay(
    ['2026-10-01', '2026-10-02', '2026-10-03'],
    [
      { name: 'serve', color: '#111111', byDate: new Map([['2026-10-01', 2], ['2026-10-03', 1]]) },
      { name: 'demo', color: '#222222', byDate: new Map([['2026-10-01', 1]]) },
    ],
  );
  assert.equal((svg.match(/<rect /g) ?? []).length, 3); // 2026-10-02 has no bar
  assert.ok(svg.includes('2026-10-01: 3 events'));
  assert.ok(svg.includes('2026-10-03: 1 event'));
});

test('totals bars are sorted largest first and labeled with counts', () => {
  const svg = svgTotalsBars(new Map([['demo', 2], ['serve', 9], ['runs', 2]]));
  const order = [...svg.matchAll(/text-anchor="end">([a-z-]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['serve', 'demo', 'runs']); // count desc, then name
  assert.ok(svg.includes('>9<'));
});

const DASHBOARD_DATA = {
  dates: ['2026-10-01', '2026-10-03'],
  perDay: new Map([
    ['2026-10-01', new Map([['serve', 2], ['demo', 1]])],
    ['2026-10-03', new Map([['serve', 1]])],
  ]),
  installsPerDay: new Map([
    ['2026-10-01', 2],
    ['2026-10-03', 1],
  ]),
  totals: new Map([['serve', 3], ['demo', 1]]),
  totalEvents: 4,
  uniqueInstalls: 2,
  returningInstalls: 1,
  generatedAt: '2026-10-28T00:00:00.000Z',
};

test('the dashboard is one self-contained page with the headline numbers', () => {
  const html = renderDashboard(DASHBOARD_DATA);
  assert.ok(html.startsWith('<!doctype html>'));
  for (const needle of ['<b>4</b>', '<b>2</b>', '<b>1</b>', 'serve', 'demo', '2026-10-28T00:00:00.000Z']) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  // Self-contained and inert: no script, no external assets.
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes(' src='));
  assert.ok(!html.includes('http://') && !html.includes('https://'));
});

test('the dashboard escapes markup in the data it prints', () => {
  const html = renderDashboard({
    ...DASHBOARD_DATA,
    totals: new Map([['serve', 3], ['<img onerror=x>', 1]]),
    generatedAt: '"><script>alert(1)</script>',
  });
  assert.ok(!html.includes('<img onerror'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;img onerror=x&gt;'));
});
