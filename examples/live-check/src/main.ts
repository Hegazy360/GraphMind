/**
 * live-check — the mock-vs-reality suite.
 *
 * Every other test in this repo runs adapters against mocked HTTP and mock
 * models. This one runs them against the real Anthropic and OpenAI APIs, a
 * real `graphmind-ai` server on an ephemeral port with a throwaway database,
 * and a real headless debugger speaking the viewer's own subprotocol.
 *
 *   pnpm --filter live-check start                 # everything the keys allow
 *   pnpm --filter live-check start -- --only=openai-chat,langgraph
 *   pnpm --filter live-check start -- --list
 *
 * No keys? It prints why and exits 0, so CI can run it unconditionally.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHttpProbe, totalProviderCalls } from './harness/probe.js';

// MUST run before any provider client is constructed: the OpenAI SDK captures
// globalThis.fetch in its constructor.
installHttpProbe();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/**
 * Convenience for local runs: pick up `.env.local` at the repo root when the
 * keys are not already exported. Values are only ever put into `process.env`
 * of this process — never logged, never written anywhere.
 */
function loadDotEnvLocal(): boolean {
  const wanted = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  if (wanted.every((key) => (process.env[key] ?? '').length > 0)) return false;
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  } catch {
    return false;
  }
  let loaded = false;
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] as string;
    if (!wanted.includes(key)) continue;
    if ((process.env[key] ?? '').length > 0) continue;
    let value = (match[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    process.env[key] = value;
    loaded = true;
  }
  return loaded;
}

interface SuiteDef {
  id: string;
  needs: 'anthropic' | 'openai';
  load: () => Promise<(report: import('./harness/report.js').Report) => Promise<void>>;
}

const SUITES: SuiteDef[] = [
  {
    id: 'anthropic',
    needs: 'anthropic',
    load: async () => (await import('./suites/anthropic.js')).runAnthropicSuite,
  },
  {
    id: 'openai-chat',
    needs: 'openai',
    load: async () => (await import('./suites/openai-chat.js')).runOpenAiChatSuite,
  },
  {
    id: 'openai-responses',
    needs: 'openai',
    load: async () => (await import('./suites/openai-responses.js')).runOpenAiResponsesSuite,
  },
  {
    id: 'ai-sdk',
    needs: 'openai',
    load: async () => (await import('./suites/ai-sdk.js')).runAiSdkSuite,
  },
  {
    id: 'langgraph',
    needs: 'openai',
    load: async () => (await import('./suites/langgraph.js')).runLangGraphSuite,
  },
];

function parseOnly(argv: string[]): Set<string> | undefined {
  for (const arg of argv) {
    const match = /^--only=(.+)$/.exec(arg);
    if (match !== null) return new Set((match[1] as string).split(',').map((s) => s.trim()));
  }
  const index = argv.indexOf('--only');
  if (index !== -1 && argv[index + 1] !== undefined) {
    return new Set((argv[index + 1] as string).split(',').map((s) => s.trim()));
  }
  return undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'live-check — run every GraphMind adapter against real provider APIs',
        '',
        '  --only=<a,b>    run only these suites',
        '  --list          list the suites',
        '  --no-env-file   do not read keys from the repo root .env.local',
        '  -h, --help      this message',
      ].join('\n'),
    );
    return 0;
  }
  if (argv.includes('--list')) {
    console.log(SUITES.map((s) => `${s.id}  (needs ${s.needs.toUpperCase()}_API_KEY)`).join('\n'));
    return 0;
  }

  const fromFile = argv.includes('--no-env-file') ? false : loadDotEnvLocal();
  const haveAnthropic = (process.env['ANTHROPIC_API_KEY'] ?? '').length > 0;
  const haveOpenAi = (process.env['OPENAI_API_KEY'] ?? '').length > 0;

  console.log('graphmind live-check — real providers, real server, real gates');
  console.log(
    `  ANTHROPIC_API_KEY ${haveAnthropic ? 'present' : 'MISSING'}   OPENAI_API_KEY ${
      haveOpenAi ? 'present' : 'MISSING'
    }${fromFile ? '   (read from .env.local)' : ''}`,
  );

  if (!haveAnthropic && !haveOpenAi) {
    console.log(
      '\nSKIPPING the whole live-check suite: no provider API keys in the environment.\n' +
        'This is expected in CI. To run it locally:\n' +
        '  set -a; . ./.env.local; set +a\n' +
        '  pnpm --filter live-check start',
    );
    return 0;
  }

  const only = parseOnly(argv);
  const { Report } = await import('./harness/report.js');
  const report = new Report();

  for (const suite of SUITES) {
    if (only !== undefined && !only.has(suite.id)) continue;
    const keyed = suite.needs === 'anthropic' ? haveAnthropic : haveOpenAi;
    if (!keyed) {
      report.skip(suite.id, `no ${suite.needs.toUpperCase()}_API_KEY`);
      continue;
    }
    try {
      const run = await suite.load();
      await run(report);
    } catch (error) {
      report.suiteStart(suite.id);
      report.check(
        `${suite.id} suite ran to completion`,
        false,
        `threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
      if (error instanceof Error && error.stack !== undefined) {
        console.log(
          error.stack
            .split('\n')
            .slice(0, 12)
            .map((l) => `      ${l}`)
            .join('\n'),
        );
      }
    }
  }

  report.print();
  console.log(`\n  real provider HTTP requests issued: ${totalProviderCalls()}`);
  return report.failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
    // Detached sessions keep an unref'd reconnect timer; nothing should hold
    // the loop, but exit deterministically anyway.
    setTimeout(() => process.exit(code), 250).unref();
  },
  (error: unknown) => {
    console.error('live-check crashed:', error);
    process.exit(1);
  },
);
