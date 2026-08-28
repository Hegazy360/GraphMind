import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.js';
import {
  collectDependencies,
  detect,
  detectPackageManager,
  installCommand,
  runInit,
} from '../src/commands/init.js';

let dir: string;
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-init-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writePkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps, ...extra }));

describe('dependency collection', () => {
  it('reads every node dependency field', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { openai: '^4' },
        devDependencies: { vitest: '^3' },
        peerDependencies: { ai: '^7' },
      }),
    );
    const deps = collectDependencies(dir);
    expect([...deps.node].sort()).toEqual(['ai', 'openai', 'vitest']);
  });

  it('reads python manifests loosely', () => {
    writeFileSync(join(dir, 'requirements.txt'), 'openai==1.2.3\nlanggraph>=0.2\n# comment\n');
    const deps = collectDependencies(dir);
    expect(deps.python.has('openai')).toBe(true);
    expect(deps.python.has('langgraph')).toBe(true);
  });

  it('survives a malformed package.json', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(collectDependencies(dir).node.size).toBe(0);
  });
});

describe('detection', () => {
  it('maps each framework to its adapter', () => {
    writePkg({ '@anthropic-ai/sdk': '^0.3' });
    expect(detect(dir).map((d) => d.integration.pkg)).toEqual(['@graphmind-ai/anthropic']);
  });

  it('prefers the AI SDK over the provider packages it wraps', () => {
    writePkg({ ai: '^7', openai: '^4', '@anthropic-ai/sdk': '^0.3' });
    expect(detect(dir).map((d) => d.integration.id)).toEqual(['ai-sdk']);
  });

  it('detects langgraph and openai together', () => {
    writePkg({ '@langchain/langgraph': '^0.2', openai: '^4' });
    expect(detect(dir).map((d) => d.integration.id).sort()).toEqual(['langgraph', 'openai']);
  });

  it('detects python alongside node', () => {
    writePkg({ ai: '^7' });
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["anthropic>=0.40"]\n');
    expect(detect(dir).map((d) => d.integration.id).sort()).toEqual(['ai-sdk', 'py-anthropic']);
  });

  it('finds nothing in an empty project', () => {
    expect(detect(dir)).toEqual([]);
  });

  /**
   * The flagship audience of the MCP work: someone whose project IS an MCP
   * server. They used to be told "no supported agent framework found", which
   * is the worst possible answer for the one user the release was built for.
   */
  it('detects an MCP server, and offers the no-code route as well', () => {
    writePkg({ '@modelcontextprotocol/sdk': '^1.30' });
    const hits = detect(dir);
    expect(hits.map((d) => d.integration.id)).toEqual(['mcp']);
    expect(hits[0]?.integration.pkg).toBe('@graphmind-ai/mcp');
    // The proxy needs nothing installed and works on any language, so it has
    // to be offered next to the adapter rather than buried in the docs.
    expect(hits[0]?.integration.alsoTry).toContain('mcp-proxy');
  });

  it('detects an MCP server that also uses a provider SDK', () => {
    writePkg({ '@modelcontextprotocol/sdk': '^1.30', '@anthropic-ai/sdk': '^0.3' });
    expect(detect(dir).map((d) => d.integration.id).sort()).toEqual(['anthropic', 'mcp']);
  });
});

describe('package manager', () => {
  it('prefers the lockfile', () => {
    writePkg({});
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  it('falls back to the packageManager field, then npm', () => {
    writePkg({}, { packageManager: 'yarn@4.1.0' });
    expect(detectPackageManager(dir)).toBe('yarn');
    writePkg({});
    expect(detectPackageManager(dir)).toBe('npm');
  });

  it('formats install commands per manager', () => {
    expect(installCommand('pnpm', ['a', 'b'])).toBe('pnpm add a b');
    expect(installCommand('npm', ['a'])).toBe('npm install a');
    expect(installCommand('bun', ['a'])).toBe('bun add a');
  });
});

describe('runInit', () => {
  const parse = (argv: string[]) => parseCliArgs(argv).command === 'init'
    ? parseCliArgs(argv)
    : parseCliArgs(['init', ...argv]);

  it('prints install + snippet + next step for a detected framework', async () => {
    writePkg({ ai: '^7' });
    const { out, io: sink } = io();
    const code = await runInit(parse(['init', dir]), sink);
    const text = out.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('Vercel AI SDK');
    expect(text).toContain('npm install @graphmind-ai/sdk');
    expect(text).toContain("import { graphmind } from '@graphmind-ai/sdk'");
    expect(text).toContain('npx graphmind-ai');
  });

  it('shows the python install line for python projects', async () => {
    writeFileSync(join(dir, 'requirements.txt'), 'langgraph==0.2.0\n');
    const { out, io: sink } = io();
    await runInit(parse(['init', dir]), sink);
    expect(out.join('\n')).toContain('pip install graphmind-ai');
  });

  it('guides the user when nothing matches, without failing', async () => {
    writePkg({ express: '^4' });
    const { out, io: sink } = io();
    const code = await runInit(parse(['init', dir]), sink);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('No supported agent framework found');
    expect(text).toContain('graphmind import');
  });

  it('errors on a missing directory', async () => {
    const { err, io: sink } = io();
    const code = await runInit(parse(['init', join(dir, 'nope')]), sink);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no such directory');
  });

  it('--write emits a snippet file', async () => {
    writePkg({ openai: '^4' });
    const { io: sink } = io();
    await runInit(parse(['init', dir, '--write']), sink);
    const written = await import('node:fs').then((fs) =>
      fs.readFileSync(join(dir, 'graphmind.example.ts'), 'utf8'),
    );
    expect(written).toContain('@graphmind-ai/openai');
  });
});
