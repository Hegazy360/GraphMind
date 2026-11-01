/**
 * The workflow builder's spec validation and code generation. Every target
 * must produce code that at least parses in its language, and everything an
 * engineer typed must come out as a string literal, never as code.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandsFor, generateProject } from '../src/builder/codegen/index.js';
import { pyLiteral, tsLiteral } from '../src/builder/codegen/shared.js';
import {
  PROVIDER_ENV_KEY,
  TARGETS,
  TARGET_IDS,
  defaultSpec,
  isIdentifier,
  parseSpec,
  type Provider,
  type TargetId,
  type WorkflowSpec,
  type WorkflowSpecInput,
} from '../src/builder/spec.js';
import { PROVIDER_META } from '../src/builder/providers.js';

/** Every (target, provider) pair the builder offers. */
const COMBOS: { target: TargetId; provider: Provider }[] = TARGET_IDS.flatMap((target) =>
  TARGETS[target].providers.map((provider) => ({ target, provider })),
);

const HOSTILE_PROMPT = 'Say `hi` ${not code} "quoted" \'single\' back\\slash\nsecond line\ttab   end';

function specFor(target: TargetId, provider: Provider, extra: Partial<WorkflowSpecInput> = {}): WorkflowSpec {
  const parsed = parseSpec({ ...defaultSpec(target), provider, model: 'test-model', ...extra });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.spec;
}

/**
 * Syntax-check TypeScript with Node's own TypeScript parser (it throws on a
 * syntax error), then the stripped JavaScript with `node --check` (which does
 * not execute). The generated code uses only erasable syntax, which is also
 * what makes it runnable by `tsx` unchanged.
 */
function tsSyntaxErrors(source: string, fileName: string): string[] {
  let stripped: string;
  try {
    stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  } catch (error) {
    return [`${fileName}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const file = join(scratch, `${fileName.replace(/[\\/]/g, '_')}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, stripped);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return result.status === 0 ? [] : [`${fileName}: ${result.stderr}`];
}

const python = (() => {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['-I', '-c', 'import ast; print(1)'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '1') return bin;
  }
  return undefined;
})();

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'graphmind-codegen-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Parse a Python file and return the string value bound to `name`, via the real parser. */
function pyConstant(source: string, name: string): string | undefined {
  if (python === undefined) return undefined;
  const file = join(scratch, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, source);
  const script = [
    'import ast, json, sys',
    'tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())',
    'for node in tree.body:',
    '    if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == sys.argv[2] for t in node.targets):',
    '        print(json.dumps(ast.literal_eval(node.value)))',
  ].join('\n');
  const result = spawnSync(python, ['-I', '-c', script, file, name], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim()) as string;
}

describe('spec validation', () => {
  it('accepts the default spec for every target', () => {
    for (const target of TARGET_IDS) {
      const parsed = parseSpec(defaultSpec(target));
      expect(parsed.ok, target).toBe(true);
    }
  });

  it('applies defaults (maxSteps, params, returns, required)', () => {
    const parsed = parseSpec({
      name: 'x',
      target: 'ts-ai-sdk',
      provider: 'openai',
      model: 'gpt-5.1',
      prompt: 'go',
      tools: [{ name: 'a', description: 'A', params: [{ name: 'p', type: 'string' }] }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.maxSteps).toBe(8);
    expect(parsed.spec.tools[0]?.returns).toBe('{ "ok": true }');
    expect(parsed.spec.tools[0]?.params[0]?.required).toBe(true);
  });

  it('rejects a project name that is not a directory-safe slug', () => {
    for (const name of ['My Agent', '-x', 'a/b', 'UPPER', '']) {
      const parsed = parseSpec({ ...defaultSpec(), name });
      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) expect(parsed.issues[0]?.path).toBe('name');
    }
  });

  it('rejects tool and parameter names that are not identifiers in both languages', () => {
    const base = defaultSpec();
    for (const bad of ['search-flights', '1st', 'class', 'def', 'tools', 'a b', 'None']) {
      const parsed = parseSpec({ ...base, tools: [{ name: bad, description: 'x' }] });
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.issues[0]?.path).toBe('tools.0.name');
      expect(isIdentifier(bad)).toBe(false);
    }
    const param = parseSpec({
      ...base,
      tools: [{ name: 'ok', description: 'x', params: [{ name: 'return', type: 'string' }] }],
    });
    expect(param.ok).toBe(false);
    if (!param.ok) expect(param.issues[0]?.path).toBe('tools.0.params.0.name');
  });

  it('rejects duplicate tool names and duplicate parameter names', () => {
    const base = defaultSpec();
    const dupTools = parseSpec({
      ...base,
      tools: [
        { name: 'a', description: 'x' },
        { name: 'a', description: 'y' },
      ],
    });
    expect(dupTools.ok).toBe(false);
    if (!dupTools.ok) expect(dupTools.issues.map((i) => i.path)).toContain('tools.1.name');
    const dupParams = parseSpec({
      ...base,
      tools: [
        {
          name: 'a',
          description: 'x',
          params: [
            { name: 'p', type: 'string' },
            { name: 'p', type: 'number' },
          ],
        },
      ],
    });
    expect(dupParams.ok).toBe(false);
    if (!dupParams.ok) expect(dupParams.issues.map((i) => i.path)).toContain('tools.0.params.1.name');
  });

  it('rejects a provider the target cannot call', () => {
    const parsed = parseSpec({ ...defaultSpec('ts-anthropic'), provider: 'openai' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]?.path).toBe('provider');
      expect(parsed.issues[0]?.message).toContain('Anthropic SDK');
    }
  });

  it('rejects an empty prompt, a bad model id, and out-of-range steps', () => {
    expect(parseSpec({ ...defaultSpec(), prompt: '   ' }).ok).toBe(false);
    expect(parseSpec({ ...defaultSpec(), model: 'gpt 5' }).ok).toBe(false);
    expect(parseSpec({ ...defaultSpec(), maxSteps: 0 }).ok).toBe(false);
    expect(parseSpec({ ...defaultSpec(), maxSteps: 51 }).ok).toBe(false);
    expect(parseSpec({ ...defaultSpec(), maxSteps: 2.5 }).ok).toBe(false);
  });

  it('never throws on garbage', () => {
    for (const garbage of [undefined, null, 42, 'spec', [], { tools: 'x' }]) {
      expect(parseSpec(garbage).ok).toBe(false);
    }
  });
});

describe('generated projects', () => {
  it.each(COMBOS)('$target / $provider: every file is present and parses', ({ target, provider }) => {
    const spec = specFor(target, provider, { prompt: HOSTILE_PROMPT, systemPrompt: HOSTILE_PROMPT });
    const project = generateProject(spec, 'posix');
    const paths = project.files.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('.env.example');
    expect(paths).toContain(TARGETS[target].entry);
    // the spec file is written by createProject, not generated as code
    expect(paths).not.toContain('graphmind.workflow.json');
    // every path is relative and inside the project
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(false);
      expect(path.split('/')).not.toContain('..');
    }
    const gitignore = project.files.find((f) => f.path === '.gitignore')?.content ?? '';
    expect(gitignore.split('\n')).toContain('.env');

    for (const file of project.files) {
      if (file.path.endsWith('.ts')) {
        expect(tsSyntaxErrors(file.content, file.path), `${target}: ${file.path}`).toEqual([]);
      }
      if (file.path.endsWith('.json')) expect(() => JSON.parse(file.content)).not.toThrow();
      if (file.path.endsWith('.py') && python !== undefined) {
        const probe = join(scratch, `${target}-${file.path}`);
        writeFileSync(probe, file.content);
        const result = spawnSync(python, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', probe], {
          encoding: 'utf8',
        });
        expect(result.status, `${target}: ${file.path}\n${result.stderr}`).toBe(0);
      }
    }
  });

  it.each(COMBOS)('$target / $provider: the prompt survives as a literal, not as code', ({ target, provider }) => {
    const spec = specFor(target, provider, { prompt: HOSTILE_PROMPT, systemPrompt: HOSTILE_PROMPT });
    const entry = generateProject(spec, 'posix').files.find((f) => f.path === TARGETS[target].entry)?.content ?? '';
    if (TARGETS[target].language === 'typescript') {
      // Evaluate the constant exactly as the engine would.
      const line = entry.split('\n').find((l) => l.startsWith('const PROMPT = '));
      expect(line).toBeDefined();
      const value = new Function(`${(line ?? '').replace('const PROMPT = ', 'return ')}`)() as string;
      expect(value).toBe(HOSTILE_PROMPT);
      // the template-literal trap: ${...} must not be interpolated
      expect(entry).not.toContain('`' + HOSTILE_PROMPT);
    } else if (python !== undefined) {
      expect(pyConstant(entry, 'PROMPT')).toBe(HOSTILE_PROMPT);
      expect(pyConstant(entry, 'SYSTEM')).toBe(HOSTILE_PROMPT);
    }
  });

  it.each(COMBOS)('$target / $provider: wires the GraphMind adapter, the model, and the key', ({ target, provider }) => {
    const spec = specFor(target, provider);
    const project = generateProject(spec, 'posix');
    const all = project.files.map((f) => f.content).join('\n');
    expect(all).toContain(TARGETS[target].adapter);
    expect(all).toContain('test-model');
    expect(all).toContain(PROVIDER_ENV_KEY[provider]);
    // The app name reaches the adapter: directly in Python, through the APP
    // constant in the TypeScript targets (sub-agents and MCP need it too).
    if (TARGETS[target].language === 'python') {
      expect(all).toContain(`app=${JSON.stringify(spec.name)}`);
    } else {
      expect(all).toContain(`const APP = ${JSON.stringify(spec.name)};`);
      expect(all).toContain('graphmind({ app: APP })');
    }
    expect(project.envKeys[0]?.name).toBe(PROVIDER_ENV_KEY[provider]);
    // required for every hosted provider; a local one (Ollama) runs without a key
    expect(project.envKeys[0]?.required).toBe(PROVIDER_META[provider].keyRequired);
    // the example env has the key NAME with no value (commented out when optional)
    const example = project.files.find((f) => f.path === '.env.example')?.content ?? '';
    expect(example).toMatch(new RegExp(`^${PROVIDER_META[provider].keyRequired ? '' : '# '}${PROVIDER_ENV_KEY[provider]}=$`, 'm'));
  });

  it.each(COMBOS)('$target / $provider: an unscoped Anthropic key can name its workspace', ({ target, provider }) => {
    const spec = specFor(target, provider);
    const project = generateProject(spec, 'posix');
    const entry = project.files.find((f) => f.path === TARGETS[target].entry)?.content ?? '';
    const example = project.files.find((f) => f.path === '.env.example')?.content ?? '';
    const workspaceKey = project.envKeys.find((k) => k.name === 'ANTHROPIC_WORKSPACE_ID');
    if (provider === 'anthropic') {
      // optional, offered by the Build page, sent as the header when set
      expect(workspaceKey?.required).toBe(false);
      expect(entry).toContain('ANTHROPIC_WORKSPACE_ID');
      expect(entry).toContain('anthropic-workspace-id');
      expect(example).toContain('# ANTHROPIC_WORKSPACE_ID=');
    } else {
      expect(workspaceKey).toBeUndefined();
      expect(entry).not.toContain('workspace');
    }
  });

  it('turns a JSON stub into a literal of the language, and non-JSON into a string', () => {
    const tsSpec = specFor('ts-ai-sdk', 'anthropic', {
      tools: [
        { name: 'a', description: 'A', params: [], returns: '{"jacket": true, "n": null, "list": [1, "x"]}' },
        { name: 'b', description: 'B', params: [], returns: 'just text' },
      ],
    });
    const tsTools = generateProject(tsSpec, 'posix').files.find((f) => f.path === 'src/tools.ts')?.content ?? '';
    expect(tsTools).toContain('jacket: true');
    expect(tsTools).toContain('n: null');
    expect(tsTools).toContain('return "just text"');

    const pySpec = specFor('py-openai', 'openai', { tools: tsSpec.tools });
    const pyTools = generateProject(pySpec, 'posix').files.find((f) => f.path === 'tools.py')?.content ?? '';
    expect(pyTools).toContain('"jacket": True');
    expect(pyTools).toContain('"n": None');
    expect(pyTools).toContain('return "just text"');
  });

  it('puts optional parameters after required ones in Python signatures', () => {
    const spec = specFor('py-anthropic', 'anthropic', {
      tools: [
        {
          name: 'f',
          description: 'F',
          params: [
            { name: 'opt', type: 'boolean', required: false },
            { name: 'req', type: 'number', required: true },
          ],
          returns: '{}',
        },
      ],
    });
    const tools = generateProject(spec, 'posix').files.find((f) => f.path === 'tools.py')?.content ?? '';
    expect(tools).toContain('def f(req: float, opt: bool | None = None) -> Any:');
    expect(tools).toContain('"required": [\n                "req",\n            ]');
  });

  it('omits the tools argument entirely when a workflow has no tools', () => {
    for (const { target, provider } of COMBOS) {
      const spec = specFor(target, provider, { tools: [] });
      const entry = generateProject(spec, 'posix').files.find((f) => f.path === TARGETS[target].entry)?.content ?? '';
      if (target !== 'ts-ai-sdk') {
        expect(entry, target).not.toMatch(/tools(=|: )TOOL_SCHEMAS|tools: toolSchemas/);
      }
    }
  });

  it('chooses platform-specific Python commands and shell-free argv everywhere', () => {
    expect(commandsFor('py-openai', 'posix').start.argv).toEqual(['.venv/bin/python', 'main.py']);
    expect(commandsFor('py-openai', 'win32').start.argv[0]).toBe('.venv\\Scripts\\python.exe');
    expect(commandsFor('ts-openai', 'posix').install[0]?.argv).toEqual(['npm', 'install', '--no-fund', '--no-audit']);
    for (const target of TARGET_IDS) {
      for (const command of [...commandsFor(target, 'posix').install, commandsFor(target, 'posix').start]) {
        for (const arg of command.argv) expect(arg).not.toMatch(/[;&|$`]/);
      }
    }
  });
});

/**
 * The node kinds the canvas can place beyond "agent + tools": MCP servers
 * and sub-agents. They exist only for the TypeScript targets, so the Python
 * ones must refuse them rather than silently drop them.
 */
const TS_TARGETS: { target: TargetId; provider: Provider }[] = COMBOS.filter(
  ({ target }) => TARGETS[target].language === 'typescript',
);

const GRAPH_EXTRA = {
  mcpServers: [
    {
      name: 'fs',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      tools: [],
    },
    {
      name: 'docs',
      transport: 'http' as const,
      url: 'https://mcp.example.com/mcp',
      headerEnv: 'DOCS_MCP_TOKEN',
      tools: ['search'],
    },
  ],
  subAgents: [
    {
      name: 'researcher',
      description: 'Looks things up in the docs before the main agent answers.',
      systemPrompt: 'Be exhaustive; cite the file you read.',
      maxSteps: 3,
      tools: ['getWeather'],
      mcpServers: ['docs'],
    },
  ],
  attach: { tools: ['packingAdvice'], mcpServers: ['fs'], subAgents: ['researcher'] },
};

describe('MCP and sub-agent nodes', () => {
  it.each(TS_TARGETS)('$target: generates an MCP client and sub-agent tools that parse', ({ target, provider }) => {
    const spec = specFor(target, provider, GRAPH_EXTRA);
    const project = generateProject(spec, 'posix');
    const paths = project.files.map((f) => f.path);
    expect(paths).toContain('src/mcp.ts');
    expect(paths).toContain('src/agents.ts');
    for (const file of project.files) {
      if (file.path.endsWith('.ts')) expect(tsSyntaxErrors(file.content, file.path), `${target}: ${file.path}`).toEqual([]);
      if (file.path.endsWith('.json')) expect(() => JSON.parse(file.content)).not.toThrow();
    }
    const manifest = JSON.parse(project.files.find((f) => f.path === 'package.json')?.content ?? '{}') as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
  });

  it.each(TS_TARGETS)('$target: wires the root agent to exactly what the canvas attached', ({ target, provider }) => {
    const spec = specFor(target, provider, GRAPH_EXTRA);
    const entry = generateProject(spec, 'posix').files.find((f) => f.path === TARGETS[target].entry)?.content ?? '';
    // Attached: packingAdvice, the fs server (by prefix) and the sub-agent.
    expect(entry).toContain('packingAdvice');
    expect(entry).toContain('researcher');
    expect(entry).toContain('"fs_"');
    // getWeather and the docs server belong to the sub-agent, not the root.
    const agents = generateProject(spec, 'posix').files.find((f) => f.path === 'src/agents.ts')?.content ?? '';
    expect(agents).toContain('getWeather');
    expect(agents).toContain('"docs_"');
  });

  it('asks for the MCP bearer token by name, and never for a value', () => {
    const spec = specFor('ts-ai-sdk', 'anthropic', GRAPH_EXTRA);
    const project = generateProject(spec, 'posix');
    const key = project.envKeys.find((k) => k.name === 'DOCS_MCP_TOKEN');
    expect(key?.required).toBe(false);
    const mcp = project.files.find((f) => f.path === 'src/mcp.ts')?.content ?? '';
    // The token is read from the environment at startup, by NAME.
    expect(mcp).toContain('headerEnv: "DOCS_MCP_TOKEN"');
    expect(mcp).toContain('process.env[server.headerEnv]');
    const example = project.files.find((f) => f.path === '.env.example')?.content ?? '';
    expect(example).toMatch(/^DOCS_MCP_TOKEN=$/m);
  });

  it('leaves an MCP server that nothing is wired to out of the project', () => {
    const spec = specFor('ts-ai-sdk', 'anthropic', {
      ...GRAPH_EXTRA,
      subAgents: [],
      attach: { tools: [], mcpServers: [], subAgents: [] },
    });
    expect(generateProject(spec, 'posix').files.map((f) => f.path)).not.toContain('src/mcp.ts');
  });

  it('refuses MCP and sub-agent nodes on a target that cannot generate them', () => {
    const mcp = parseSpec({ ...defaultSpec('py-openai'), mcpServers: GRAPH_EXTRA.mcpServers });
    expect(mcp.ok).toBe(false);
    if (!mcp.ok) expect(mcp.issues[0]?.path).toBe('mcpServers');
    const subs = parseSpec({ ...defaultSpec('py-anthropic'), subAgents: GRAPH_EXTRA.subAgents });
    expect(subs.ok).toBe(false);
    if (!subs.ok) expect(subs.issues[0]?.path).toBe('subAgents');
  });

  it('refuses an MCP node that cannot be connected to, and names collide once', () => {
    const noCommand = parseSpec({ ...defaultSpec(), mcpServers: [{ name: 'fs', transport: 'stdio' }] });
    expect(noCommand.ok).toBe(false);
    const shellish = parseSpec({
      ...defaultSpec(),
      mcpServers: [{ name: 'fs', transport: 'stdio', command: 'sh -c "curl evil"' }],
    });
    expect(shellish.ok).toBe(false);
    const badUrl = parseSpec({ ...defaultSpec(), mcpServers: [{ name: 'fs', transport: 'http', url: 'ftp://x/y' }] });
    expect(badUrl.ok).toBe(false);
    // one namespace: a sub-agent may not take a tool's name
    const clash = parseSpec({
      ...defaultSpec(),
      subAgents: [{ name: 'getWeather', description: 'clashes with the tool' }],
    });
    expect(clash.ok).toBe(false);
  });

  it('keeps a hostile MCP command and header name from becoming code', () => {
    const spec = specFor('ts-ai-sdk', 'anthropic', {
      mcpServers: [
        { name: 'weird', transport: 'stdio', command: 'npx', args: ['`whoami`', '${PWD}', '"; rm -rf /'], tools: [] },
      ],
      attach: { tools: [], mcpServers: ['weird'], subAgents: [] },
    });
    const mcp = generateProject(spec, 'posix').files.find((f) => f.path === 'src/mcp.ts')?.content ?? '';
    expect(tsSyntaxErrors(mcp, 'src/mcp.ts')).toEqual([]);
    // Each argument is a double-quoted literal, never interpolated.
    expect(mcp).toContain(JSON.stringify('`whoami`'));
    expect(mcp).toContain(JSON.stringify('${PWD}'));
    expect(mcp).not.toContain('`${PWD}`');
  });
});

/**
 * Every provider on every target that can call it. The raw SDK targets reach
 * OpenAI-compatible providers through a base URL; the AI SDK target through a
 * first-party package or the openai-compatible shim; Ollama needs no key.
 */
describe('providers', () => {
  const PROVIDER_COMBOS = COMBOS.filter(({ provider }) => provider !== 'anthropic' && provider !== 'openai');

  it.each(PROVIDER_COMBOS)('$target / $provider: generates code that parses and names the right key', ({ target, provider }) => {
    const spec = specFor(target, provider);
    const project = generateProject(spec, 'posix');
    const meta = PROVIDER_META[provider];
    for (const file of project.files) {
      if (file.path.endsWith('.ts')) expect(tsSyntaxErrors(file.content, file.path), `${target}/${provider}: ${file.path}`).toEqual([]);
      if (file.path.endsWith('.json')) expect(() => JSON.parse(file.content)).not.toThrow();
      if (file.path.endsWith('.py') && python !== undefined) {
        const probe = join(scratch, `${target}-${provider}-${file.path}`);
        writeFileSync(probe, file.content);
        const result = spawnSync(python, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', probe], { encoding: 'utf8' });
        expect(result.status, `${target}/${provider}: ${file.path}\n${result.stderr}`).toBe(0);
      }
    }
    const entry = project.files.find((f) => f.path === TARGETS[target].entry)?.content ?? '';
    expect(entry).toContain(meta.envKey);
    expect(project.envKeys[0]).toMatchObject({ name: meta.envKey, required: meta.keyRequired });
    // A raw OpenAI SDK target points at the provider's endpoint.
    if (TARGETS[target].framework === 'OpenAI SDK') expect(entry).toContain(meta.baseURL ?? '<<none>>');
  });

  it('the AI SDK target imports the first-party package where there is one, the shim otherwise', () => {
    const google = generateProject(specFor('ts-ai-sdk', 'google'), 'posix');
    const googleMain = google.files.find((f) => f.path === 'src/main.ts')?.content ?? '';
    expect(googleMain).toContain("import { createGoogleGenerativeAI } from '@ai-sdk/google';");
    expect(JSON.parse(google.files.find((f) => f.path === 'package.json')?.content ?? '{}').dependencies['@ai-sdk/google']).toBeDefined();

    const ollama = generateProject(specFor('ts-ai-sdk', 'ollama'), 'posix');
    const ollamaMain = ollama.files.find((f) => f.path === 'src/main.ts')?.content ?? '';
    expect(ollamaMain).toContain("from '@ai-sdk/openai-compatible'");
    expect(ollamaMain).toContain('http://127.0.0.1:11434/v1');
    // no key needed: the loader does not exit, and the example line is commented out
    expect(ollamaMain).not.toContain('process.exit(1)');
    expect(ollama.files.find((f) => f.path === '.env.example')?.content).toMatch(/^# OLLAMA_API_KEY=$/m);
  });

  it('the Python OpenAI target reaches a compatible provider through base_url, and skips the key check for Ollama', () => {
    const groq = generateProject(specFor('py-openai', 'groq'), 'posix').files.find((f) => f.path === 'main.py')?.content ?? '';
    expect(groq).toContain('base_url="https://api.groq.com/openai/v1"');
    expect(groq).toContain('sys.exit(1)');
    const ollama = generateProject(specFor('py-openai', 'ollama'), 'posix').files.find((f) => f.path === 'main.py')?.content ?? '';
    expect(ollama).not.toContain('sys.exit(1)');
    expect(ollama).toContain('or "ollama"');
  });

  it('a target refuses a provider outside its family', () => {
    expect(parseSpec({ ...defaultSpec('ts-anthropic'), provider: 'groq' }).ok).toBe(false);
    expect(parseSpec({ ...defaultSpec('py-openai'), provider: 'anthropic' }).ok).toBe(false);
    expect(parseSpec({ ...defaultSpec('ts-ai-sdk'), provider: 'groq' }).ok).toBe(true);
  });
});

describe('the syntax checker itself', () => {
  it('rejects broken TypeScript, so a green run above means something', () => {
    expect(tsSyntaxErrors("import { x } from 'y';\nconst a: number = ;\n", 'broken.ts')).not.toEqual([]);
    expect(tsSyntaxErrors("import { x } from 'y';\nconst a: number = x as number;\nexport type T = { a?: string };\nconsole.log(a);\n", 'ok.ts')).toEqual([]);
  });
});

describe('literal helpers', () => {
  it('pyLiteral maps JSON to Python', () => {
    expect(pyLiteral({ a: [true, false, null, 1.5, 'x'] })).toBe('{\n    "a": [\n        True,\n        False,\n        None,\n        1.5,\n        "x",\n    ],\n}');
    expect(pyLiteral([])).toBe('[]');
    expect(pyLiteral({})).toBe('{}');
  });

  it('tsLiteral quotes keys that are not identifiers', () => {
    expect(tsLiteral({ 'a-b': 1, ok: true })).toBe('{\n  "a-b": 1,\n  ok: true,\n}');
  });
});
