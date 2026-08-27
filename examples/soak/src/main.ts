/**
 * GraphMind soak harness.
 *
 *   pnpm --filter soak start                       # the default battery
 *   pnpm --filter soak start -- --scenario=throughput --events=50000
 *   pnpm --filter soak start -- --scenario=longrun --minutes=6
 *
 * Everything here drives the real pipeline: a real graphmind-ai server in its
 * own process on an ephemeral port with a throwaway SQLite file, a real
 * @graphmind-ai/client session over a real WebSocket, and a headless viewer
 * on the real /ws/ui subprotocol. The only fake is the model, which is a
 * deterministic generator — so the harness is free and repeatable.
 */
import { parseFlags, str, bool } from './util.ts';
import { printSection, section, summarize, writeJson, type Section } from './report.ts';
import { throughputScenario } from './scenarios/throughput.ts';
import { payloadsScenario } from './scenarios/payloads.ts';
import { reconnectScenario } from './scenarios/reconnect.ts';
import { concurrentScenario } from './scenarios/concurrent.ts';
import { retentionScenario } from './scenarios/retention.ts';
import { viewerScenario } from './scenarios/viewer.ts';
import { longRunScenario } from './scenarios/longrun.ts';

type ScenarioFn = (flags: ReturnType<typeof parseFlags>) => Promise<Section>;

const SCENARIOS: Record<string, ScenarioFn> = {
  throughput: throughputScenario,
  payloads: payloadsScenario,
  reconnect: reconnectScenario,
  concurrent: concurrentScenario,
  retention: retentionScenario,
  viewer: viewerScenario,
  longrun: longRunScenario,
};

/** `--scenario=all` runs these in order; longrun is opt-in (wall-clock minutes). */
const DEFAULT_BATTERY = [
  'throughput',
  'concurrent',
  'payloads',
  'reconnect',
  'retention',
  'viewer',
];

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const requested = str(flags, 'scenario', 'all');
  const names =
    requested === 'all'
      ? DEFAULT_BATTERY
      : requested === 'everything'
        ? [...DEFAULT_BATTERY, 'longrun']
        : requested.split(',').map((name) => name.trim());

  for (const name of names) {
    if (SCENARIOS[name] === undefined) {
      console.error(`unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(2);
    }
  }

  console.log(`graphmind soak — node ${process.version} on ${process.platform}/${process.arch}`);
  console.log(`scenarios: ${names.join(', ')}`);

  const sections: Section[] = [];
  for (const name of names) {
    const fn = SCENARIOS[name] as ScenarioFn;
    const started = performance.now();
    let sec: Section;
    try {
      sec = await fn(flags);
    } catch (error) {
      sec = section(name);
      sec.checks.push({
        name: 'scenario completed',
        ok: false,
        detail: error instanceof Error ? `${error.message}` : String(error),
      });
      if (bool(flags, 'trace') && error instanceof Error) console.error(error.stack);
    }
    sec.data['durationMs'] = performance.now() - started;
    sections.push(sec);
    printSection(sec);
  }

  const { passed, failed } = summarize(sections);
  console.log('');
  console.log(`${passed} check(s) passed, ${failed} failed`);

  const jsonPath = str(flags, 'json', '');
  if (jsonPath !== '') {
    writeJson(jsonPath, {
      at: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      flags,
      sections: sections.map((sec) => ({
        name: sec.name,
        rows: sec.rows,
        checks: sec.checks,
        findings: sec.findings,
        data: sec.data,
      })),
    });
    console.log(`wrote ${jsonPath}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

await main();
