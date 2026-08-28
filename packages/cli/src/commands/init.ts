/**
 * `graphmind init [dir]` — look at a project, work out which agent framework
 * it uses, and print the exact install command plus a copy-pasteable snippet
 * that instruments it. `--install` runs the install for you.
 *
 * Detection is deliberately dumb and transparent: read the manifest, match
 * dependency names, report what was found. No prompts (so it is safe in CI and
 * from coding agents), no files written unless `--write` is passed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ParsedCli } from '../args.js';
import { recordTelemetry } from '../telemetry.js';

export type Ecosystem = 'node' | 'python';

export interface Integration {
  /** Stable id used by --only and in tests. */
  id: string;
  /** What the user's code uses. */
  framework: string;
  ecosystem: Ecosystem;
  /** The GraphMind package that instruments it. */
  pkg: string;
  /** Dependency names that imply this framework. */
  triggers: string[];
  snippet: string;
  docs: string;
  /** An extra paragraph printed under the snippet, when one route is not the
   *  whole story (an MCP server can also be debugged without any code). */
  alsoTry?: string;
}

const NODE_SNIPPET_AI_SDK = `import { graphmind } from '@graphmind-ai/sdk';

const gm = graphmind({ app: 'my-agent' });
await gm.ready(); // optional: wait for the debugger (fails open if absent)

const model = gm.wrapModel(anthropic('claude-sonnet-4-5'));
const tools = gm.wrapTools({ searchFlights, checkBudget });

await gm.run('handle-request', () =>
  streamText({ model, tools, prompt }).consumeStream(),
);`;

const NODE_SNIPPET_ANTHROPIC = `import Anthropic from '@anthropic-ai/sdk';
import { graphmind } from '@graphmind-ai/anthropic';

const gm = graphmind({ app: 'my-agent' });
const client = gm.wrapClient(new Anthropic());
const tools = gm.wrapTools({ searchFlights, checkBudget });

await gm.run('handle-request', async () => {
  // your usual messages.create / tool-use loop, using \`client\` and \`tools\`
});`;

const NODE_SNIPPET_OPENAI = `import OpenAI from 'openai';
import { graphmind } from '@graphmind-ai/openai';

const gm = graphmind({ app: 'my-agent' });
const client = gm.wrapClient(new OpenAI());
const tools = gm.wrapTools({ searchFlights, checkBudget });

await gm.run('handle-request', async () => {
  // your usual chat.completions / responses loop, using \`client\` and \`tools\`
});`;

const NODE_SNIPPET_MCP = `import { graphmind } from '@graphmind-ai/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const gm = graphmind({ app: 'my-mcp-server' });

// Wrap BEFORE you register anything: the adapter gates a tool by decorating
// its callback as it is registered.
const server = gm.wrapServer(new McpServer({ name: 'my-server', version: '1.0.0' }));

server.registerTool('search', schema, async (args) => { /* ... */ });`;

const NODE_SNIPPET_LANGGRAPH = `import { graphmind } from '@graphmind-ai/langgraph';

const gm = graphmind({ app: 'my-agent' });

// Attach the callback handler to any LangChain / LangGraph invocation:
await graph.invoke(input, { callbacks: [gm.handler()] });

// Wrap plain tool functions too — that is what makes inject/retry work:
const tools = gm.wrapTools({ searchFlights, checkBudget });`;

const PY_SNIPPET_OPENAI = `import graphmind
from openai import OpenAI

gm = graphmind.init(app="my-agent")
client = graphmind.instrument_openai(OpenAI())

@gm.tool
def check_budget(total: float) -> dict:
    ...

with gm.run("handle-request"):
    # your usual chat.completions / responses loop, using \`client\`
    ...`;

const PY_SNIPPET_ANTHROPIC = `import graphmind
from anthropic import Anthropic

gm = graphmind.init(app="my-agent")
client = graphmind.instrument_anthropic(Anthropic())

with gm.run("handle-request"):
    # your usual messages.create / tool-use loop, using \`client\`
    ...`;

const PY_SNIPPET_LANGGRAPH = `import graphmind

gm = graphmind.init(app="my-agent")

# Attach the callback handler to any LangChain / LangGraph invocation:
graph.invoke(input, config={"callbacks": [gm.handler()]})

# Wrap plain tool functions too - that is what makes inject/retry work:
@gm.tool
def check_budget(total: float) -> dict:
    ...`;

export const INTEGRATIONS: Integration[] = [
  {
    id: 'ai-sdk',
    framework: 'Vercel AI SDK',
    ecosystem: 'node',
    pkg: '@graphmind-ai/sdk',
    triggers: ['ai', '@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/react'],
    snippet: NODE_SNIPPET_AI_SDK,
    docs: 'https://graphmind.ai/docs/integrations/vercel-ai-sdk/',
  },
  {
    id: 'anthropic',
    framework: 'Anthropic SDK',
    ecosystem: 'node',
    pkg: '@graphmind-ai/anthropic',
    triggers: ['@anthropic-ai/sdk'],
    snippet: NODE_SNIPPET_ANTHROPIC,
    docs: 'https://graphmind.ai/docs/integrations/anthropic/',
  },
  {
    id: 'openai',
    framework: 'OpenAI SDK',
    ecosystem: 'node',
    pkg: '@graphmind-ai/openai',
    triggers: ['openai'],
    snippet: NODE_SNIPPET_OPENAI,
    docs: 'https://graphmind.ai/docs/integrations/openai/',
  },
  {
    id: 'mcp',
    framework: 'MCP server',
    ecosystem: 'node',
    pkg: '@graphmind-ai/mcp',
    triggers: ['@modelcontextprotocol/sdk'],
    snippet: NODE_SNIPPET_MCP,
    docs: 'https://graphmind.ai/docs/integrations/mcp/',
    // The proxy needs nothing installed and works on a server in any
    // language, so it is the better first suggestion for most people — but it
    // cannot be expressed as a code snippet, hence the extra line.
    alsoTry:
      'Or debug it with no code changes at all, in any language:\n' +
      '  graphmind mcp-proxy -- <the command your MCP client already runs>\n' +
      '  https://graphmind.ai/docs/debugging/mcp-servers/',
  },
  {
    id: 'langgraph',
    framework: 'LangGraph / LangChain',
    ecosystem: 'node',
    pkg: '@graphmind-ai/langgraph',
    triggers: ['@langchain/langgraph', '@langchain/core', 'langchain'],
    snippet: NODE_SNIPPET_LANGGRAPH,
    docs: 'https://graphmind.ai/docs/integrations/langgraph/',
  },
  {
    id: 'py-openai',
    framework: 'OpenAI (Python)',
    ecosystem: 'python',
    pkg: 'graphmind-ai',
    triggers: ['openai'],
    snippet: PY_SNIPPET_OPENAI,
    docs: 'https://graphmind.ai/docs/integrations/python/',
  },
  {
    id: 'py-anthropic',
    framework: 'Anthropic (Python)',
    ecosystem: 'python',
    pkg: 'graphmind-ai',
    triggers: ['anthropic'],
    snippet: PY_SNIPPET_ANTHROPIC,
    docs: 'https://graphmind.ai/docs/integrations/python/',
  },
  {
    id: 'py-langgraph',
    framework: 'LangGraph / LangChain (Python)',
    ecosystem: 'python',
    pkg: 'graphmind-ai',
    triggers: ['langgraph', 'langchain', 'langchain-core', 'crewai'],
    snippet: PY_SNIPPET_LANGGRAPH,
    docs: 'https://graphmind.ai/docs/integrations/python/',
  },
];

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** Lockfile beats packageManager field beats npm. */
export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  const manifest = readJson(join(dir, 'package.json'));
  const pm = typeof manifest?.['packageManager'] === 'string' ? manifest['packageManager'] : '';
  if (pm.startsWith('pnpm')) return 'pnpm';
  if (pm.startsWith('yarn')) return 'yarn';
  if (pm.startsWith('bun')) return 'bun';
  return 'npm';
}

export function installCommand(pm: PackageManager, pkgs: string[]): string {
  const list = pkgs.join(' ');
  if (pm === 'pnpm') return `pnpm add ${list}`;
  if (pm === 'yarn') return `yarn add ${list}`;
  if (pm === 'bun') return `bun add ${list}`;
  return `npm install ${list}`;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Every dependency name declared by the project, across ecosystems. */
export function collectDependencies(dir: string): { node: Set<string>; python: Set<string> } {
  const node = new Set<string>();
  const python = new Set<string>();

  const manifest = readJson(join(dir, 'package.json'));
  if (manifest !== undefined) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const deps = manifest[field];
      if (deps !== null && typeof deps === 'object') {
        for (const name of Object.keys(deps as Record<string, unknown>)) node.add(name);
      }
    }
  }

  // Python manifests: read as text and match names loosely — parsing every
  // dependency-spec dialect is not worth it for a hint.
  for (const file of ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.cfg']) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // Two passes: bare requirement lines (requirements.txt) and quoted
    // requirement strings (pyproject/Pipfile arrays and tables).
    for (const match of text.matchAll(/^[\s-]*([A-Za-z][A-Za-z0-9._-]{1,60})\s*(?:[=<>!~[;]|$)/gm)) {
      const name = match[1];
      if (name !== undefined) python.add(name.toLowerCase());
    }
    for (const match of text.matchAll(/["']([A-Za-z][A-Za-z0-9._-]{1,60})\s*(?:[=<>!~[;\]]|["'])/g)) {
      const name = match[1];
      if (name !== undefined) python.add(name.toLowerCase());
    }
  }

  return { node, python };
}

export interface Detection {
  integration: Integration;
  matched: string[];
}

export function detect(dir: string): Detection[] {
  const deps = collectDependencies(dir);
  const found: Detection[] = [];
  for (const integration of INTEGRATIONS) {
    const pool = integration.ecosystem === 'node' ? deps.node : deps.python;
    const matched = integration.triggers.filter((t) => pool.has(t.toLowerCase()) || pool.has(t));
    if (matched.length > 0) found.push({ integration, matched });
  }
  // The AI SDK re-exports provider packages, so a project using it often also
  // depends on `openai`/`@anthropic-ai/sdk`. Prefer the highest-level match.
  const hasAiSdk = found.some((f) => f.integration.id === 'ai-sdk');
  return hasAiSdk
    ? found.filter((f) => f.integration.ecosystem === 'python' || f.integration.id === 'ai-sdk')
    : found;
}

function pythonInstall(): string {
  return 'pip install graphmind-ai';
}

async function runInstall(command: string, dir: string, io: InitIo): Promise<number> {
  const [bin, ...args] = command.split(' ');
  if (bin === undefined) return 1;
  io.log(`\n$ ${command}`);
  return new Promise<number>((done) => {
    const child = spawn(bin, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', (error) => {
      io.error(`install failed to start: ${error.message}`);
      done(1);
    });
    child.on('exit', (code) => done(code ?? 1));
  });
}

export interface InitIo {
  log(message: string): void;
  error(message: string): void;
}

export async function runInit(parsed: ParsedCli, io: InitIo = console): Promise<number> {
  recordTelemetry('init');

  const dir = resolve(parsed.positionals[0] ?? '.');
  if (!existsSync(dir)) {
    io.error(`graphmind init: no such directory: ${dir}`);
    return 1;
  }

  const found = detect(dir);
  if (found.length === 0) {
    io.log(`No supported agent framework found in ${dir}.`);
    io.log('');
    io.log('GraphMind currently instruments:');
    for (const i of INTEGRATIONS.filter((i) => i.ecosystem === 'node')) {
      io.log(`  ${i.framework.padEnd(22)} ${i.triggers[0]}`);
    }
    io.log(`  ${'Python'.padEnd(22)} openai / anthropic / langgraph / crewai`);
    io.log(`  ${'Ruby'.padEnd(22)} ruby-openai / ruby_llm`);
    io.log('');
    io.log('An MCP server needs no adapter at all — in any language:');
    io.log('  graphmind mcp-proxy -- <the command your MCP client already runs>');
    io.log('');
    io.log('Any other framework can still stream traces in:');
    io.log('  graphmind import trace.json     # OpenTelemetry / OpenInference export');
    io.log('  https://graphmind.ai/docs/reference/schema/   # write an adapter (it is small)');
    return 0;
  }

  const nodeHits = found.filter((f) => f.integration.ecosystem === 'node');
  const pyHits = found.filter((f) => f.integration.ecosystem === 'python');

  io.log(`GraphMind found these in ${dir}:\n`);
  for (const { integration, matched } of found) {
    io.log(`  ${integration.framework}  (${matched.join(', ')})`);
  }

  const pm = detectPackageManager(dir);
  const nodePkgs = [...new Set(nodeHits.map((f) => f.integration.pkg))];
  const commands: string[] = [];
  if (nodePkgs.length > 0) commands.push(installCommand(pm, nodePkgs));
  if (pyHits.length > 0) commands.push(pythonInstall());

  io.log('\n1. Install the adapter:\n');
  for (const command of commands) io.log(`   ${command}`);

  io.log('\n2. Instrument your app:\n');
  const shown = new Set<string>();
  for (const { integration } of found) {
    if (shown.has(integration.pkg + integration.id)) continue;
    shown.add(integration.pkg + integration.id);
    if (found.length > 1) io.log(`   --- ${integration.framework} ---`);
    for (const line of integration.snippet.split('\n')) io.log(`   ${line}`);
    io.log('');
    if (integration.alsoTry !== undefined) {
      for (const line of integration.alsoTry.split('\n')) io.log(`   ${line}`);
      io.log('');
    }
  }

  io.log('3. Start the debugger and run your app:\n');
  io.log('   npx graphmind-ai');
  io.log('');
  io.log(`Docs: ${found[0]?.integration.docs ?? 'https://graphmind.ai/docs/'}`);

  if (parsed.flags.write === true) {
    const target = join(dir, 'graphmind.example.ts');
    const body =
      found
        .map(({ integration }) => `// ${integration.framework} — ${integration.docs}\n${integration.snippet}`)
        .join('\n\n') + '\n';
    try {
      writeFileSync(target, body);
      io.log(`\nWrote ${target}`);
    } catch (error) {
      io.error(`could not write the snippet file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (parsed.flags.install === true && nodePkgs.length > 0) {
    const code = await runInstall(installCommand(pm, nodePkgs), dir, io);
    if (code !== 0) {
      io.error('install failed — run the command above by hand.');
      return code;
    }
    io.log('\nInstalled. Now instrument your app with the snippet above, then run `npx graphmind-ai`.');
  }

  return 0;
}
