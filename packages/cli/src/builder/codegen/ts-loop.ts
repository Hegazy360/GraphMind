/**
 * `src/loop.ts` and `src/agents.ts` for the two raw-SDK TypeScript targets.
 *
 * Both targets hand-roll a tool-use loop. Once the canvas can put a
 * sub-agent on the graph, that loop is needed twice — once for the root
 * agent and once per sub-agent — so it is generated as one function the
 * project calls, instead of being inlined in main.ts. A sub-agent is then
 * just a tool whose body runs the same loop with a smaller tool list.
 *
 * `selectTools` / `selectSchemas` are how an agent's wiring survives to
 * runtime: tools named exactly, plus every tool from a named MCP server
 * (whose names all start with `server_`, assigned in src/mcp.ts).
 */
import type { SubAgentSpec, WorkflowSpec } from '../spec.js';
import { subAgentWiring } from '../spec.js';
import { mcpPrefix } from './mcp-ts.js';
import { tsLiteral, tsString } from './shared.js';

const TASK_DESCRIPTION = 'What this agent should do, stated in a sentence or two.';

/** The `{ task: string }` schema every sub-agent tool takes. */
export function taskSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { task: { type: 'string', description: TASK_DESCRIPTION } },
    required: ['task'],
    additionalProperties: false,
  };
}

export function anthropicLoopFile(): string {
  return `/**
 * The tool-use loop, as the Anthropic SDK README writes it, capped at
 * maxSteps. The root agent runs it once; each sub-agent runs it again with
 * its own tools (src/agents.ts).
 *
 * Every tool here is already gated by gm.wrapTools, so the debugger can hold
 * a call before it runs whichever loop issued it.
 */
import type Anthropic from '@anthropic-ai/sdk';

export type ToolFns = Record<string, (input: unknown) => Promise<unknown>>;

export interface LoopOptions {
  client: Anthropic;
  model: string;
  system?: string | undefined;
  prompt: string;
  schemas: Anthropic.Tool[];
  tools: ToolFns;
  maxSteps: number;
  /** Each assistant text block, as it is finished. */
  onText?: ((text: string) => void) | undefined;
}

/** Runs to a final answer (or the step cap) and returns the assistant's text. */
export async function runLoop(options: LoopOptions): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: options.prompt }];
  for (let step = 0; step < options.maxSteps; step += 1) {
    const message = await options.client.messages.create({
      model: options.model,
      max_tokens: 1024,
      ...(options.system === undefined || options.system === '' ? {} : { system: options.system }),
      ...(options.schemas.length === 0 ? {} : { tools: options.schemas }),
      messages,
    });
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason !== 'tool_use') {
      let text = '';
      for (const block of message.content) {
        if (block.type !== 'text') continue;
        text += block.text;
        options.onText?.(block.text);
      }
      return text;
    }
    // Parallel calls gate independently: hold one, let the others run.
    const results = await Promise.all(
      message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map(async (block) => {
          const fn = options.tools[block.name];
          const output = fn === undefined ? { error: \`unknown tool \${block.name}\` } : await fn(block.input);
          return { type: 'tool_result' as const, tool_use_id: block.id, content: JSON.stringify(output) };
        }),
    );
    messages.push({ role: 'user', content: results });
  }
  console.error(\`stopped after \${options.maxSteps} steps\`);
  return '';
}

function wanted(name: string, names: readonly string[], prefixes: readonly string[]): boolean {
  return names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/** The tools named exactly, plus every tool from a named MCP server. */
export function selectTools(tools: ToolFns, names: readonly string[], prefixes: readonly string[]): ToolFns {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => wanted(name, names, prefixes)));
}

export function selectSchemas(
  schemas: readonly Anthropic.Tool[],
  names: readonly string[],
  prefixes: readonly string[],
): Anthropic.Tool[] {
  return schemas.filter((schema) => wanted(schema.name, names, prefixes));
}
`;
}

export function openaiLoopFile(): string {
  return `/**
 * The Chat Completions tool-call loop, capped at maxSteps. The root agent
 * runs it once; each sub-agent runs it again with its own tools
 * (src/agents.ts).
 *
 * Each call is passed as the wrapped tool's second argument so the debugger
 * correlates the execution with the model's call.
 */
import type OpenAI from 'openai';

export type ToolFns = Record<string, (input: unknown, call?: unknown) => Promise<unknown>>;

export interface LoopOptions {
  client: OpenAI;
  model: string;
  system?: string | undefined;
  prompt: string;
  schemas: OpenAI.Chat.Completions.ChatCompletionFunctionTool[];
  tools: ToolFns;
  maxSteps: number;
  /** The final assistant message, when there is one. */
  onText?: ((text: string) => void) | undefined;
}

/** Runs to a final answer (or the step cap) and returns the assistant's text. */
export async function runLoop(options: LoopOptions): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...(options.system === undefined || options.system === ''
      ? []
      : [{ role: 'system' as const, content: options.system }]),
    { role: 'user' as const, content: options.prompt },
  ];
  for (let step = 0; step < options.maxSteps; step += 1) {
    const completion = await options.client.chat.completions.create({
      model: options.model,
      messages,
      ...(options.schemas.length === 0 ? {} : { tools: options.schemas }),
    });
    const message = completion.choices[0]?.message;
    if (message === undefined) throw new Error('the model returned no choices');
    const calls = (message.tool_calls ?? []).filter((call) => call.type === 'function');
    if (calls.length === 0) {
      const text = message.content ?? '';
      options.onText?.(text);
      return text;
    }
    messages.push(message);
    // Parallel calls gate independently: hold one, let the others run.
    const results = await Promise.all(
      calls.map(async (call) => {
        const fn = options.tools[call.function.name];
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // the model produced unparseable arguments; the tool sees {}
        }
        const output = fn === undefined ? { error: \`unknown tool \${call.function.name}\` } : await fn(args, call);
        return { role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify(output) };
      }),
    );
    messages.push(...results);
  }
  console.error(\`stopped after \${options.maxSteps} steps\`);
  return '';
}

function wanted(name: string, names: readonly string[], prefixes: readonly string[]): boolean {
  return names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/** The tools named exactly, plus every tool from a named MCP server. */
export function selectTools(tools: ToolFns, names: readonly string[], prefixes: readonly string[]): ToolFns {
  return Object.fromEntries(Object.entries(tools).filter(([name]) => wanted(name, names, prefixes)));
}

export function selectSchemas(
  schemas: readonly OpenAI.Chat.Completions.ChatCompletionFunctionTool[],
  names: readonly string[],
  prefixes: readonly string[],
): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return schemas.filter((schema) => wanted(schema.function.name, names, prefixes));
}
`;
}

function agentBody(spec: WorkflowSpec, agent: SubAgentSpec): string[] {
  const wiring = subAgentWiring(spec, agent);
  const names = tsLiteral(wiring.tools.map((t) => t.name));
  const prefixes = tsLiteral(wiring.mcpServers.map(mcpPrefix));
  const hasSystem = agent.systemPrompt !== undefined && agent.systemPrompt.trim() !== '';
  return [
    `    ${agent.name}: async (input: unknown) => {`,
    '      const task = typeof (input as { task?: unknown })?.task === \'string\'',
    '        ? ((input as { task: string }).task)',
    '        : JSON.stringify(input ?? {});',
    '      const text = await runLoop({',
    '        client: deps.client,',
    `        model: ${tsString(agent.model ?? spec.model)},`,
    ...(hasSystem ? [`        system: ${tsString(agent.systemPrompt ?? '')},`] : []),
    '        prompt: task,',
    `        schemas: selectSchemas(deps.schemas, ${names}, ${prefixes}),`,
    `        tools: selectTools(deps.tools, ${names}, ${prefixes}),`,
    `        maxSteps: ${agent.maxSteps},`,
    '      });',
    '      return { text };',
    '    },',
  ];
}

/** `src/agents.ts` for a raw-SDK target. `flavour` picks the schema shape. */
export function sdkAgentsFile(spec: WorkflowSpec, flavour: 'anthropic' | 'openai'): string {
  const anthropic = flavour === 'anthropic';
  const sdkType = anthropic ? 'Anthropic.Tool' : 'OpenAI.Chat.Completions.ChatCompletionFunctionTool';
  const schemas = spec.subAgents.map((agent) =>
    anthropic
      ? { name: agent.name, description: agent.description, input_schema: taskSchema() }
      : { type: 'function', function: { name: agent.name, description: agent.description, parameters: taskSchema() } },
  );
  const lines: string[] = [
    '/**',
    ` * The agents ${spec.name} can delegate to.`,
    ' *',
    ' * Each one is an ordinary tool as far as the root agent is concerned: it',
    ' * takes a task string, and its body runs the same loop (src/loop.ts) with',
    " * only the tools that sub-agent was given on the canvas. The nested run's",
    ' * steps appear in the debugger underneath the call that started them.',
    ' */',
    anthropic ? "import type Anthropic from '@anthropic-ai/sdk';" : "import type OpenAI from 'openai';",
    "import { runLoop, selectSchemas, selectTools, type ToolFns } from './loop.js';",
    '',
    'export interface SubAgentDeps {',
    `  client: ${anthropic ? 'Anthropic' : 'OpenAI'};`,
    '  /** Every tool schema in the project: local stubs and MCP tools. */',
    `  schemas: ${sdkType}[];`,
    '  /** The matching wrapped callers. */',
    '  tools: ToolFns;',
    '}',
    '',
    '/** What the ROOT agent reads to decide when to delegate. */',
    `export const subAgentSchemas: ${sdkType}[] = ${tsLiteral(schemas)};`,
    '',
    'export function subAgentTools(deps: SubAgentDeps): ToolFns {',
    '  return {',
  ];
  for (const agent of spec.subAgents) lines.push(...agentBody(spec, agent));
  lines.push('  };', '}', '');
  return lines.join('\n');
}
