/**
 * The stacks GraphMind can attach to, and the two lines each one needs.
 *
 * This is the connect page's source of truth and it mirrors the integration
 * table in the root README — if an adapter's install command or its wrapping
 * call changes there, it changes here. Keeping it as data (rather than as
 * copy inside a component) is what lets one screen show exactly one stack's
 * instructions instead of a grid the reader has to filter.
 */

export type StackId =
  | 'ts-ai-sdk'
  | 'ts-anthropic'
  | 'ts-openai'
  | 'ts-langgraph'
  | 'ts-mcp'
  | 'py-openai'
  | 'mcp-proxy';

export interface Stack {
  id: StackId;
  /** The grouping the chooser renders under. */
  language: 'TypeScript' | 'Python' | 'Any language';
  framework: string;
  /** One line: how the reader recognises their own project. */
  blurb: string;
  /** Package manager line. Empty when there is nothing to install. */
  install: string;
  /** The smallest edit that produces a live graph. */
  instrument: string;
  /** Syntax hint for the snippet block. */
  lang: 'ts' | 'python' | 'jsonc';
  docs: string;
  /**
   * What a gate can actually do here. Stated per stack because it genuinely
   * differs, and finding out after instrumenting is the worse order.
   */
  capability: string;
}

export const STACKS: Stack[] = [
  {
    id: 'ts-ai-sdk',
    language: 'TypeScript',
    framework: 'Vercel AI SDK',
    blurb: 'You call streamText / generateText from the ai package.',
    install: 'npm i -D @graphmind-ai/sdk graphmind-ai',
    lang: 'ts',
    instrument: `import { graphmind } from '@graphmind-ai/sdk';

const gm = graphmind({ app: 'support-agent' });

const model = gm.wrapModel(anthropic('claude-sonnet-4-5'));
const tools = gm.wrapTools({ searchFlights, checkBudget });

await gm.run('handle-ticket', () =>
  streamText({ model, tools, prompt }).consumeStream());`,
    docs: 'https://graphmind.ai/docs/integrations/vercel-ai-sdk/',
    capability: 'Full control at a gate: pause, step, retry, edit the arguments, inject a result, abort.',
  },
  {
    id: 'ts-anthropic',
    language: 'TypeScript',
    framework: 'Anthropic SDK',
    blurb: 'You call client.messages.create directly.',
    install: 'npm i -D @graphmind-ai/anthropic graphmind-ai',
    lang: 'ts',
    instrument: `import Anthropic from '@anthropic-ai/sdk';
import { graphmind } from '@graphmind-ai/anthropic';

const gm = graphmind({ app: 'support-agent' });

const client = gm.wrapClient(new Anthropic());
const tools = gm.wrapTools({ searchFlights, checkBudget });

await gm.run('handle-ticket', async () => {
  // your existing message loop, unchanged
});`,
    docs: 'https://graphmind.ai/docs/integrations/anthropic/',
    capability: 'Full control at a gate: pause, step, retry, edit the arguments, inject a result, abort.',
  },
  {
    id: 'ts-openai',
    language: 'TypeScript',
    framework: 'OpenAI SDK',
    blurb: 'You call chat.completions.create or responses.create.',
    install: 'npm i -D @graphmind-ai/openai graphmind-ai',
    lang: 'ts',
    instrument: `import OpenAI from 'openai';
import { graphmind } from '@graphmind-ai/openai';

const gm = graphmind({ app: 'support-agent' });

const client = gm.wrapClient(new OpenAI());
const tools = gm.wrapTools({ searchFlights, checkBudget });

await gm.run('handle-ticket', async () => {
  // your existing message loop, unchanged
});`,
    docs: 'https://graphmind.ai/docs/integrations/openai/',
    capability: 'Full control at a gate: pause, step, retry, edit the arguments, inject a result, abort.',
  },
  {
    id: 'ts-langgraph',
    language: 'TypeScript',
    framework: 'LangGraph / LangChain',
    blurb: 'You build a StateGraph, or run LangChain chains.',
    install: 'npm i -D @graphmind-ai/langgraph graphmind-ai',
    lang: 'ts',
    instrument: `import { graphmind } from '@graphmind-ai/langgraph';

const gm = graphmind({ app: 'research-agent' });

// One handler per invocation — it carries that run's abort signal.
await graph.invoke(input, { callbacks: [gm.handler()] });

// Wrap tools too, to be able to change what one returns:
const tools = gm.wrapTools({ searchFlights, checkBudget });`,
    docs: 'https://graphmind.ai/docs/integrations/langgraph/',
    capability:
      'Callbacks can hold a node and abort it, but cannot substitute its return value — wrap your tools as well for inject and retry.',
  },
  {
    id: 'ts-mcp',
    language: 'TypeScript',
    framework: 'MCP server you own',
    blurb: 'You wrote the server with @modelcontextprotocol.',
    install: 'npm i -D @graphmind-ai/mcp graphmind-ai',
    lang: 'ts',
    instrument: `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { graphmind } from '@graphmind-ai/mcp';

const gm = graphmind({ app: 'my-mcp-server' });

// Register on what wrapServer returns — that is the instrumented view.
const server = gm.wrapServer(new McpServer({ name: 'my-server', version: '1.0.0' }));`,
    docs: 'https://graphmind.ai/docs/integrations/mcp/',
    capability:
      'Holds a tools/call before your handler runs, and sees traffic that never reaches the wire.',
  },
  {
    id: 'py-openai',
    language: 'Python',
    framework: 'OpenAI or Anthropic SDK',
    blurb: 'Sync or async — the transport runs on its own thread.',
    install: 'pip install graphmind-ai',
    lang: 'python',
    instrument: `import graphmind as gm
from openai import OpenAI

client = gm.instrument_openai(OpenAI())

@gm.tool
def search_flights(origin: str, destination: str) -> list[dict]:
    return [{"flight": "TP1234", "price": 218}]

with gm.run("book-trip"):
    client.chat.completions.create(model="gpt-5", messages=messages)`,
    docs: 'https://graphmind.ai/docs/integrations/python/',
    capability: 'Full control at a gate: pause, step, retry, inject a result, abort.',
  },
  {
    id: 'mcp-proxy',
    language: 'Any language',
    framework: 'MCP server, via the proxy',
    blurb: 'Someone else wrote the server, or it is not TypeScript.',
    install: '',
    lang: 'jsonc',
    instrument: `// In .mcp.json, wrap the command your host already runs:
// before: { "command": "node", "args": ["my-server.js"] }
{
  "command": "npx",
  "args": ["-y", "graphmind-ai", "mcp-proxy", "--", "node", "my-server.js"]
}`,
    docs: 'https://graphmind.ai/docs/integrations/mcp-proxy/',
    capability:
      'No change to the server at all. Holds a call before the server sees it, and a response before the host does.',
  },
];

export const DEFAULT_STACK: StackId = 'ts-ai-sdk';

export function stackById(id: StackId): Stack {
  return STACKS.find((s) => s.id === id) ?? (STACKS[0] as Stack);
}

/** The chooser groups by language, in the order the stacks are declared. */
export function stacksByLanguage(): { language: Stack['language']; stacks: Stack[] }[] {
  const groups: { language: Stack['language']; stacks: Stack[] }[] = [];
  for (const stack of STACKS) {
    const group = groups.find((g) => g.language === stack.language);
    if (group === undefined) groups.push({ language: stack.language, stacks: [stack] });
    else group.stacks.push(stack);
  }
  return groups;
}
