/**
 * A structural guard on the SHIPPED build output.
 *
 * The canary tests prove today's behaviour. This one protects the property
 * that makes that behaviour easy to keep: the adapters simply never touch a
 * credential. They field-pick `model`, `messages`/`prompt`, `system`, tool
 * names, tool arguments and results — and they do not so much as name
 * `apiKey`, `defaultHeaders`, `Authorization` or `baseURL`, nor read a single
 * environment variable.
 *
 * If a future change adds `input: params` (wholesale) or starts reading
 * `client.apiKey` for a nicer viewer label, this file goes red before anyone
 * has to notice a leaked key in a shared HTML export.
 *
 * Scanned files are the compiled `dist/` JavaScript — what npm actually
 * publishes — not the source.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from 'graphmind-ai';

/**
 * `<repo>/packages` — derived from the installed `graphmind-ai` package root
 * (`.../packages/cli`), so this keeps working from any working directory.
 */
const PACKAGES_DIR = join(packageRoot, '..');

const ADAPTERS = ['ai-sdk', 'anthropic', 'openai', 'langgraph'] as const;

function jsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) jsFiles(path, out);
    else if (path.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Comments explain what is NOT done; only executable text is evidence. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function scanPackage(pkg: string, pattern: RegExp): string[] {
  const dist = join(PACKAGES_DIR, pkg, 'dist');
  return jsFiles(dist)
    .filter((file) => pattern.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => `${pkg}/${relative(dist, file)}`);
}

describe('published adapter builds', () => {
  it('the packages under audit are actually built', () => {
    for (const pkg of ADAPTERS) {
      expect(jsFiles(join(PACKAGES_DIR, pkg, 'dist')).length).toBeGreaterThan(3);
    }
  });

  it.each(ADAPTERS)('%s never reads process.env', (pkg) => {
    expect(scanPackage(pkg, /process\.env/)).toEqual([]);
  });

  it.each(ADAPTERS)('%s never names a provider credential field', (pkg) => {
    expect(scanPackage(pkg, /apiKey|api_key/i)).toEqual([]);
    expect(scanPackage(pkg, /defaultHeaders|defaultQuery/i)).toEqual([]);
    expect(scanPackage(pkg, /authorization/i)).toEqual([]);
    expect(scanPackage(pkg, /baseURL|base_url/i)).toEqual([]);
  });

  it.each(ADAPTERS)('%s reads no HTTP headers except the OpenAI request id', (pkg) => {
    const hits = scanPackage(pkg, /\.headers\b/);
    // The single permitted read: `response.headers.get('x-request-id')`, which
    // the OpenAI SDK's own APIPromise exposes and GraphMind carries across a
    // transform. It is a correlation id, not a credential.
    const allowed = new Set(['openai/api-promise.js']);
    expect(hits.filter((hit) => !allowed.has(hit))).toEqual([]);
  });
});

describe('the client and the CLI read only documented environment variables', () => {
  const ALLOWED_ENV = [
    // client: kill switches + endpoint
    'GRAPHMIND_DISABLED',
    'GRAPHMIND',
    'GRAPHMIND_URL',
    'NODE_ENV',
    // cli: paths, retention, telemetry, demo
    'GRAPHMIND_DB',
    'GRAPHMIND_HOME',
    'GRAPHMIND_VIEWER_DIST',
    'GRAPHMIND_ALLOWED_ORIGINS',
    'GRAPHMIND_RETENTION',
    'GRAPHMIND_KEEP_RUNS',
    'GRAPHMIND_KEEP_DAYS',
    'GRAPHMIND_TELEMETRY',
    'GRAPHMIND_TELEMETRY_URL',
    'GRAPHMIND_DEMO_AGENT_DIR',
    // Added in 0.3.2. Neither carries user data: one scopes the default
    // pause-on-error breakpoint, the other sets how long a dropped app has to
    // reconnect before its run is marked abandoned. Both documented in
    // packages/cli/README.md and the CLI reference page.
    'GRAPHMIND_PAUSE_ON_ERROR',
    'GRAPHMIND_ABANDON_GRACE_MS',
    'CI',
  ];

  it.each(['client', 'cli'])('%s names no undocumented environment variable', (pkg) => {
    const dist = join(PACKAGES_DIR, pkg, 'dist');
    const named = new Set<string>();
    for (const file of jsFiles(dist)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/env(?:Like)?\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
        if (match[1] !== undefined) named.add(match[1]);
      }
      for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        if (match[1] !== undefined) named.add(match[1]);
      }
    }
    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter((name) => !ALLOWED_ENV.includes(name))).toEqual([]);
  });

  it('the CLI copies the whole environment only into the demo child process', () => {
    const dist = join(PACKAGES_DIR, 'cli', 'dist');
    const spreaders = jsFiles(dist).filter((file) =>
      /\.\.\.process\.env/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    // Passing the parent environment to a child you spawn is not recording it;
    // anywhere else it would be a red flag.
    expect(spreaders.map((file) => relative(dist, file))).toEqual([
      join('commands', 'demo.js'),
    ]);
  });
});
