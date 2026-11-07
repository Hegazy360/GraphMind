/**
 * Entry point. `pnpm start <scenario>` runs one ticket; `pnpm start all`
 * runs the whole shift. Reads ANTHROPIC_API_KEY from ./.env (copied from
 * .env.example) or the environment — that is the entire configuration.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIO_ORDER, SCENARIOS } from './scenarios.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Shells (and some tool launchers) export these as EMPTY strings, which the
// Anthropic provider rejects at import time ("baseURL must be a non-empty
// string"). Empty means unset; treat it that way. The agent module is
// imported dynamically below so this runs first.
for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
  if (process.env[name] === '') delete process.env[name];
}

const log = (message: string): void => console.log(message);

function printUsage(): void {
  log('usage: pnpm start <scenario>\n');
  log('scenarios:');
  for (const name of SCENARIO_ORDER) {
    log(`  ${name.padEnd(10)} ${SCENARIOS[name]!.ticket}`);
  }
  log(`  ${'all'.padEnd(10)} run the whole shift, one ticket after another\n`);
  log('With the viewer open (npx graphmind-ai), scenarios that hold will wait');
  log('for you — that is the point. Release them from the viewer, or run with');
  log('the server closed to only record.');
}

async function runOne(
  runTicket: (typeof import('./agent.js'))['runTicket'],
  name: string,
): Promise<void> {
  const scenario = SCENARIOS[name]!;
  log('');
  log('═'.repeat(72));
  log(`TICKET [${scenario.name}] — ${scenario.ticket}`);
  log('─'.repeat(72));
  log('What to watch for:');
  for (const line of scenario.expect) log(`  • ${line}`);
  log('─'.repeat(72));
  const result = await runTicket(scenario, log);
  log('');
  log(result.aborted ? '(aborted from the debugger)' : `Agent's reply:\n${result.text}`);
  log('');
  log(`Afterwards: graphmind runs --behavior last   (or open the run's Behaviour strip)`);
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg === undefined || arg === '--help' || arg === '-h') {
    printUsage();
    return arg === undefined ? 1 : 0;
  }
  // Under `graphmind replay` the model is served from a recording and no
  // provider is called, so a key is not needed — and demanding one would
  // make the agent impossible to replay in CI, where there is no key to
  // give. Any agent that validates credentials at startup needs this
  // check; it is two lines.
  const replaying = (process.env['GRAPHMIND_REPLAY'] ?? '') !== '';
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!replaying && (key === undefined || key === '' || key.endsWith('...'))) {
    console.error('support-desk: set ANTHROPIC_API_KEY first — cp .env.example .env, paste your key.');
    return 1;
  }
  const names = arg === 'all' ? [...SCENARIO_ORDER] : [arg];
  for (const name of names) {
    if (SCENARIOS[name] === undefined) {
      console.error(`support-desk: unknown scenario "${name}"\n`);
      printUsage();
      return 1;
    }
  }
  const { runTicket } = await import('./agent.js');
  for (const name of names) await runOne(runTicket, name);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`support-desk: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
