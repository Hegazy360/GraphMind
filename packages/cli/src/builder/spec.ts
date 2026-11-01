/**
 * The workflow builder's input: what an engineer describes in the viewer's
 * Build page, validated once here and then turned into a runnable project
 * (codegen/) in the language and framework they picked.
 *
 * A spec is a small graph of nodes, which is what the Build page draws:
 *
 *   - one root agent (model, system prompt, task prompt, step cap);
 *   - `tools`: local stub tools with typed parameters;
 *   - `mcpServers`: MCP servers the agent connects to as a client, whose
 *     tools join the agent's tool list under a `server_tool` name;
 *   - `subAgents`: nested agents the root agent can delegate to; each one
 *     is exposed to the root as a tool taking a single `task` string.
 *
 * `attach` says which of those the ROOT agent gets; each sub-agent names its
 * own. Anything defined but attached nowhere is still generated (it is code
 * the engineer asked for), just not wired in.
 *
 * Each local tool starts as a stub that returns a fixed value, so the
 * generated project runs end to end on the first try and the engineer
 * replaces the stubs with real code in their editor. GraphMind never owns
 * that code afterwards: the project is plain files in a plain directory,
 * instrumented with the public adapters.
 *
 * Nothing in a spec is a secret. API keys travel separately (routes.ts ->
 * env-file.ts) and are never part of the spec file written next to the code.
 */
import { z } from 'zod';

export const TARGET_IDS = ['ts-ai-sdk', 'ts-anthropic', 'ts-openai', 'py-openai', 'py-anthropic'] as const;
export type TargetId = (typeof TARGET_IDS)[number];

import { DEFAULT_MODEL, PROVIDERS, PROVIDER_ENV_KEY, providersOfFamily, type Provider } from './providers.js';

export { DEFAULT_MODEL, PROVIDERS, PROVIDER_ENV_KEY, type Provider };

export const PARAM_TYPES = ['string', 'number', 'boolean'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export type Language = 'typescript' | 'python';

export interface TargetMeta {
  id: TargetId;
  language: Language;
  /** Shown in the picker: the framework the generated code uses. */
  framework: string;
  /** Which providers the target can call. */
  providers: readonly Provider[];
  /** The GraphMind package the generated code imports. */
  adapter: string;
  /** The file to open first. */
  entry: string;
  docs: string;
  /** Which node kinds this target's generator can emit. */
  supports: { mcp: boolean; subAgents: boolean };
}

export const TARGETS: Record<TargetId, TargetMeta> = {
  'ts-ai-sdk': {
    id: 'ts-ai-sdk',
    language: 'typescript',
    framework: 'Vercel AI SDK',
    providers: PROVIDERS,
    adapter: '@graphmind-ai/sdk',
    entry: 'src/main.ts',
    docs: 'https://graphmind.ai/docs/integrations/vercel-ai-sdk/',
    supports: { mcp: true, subAgents: true },
  },
  'ts-anthropic': {
    id: 'ts-anthropic',
    language: 'typescript',
    framework: 'Anthropic SDK',
    providers: providersOfFamily('anthropic'),
    adapter: '@graphmind-ai/anthropic',
    entry: 'src/main.ts',
    docs: 'https://graphmind.ai/docs/integrations/anthropic/',
    supports: { mcp: true, subAgents: true },
  },
  'ts-openai': {
    id: 'ts-openai',
    language: 'typescript',
    framework: 'OpenAI SDK',
    providers: providersOfFamily('openai'),
    adapter: '@graphmind-ai/openai',
    entry: 'src/main.ts',
    docs: 'https://graphmind.ai/docs/integrations/openai/',
    supports: { mcp: true, subAgents: true },
  },
  'py-openai': {
    id: 'py-openai',
    language: 'python',
    framework: 'OpenAI SDK',
    providers: providersOfFamily('openai'),
    adapter: 'graphmind-ai',
    entry: 'main.py',
    docs: 'https://graphmind.ai/docs/integrations/python/',
    supports: { mcp: false, subAgents: false },
  },
  'py-anthropic': {
    id: 'py-anthropic',
    language: 'python',
    framework: 'Anthropic SDK',
    providers: providersOfFamily('anthropic'),
    adapter: 'graphmind-ai',
    entry: 'main.py',
    docs: 'https://graphmind.ai/docs/integrations/python/',
    supports: { mcp: false, subAgents: false },
  },
};


/**
 * Identifiers must be valid in BOTH languages the builder emits, so one spec
 * can switch target without renaming anything: letters, digits and
 * underscores, not starting with a digit, and not a keyword of either.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  // JavaScript / TypeScript
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null',
  'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'arguments',
  'eval', 'undefined', 'any', 'string', 'number', 'boolean', 'type', 'of',
  // Python
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except',
  'from', 'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  // names the generated files use themselves
  'tools', 'input', 'json', 'os', 'gm', 'client', 'messages', 'model', 'main',
]);

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value) && !RESERVED_WORDS.has(value);
}

const identifier = (what: string) =>
  z
    .string()
    .refine((value) => IDENTIFIER_RE.test(value), {
      message: `${what} must be a plain identifier (letters, digits, underscores; not starting with a digit; at most 48 characters)`,
    })
    .refine((value) => !RESERVED_WORDS.has(value), {
      message: `${what} is a reserved word in TypeScript or Python`,
    });

/** The project name: a directory name and the `app` label on every run. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const ParamSchema = z.object({
  name: identifier('a parameter name'),
  type: z.enum(PARAM_TYPES),
  description: z.string().max(300).optional(),
  required: z.boolean().default(true),
});
export type ToolParam = z.infer<typeof ParamSchema>;

export const ToolSchema = z
  .object({
    name: identifier('a tool name'),
    description: z.string().trim().min(1, 'a tool needs a description: it is what the model reads').max(500),
    params: z.array(ParamSchema).max(12).default([]),
    /**
     * What the stub returns. JSON text becomes a literal of the matching
     * language; anything else becomes a string. The engineer replaces it.
     */
    returns: z.string().max(4000).default('{ "ok": true }'),
  })
  .superRefine((tool, ctx) => {
    const seen = new Set<string>();
    tool.params.forEach((param, index) => {
      if (seen.has(param.name)) {
        ctx.addIssue({ code: 'custom', path: ['params', index, 'name'], message: `duplicate parameter "${param.name}"` });
      }
      seen.add(param.name);
    });
  });
export type ToolSpec = z.infer<typeof ToolSchema>;

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** `ANTHROPIC_API_KEY`-shaped: the NAME of a variable, never a value. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * A stdio command is spawned by the generated project with an argv array and
 * no shell, so a space or a quote in it would be part of the program name
 * rather than a separator. Refusing the characters that make that confusing
 * keeps "what you typed is what runs" true.
 */
const MCP_COMMAND_RE = /^[A-Za-z0-9_@./\\:+-]+$/;

/**
 * An MCP server the agent connects to AS A CLIENT: its tools join the
 * agent's tool list, named `server_tool`.
 *
 * No credential lives here. An HTTP server that needs one names the
 * environment variable to read it from (`headerEnv`), and the generated code
 * sends it as `Authorization: Bearer $THAT`; the value goes in `.env` (or
 * stays in the session-only store) like any other key.
 */
export const McpServerSchema = z
  .object({
    name: identifier('an MCP server name'),
    transport: z.enum(MCP_TRANSPORTS),
    /** stdio: the program to spawn. */
    command: z.string().trim().max(200).default(''),
    args: z.array(z.string().max(500)).max(24).default([]),
    /** http: the endpoint (Streamable HTTP). */
    url: z.string().trim().max(2000).default(''),
    /** http: the variable holding the bearer token, if the server needs one. */
    headerEnv: z
      .string()
      .trim()
      .regex(ENV_NAME_RE, 'an environment variable name is UPPER_CASE letters, digits and underscores')
      .optional(),
    /** Only these tools are exposed to the model. Empty = every tool the server lists. */
    tools: z.array(z.string().trim().max(64)).max(64).default([]),
  })
  .superRefine((server, ctx) => {
    if (server.transport === 'stdio') {
      if (server.command === '') {
        ctx.addIssue({ code: 'custom', path: ['command'], message: 'a stdio MCP server needs a command (e.g. "npx")' });
      } else if (!MCP_COMMAND_RE.test(server.command)) {
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'the command is one program name or path, with no spaces or quotes; put the rest in arguments',
        });
      }
      return;
    }
    let url: URL | undefined;
    try {
      url = new URL(server.url);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'an http MCP server needs an http:// or https:// URL' });
    }
  });
export type McpServerSpec = z.infer<typeof McpServerSchema>;

/**
 * A nested agent. The root agent sees it as one tool taking a `task` string;
 * calling it runs its own model loop with its own tools, which is what makes
 * the delegation visible as a sub-graph in the debugger.
 */
export const SubAgentSchema = z.object({
  name: identifier('a sub-agent name'),
  /** What the ROOT agent reads to decide when to delegate. */
  description: z.string().trim().min(1, 'say when the root agent should delegate to this one').max(500),
  systemPrompt: z.string().max(20_000).optional(),
  /** Defaults to the root agent's model. */
  model: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9._:/-]+$/, 'a model id is letters, digits and . _ : / -')
    .optional(),
  maxSteps: z.number().int().min(1).max(20).default(4),
  /** Names from `tools` / `mcpServers`. */
  tools: z.array(z.string()).max(20).default([]),
  mcpServers: z.array(z.string()).max(6).default([]),
});
export type SubAgentSpec = z.infer<typeof SubAgentSchema>;

/** What the root agent is wired to. Absent = everything defined. */
export const AttachSchema = z.object({
  tools: z.array(z.string()).max(20).default([]),
  mcpServers: z.array(z.string()).max(6).default([]),
  subAgents: z.array(z.string()).max(4).default([]),
});
export type AttachSpec = z.infer<typeof AttachSchema>;

export const WorkflowSpecSchema = z
  .object({
    name: z
      .string()
      .regex(PROJECT_NAME_RE, 'use lowercase letters, digits and dashes (e.g. "support-agent"), at most 48 characters'),
    description: z.string().max(500).optional(),
    target: z.enum(TARGET_IDS),
    provider: z.enum(PROVIDERS),
    model: z
      .string()
      .trim()
      .min(1, 'pick a model')
      .max(100)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'a model id is letters, digits and . _ : / -'),
    systemPrompt: z.string().max(20_000).optional(),
    prompt: z.string().trim().min(1, 'the agent needs a task').max(20_000),
    maxSteps: z.number().int().min(1).max(50).default(8),
    tools: z.array(ToolSchema).max(20).default([]),
    mcpServers: z.array(McpServerSchema).max(6).default([]),
    subAgents: z.array(SubAgentSchema).max(4).default([]),
    attach: AttachSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const target = TARGETS[spec.target];
    if (!target.providers.includes(spec.provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `${target.framework} (${target.language}) cannot call ${spec.provider}; pick one of ${target.providers.join(', ')}`,
      });
    }
    if (spec.mcpServers.length > 0 && !target.supports.mcp) {
      ctx.addIssue({
        code: 'custom',
        path: ['mcpServers'],
        message: `${target.framework} (${target.language}) has no MCP client generator yet; remove the MCP nodes or switch to a TypeScript target`,
      });
    }
    if (spec.subAgents.length > 0 && !target.supports.subAgents) {
      ctx.addIssue({
        code: 'custom',
        path: ['subAgents'],
        message: `${target.framework} (${target.language}) has no sub-agent generator yet; remove the sub-agent nodes or switch to a TypeScript target`,
      });
    }
    // One namespace: every name below becomes an identifier or a tool name
    // the model picks from, so two nodes may not share one.
    const seen = new Set<string>();
    const unique = (name: string, path: (string | number)[], what: string) => {
      if (seen.has(name)) ctx.addIssue({ code: 'custom', path, message: `duplicate ${what} "${name}"` });
      seen.add(name);
    };
    spec.tools.forEach((tool, index) => unique(tool.name, ['tools', index, 'name'], 'tool'));
    spec.mcpServers.forEach((server, index) => unique(server.name, ['mcpServers', index, 'name'], 'MCP server'));
    spec.subAgents.forEach((agent, index) => unique(agent.name, ['subAgents', index, 'name'], 'sub-agent'));

    // Wiring (`attach`, and each sub-agent's lists) is NOT checked against
    // the definitions: a name with nothing behind it wires nothing, which is
    // what deleting a node from the canvas leaves behind for a moment. An
    // edit that removes a tool must not make the whole spec unsendable.
  });

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;
/** What a caller sends: defaults not yet applied. */
export type WorkflowSpecInput = z.input<typeof WorkflowSpecSchema>;

/**
 * What one agent (the root, or a sub-agent) is wired to, resolved from names
 * to definitions. The generators work from this and never re-resolve names.
 */
export interface AgentWiring {
  tools: ToolSpec[];
  mcpServers: McpServerSpec[];
  subAgents: SubAgentSpec[];
}

function pick<T extends { name: string }>(all: readonly T[], names: readonly string[]): T[] {
  // Definition order, not click order: the generated file reads the same way
  // the canvas does.
  return all.filter((item) => names.includes(item.name));
}

/** What the root agent is wired to. No `attach` means "everything defined". */
export function rootWiring(spec: WorkflowSpec): AgentWiring {
  if (spec.attach === undefined) {
    return { tools: [...spec.tools], mcpServers: [...spec.mcpServers], subAgents: [...spec.subAgents] };
  }
  return {
    tools: pick(spec.tools, spec.attach.tools),
    mcpServers: pick(spec.mcpServers, spec.attach.mcpServers),
    subAgents: pick(spec.subAgents, spec.attach.subAgents),
  };
}

/** What one sub-agent is wired to. A sub-agent cannot own another sub-agent. */
export function subAgentWiring(spec: WorkflowSpec, agent: SubAgentSpec): AgentWiring {
  return { tools: pick(spec.tools, agent.tools), mcpServers: pick(spec.mcpServers, agent.mcpServers), subAgents: [] };
}

/** Every MCP server actually wired to something: the ones worth connecting. */
export function usedMcpServers(spec: WorkflowSpec): McpServerSpec[] {
  const names = new Set<string>(rootWiring(spec).mcpServers.map((s) => s.name));
  for (const agent of spec.subAgents) for (const name of agent.mcpServers) names.add(name);
  return spec.mcpServers.filter((server) => names.has(server.name));
}

export interface SpecIssue {
  /** Dotted path into the spec (`tools.1.name`); empty for the whole spec. */
  path: string;
  message: string;
}

export type ParseSpecResult = { ok: true; spec: WorkflowSpec } | { ok: false; issues: SpecIssue[] };

/** Validate an untrusted spec. Never throws. */
export function parseSpec(input: unknown): ParseSpecResult {
  const result = WorkflowSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/**
 * The spec the Build page opens with: a small, runnable agent with two stub
 * tools, so "Create" and "Run" work before anything is typed.
 */
export function defaultSpec(target: TargetId = 'ts-ai-sdk'): WorkflowSpec {
  const meta = TARGETS[target];
  const provider = meta.providers[0] as Provider;
  return {
    name: 'my-agent',
    description: 'A starter agent with two stub tools. Replace the stubs with real code.',
    target,
    provider,
    model: DEFAULT_MODEL[provider],
    systemPrompt: 'You are a concise assistant. Use the tools when they help, then answer in two sentences.',
    prompt: 'What is the weather like in Lisbon this weekend, and should I pack a jacket?',
    maxSteps: 6,
    tools: [
      {
        name: 'getWeather',
        description: 'Typical weather for a city on a given day.',
        params: [
          { name: 'city', type: 'string', description: 'City name', required: true },
          { name: 'day', type: 'string', description: 'ISO date or a word like "saturday"', required: true },
        ],
        returns: '{ "highC": 19, "lowC": 12, "summary": "sunny, breezy in the evening" }',
      },
      {
        name: 'packingAdvice',
        description: 'Whether to pack a jacket for a temperature range.',
        params: [
          { name: 'lowC', type: 'number', description: 'Lowest expected temperature', required: true },
        ],
        returns: '{ "jacket": true, "reason": "evenings drop below 15C" }',
      },
    ],
    mcpServers: [],
    subAgents: [],
  };
}
