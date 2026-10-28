/**
 * Renders the telemetry aggregates as one self-contained HTML page: inline
 * SVG, no scripts, no external assets — openable from a file:// URL and
 * attachable to a discussion without leaking anything beyond the aggregates
 * themselves (the same numbers `pnpm telemetry` prints).
 *
 * Pure string-building on purpose: telemetry-report.mjs owns all I/O, this
 * module owns none, so the charts are unit-testable without a blob token.
 */

/** Distinct, print-safe colors; commands are assigned by total, descending. */
const PALETTE = [
  '#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2',
  '#be185d', '#65a30d', '#9333ea', '#ea580c', '#0d9488', '#4b5563',
];

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every yyyy-mm-dd from first to last, so quiet days show as gaps, not lies. */
export function fillDateRange(dates) {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort();
  const out = [];
  const last = sorted[sorted.length - 1];
  // Date math in UTC: these are calendar dates, not instants.
  for (let t = Date.parse(`${sorted[0]}T00:00:00Z`); ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(day);
    if (day === last) return out;
  }
}

/** 1/2/5 × 10^k ceiling, so the y-axis lands on a readable number. */
export function niceCeiling(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}

const CHART = { width: 880, height: 240, left: 44, bottom: 28, top: 8 };

function yGrid(max) {
  const lines = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = (max / 4) * i;
    const y = CHART.top + (CHART.height - CHART.top - CHART.bottom) * (1 - value / max);
    lines.push(
      `<line x1="${CHART.left}" y1="${y.toFixed(1)}" x2="${CHART.width}" y2="${y.toFixed(1)}" class="grid"/>` +
        `<text x="${CHART.left - 6}" y="${(y + 4).toFixed(1)}" class="tick" text-anchor="end">${value % 1 === 0 ? value : value.toFixed(1)}</text>`,
    );
  }
  return lines.join('');
}

function xLabels(dates, slot) {
  const every = Math.max(1, Math.ceil(dates.length / 12));
  const baseline = CHART.height - CHART.bottom + 16;
  return dates
    .map((date, i) => {
      if (i % every !== 0 && i !== dates.length - 1) return '';
      const x = CHART.left + slot * i + slot / 2;
      return `<text x="${x.toFixed(1)}" y="${baseline}" class="tick" text-anchor="middle">${esc(date.slice(5))}</text>`;
    })
    .join('');
}

/**
 * Stacked bars, one per date. `series` = [{ name, color, byDate: Map }] with
 * the first series drawn at the bottom of each stack.
 */
export function svgStackedByDay(dates, series) {
  const plotH = CHART.height - CHART.top - CHART.bottom;
  const slot = (CHART.width - CHART.left) / Math.max(dates.length, 1);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const max = niceCeiling(
    Math.max(1, ...dates.map((d) => series.reduce((sum, s) => sum + (s.byDate.get(d) ?? 0), 0))),
  );
  const bars = dates
    .map((date, i) => {
      const x = CHART.left + slot * i + (slot - barW) / 2;
      let yBase = CHART.height - CHART.bottom;
      let stack = '';
      let total = 0;
      for (const s of series) {
        const value = s.byDate.get(date) ?? 0;
        if (value === 0) continue;
        total += value;
        const h = (value / max) * plotH;
        yBase -= h;
        stack += `<rect x="${x.toFixed(1)}" y="${yBase.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"/>`;
      }
      if (stack === '') return '';
      return `<g>${stack}<title>${esc(date)}: ${total} event${total === 1 ? '' : 's'}</title></g>`;
    })
    .join('');
  return (
    `<svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="img">` +
    yGrid(max) + bars + xLabels(dates, slot) +
    '</svg>'
  );
}

/** Plain bars, one per date (unique installs per day). */
export function svgBarsByDay(dates, byDate, color) {
  return svgStackedByDay(dates, [{ name: '', color, byDate }]);
}

/** Horizontal bars for command totals, largest first. */
export function svgTotalsBars(totals) {
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = niceCeiling(Math.max(1, ...rows.map(([, count]) => count)));
  const rowH = 26;
  const labelW = 110;
  const width = 880;
  const bars = rows
    .map(([name, count], i) => {
      const y = i * rowH;
      const w = ((width - labelW - 60) * count) / max;
      const color = PALETTE[i % PALETTE.length];
      return (
        `<text x="${labelW - 8}" y="${y + 17}" class="label" text-anchor="end">${esc(name)}</text>` +
        `<rect x="${labelW}" y="${y + 4}" width="${Math.max(w, 1).toFixed(1)}" height="${rowH - 10}" fill="${color}"/>` +
        `<text x="${labelW + Math.max(w, 1) + 6}" y="${y + 17}" class="label">${count}</text>`
      );
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${rows.length * rowH}" role="img">${bars}</svg>`;
}

function legend(series) {
  return (
    '<div class="legend">' +
    series
      .map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`)
      .join('') +
    '</div>'
  );
}

/**
 * The whole page. Input shapes (all plain data, already aggregated):
 *   dates            sorted yyyy-mm-dd strings that saw at least one event
 *   perDay           Map<date, Map<event, count>>
 *   installsPerDay   Map<date, number>
 *   totals           Map<event, count>
 *   totalEvents, uniqueInstalls, returningInstalls   numbers
 *   generatedAt      ISO timestamp for the footer
 */
export function renderDashboard(data) {
  const dates = fillDateRange(data.dates);
  const commands = [...data.totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name], i) => ({
      name,
      color: PALETTE[i % PALETTE.length],
      byDate: new Map(dates.map((d) => [d, data.perDay.get(d)?.get(name) ?? 0])),
    }));
  const cards = [
    ['Events', data.totalEvents],
    ['Unique installs', data.uniqueInstalls],
    ['Active ≥2 days', data.returningInstalls],
    ['Days with activity', data.dates.length],
  ]
    .map(([label, value]) => `<div class="card"><b>${value}</b><span>${esc(label)}</span></div>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GraphMind telemetry — ${esc(dates[0] ?? '')} to ${esc(dates[dates.length - 1] ?? '')}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; color: #111827; margin: 2rem auto; max-width: 960px; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin: 2rem 0 .5rem; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: .7rem 1.1rem; min-width: 8rem; }
  .card b { display: block; font-size: 1.5rem; }
  .card span { color: #6b7280; font-size: .85rem; }
  svg { width: 100%; height: auto; }
  .grid { stroke: #e5e7eb; stroke-width: 1; }
  .tick { font-size: 11px; fill: #6b7280; }
  .label { font-size: 12px; fill: #111827; }
  .legend { display: flex; gap: .9rem; flex-wrap: wrap; margin: .3rem 0 0; color: #374151; font-size: .85rem; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: .35rem; }
  footer { color: #6b7280; font-size: .8rem; margin-top: 2.5rem; }
</style>
<h1>GraphMind usage telemetry</h1>
<p>Aggregate, anonymous command counts — what <code>packages/cli/TELEMETRY.md</code> describes, nothing more.</p>
<div class="cards">${cards}</div>
<h2>Events per day, by command</h2>
${svgStackedByDay(dates, commands)}
${legend(commands)}
<h2>Unique installs per day</h2>
${svgBarsByDay(dates, new Map(dates.map((d) => [d, data.installsPerDay.get(d) ?? 0])), '#2563eb')}
<h2>Command totals</h2>
${svgTotalsBars(data.totals)}
<footer>Generated ${esc(data.generatedAt)} by apps/web/scripts/telemetry-report.mjs --html</footer>
</html>
`;
}
