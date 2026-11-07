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
    // Cross-tool telemetry opt-out (consoledonottrack.com). Read only by
    // telemetry.ts, only to switch off; documented in packages/cli/TELEMETRY.md.
    'DO_NOT_TRACK',
    'GRAPHMIND_TELEMETRY_URL',
    'GRAPHMIND_DEMO_AGENT_DIR',
    // Added in 0.3.2. Neither carries user data: one scopes the default
    // pause-on-error breakpoint, the other sets how long a dropped app has to
    // reconnect before its run is marked abandoned. Both documented in
    // packages/cli/README.md and the CLI reference page.
    'GRAPHMIND_PAUSE_ON_ERROR',
    'GRAPHMIND_ABANDON_GRACE_MS',
    // 0.5.0 — loop hold (client). Documented in reference/environment.
    'GRAPHMIND_LOOP_THRESHOLD',
    'GRAPHMIND_ON_LOOP',
    'GRAPHMIND_LOOP_ALLOW',
    // 0.5.0 — coarse redaction kill switches (client). Each is a boolean
    // (1/true) that REMOVES data from the recording; none carries user data.
    'GRAPHMIND_HIDE_INPUTS',
    'GRAPHMIND_HIDE_OUTPUTS',
    'GRAPHMIND_HIDE_TOOL_ARGS',
    'GRAPHMIND_HIDE_TOOL_RESULTS',
    // 0.6.0 — edited input kill switch (client). Removes a capability; carries
    // no user data.
    'GRAPHMIND_DISABLE_EDIT_INPUT',
    // 0.6.0 — smart breakpoints (client): each switches a hold (default on;
    // `0`/`false`/`off`/`no` turn one off). No user data.
    'GRAPHMIND_BREAK_ON_ERROR_RESULT',
    'GRAPHMIND_BREAK_ON_TRUNCATED',
    // 0.6.0 — the workflow builder (cli). None carries user data: one names
    // the Anthropic workspace a generated project should send, one forces the
    // registry pins instead of a checkout's tarballs, one names the Python
    // interpreter the runner should use. Documented in reference/environment
    // and in guides/build-a-workflow.
    'ANTHROPIC_WORKSPACE_ID',
    'GRAPHMIND_BUILDER_REGISTRY',
    'GRAPHMIND_PYTHON',
    // 0.6.0 — puts the viewer token back in front of the builder routes, for
    // a shared machine. A boolean switch; carries no user data.
    'GRAPHMIND_BUILDER_REQUIRE_TOKEN',
    // 0.7.0 — hermetic replay (client). GRAPHMIND_REPLAY is a PATH to a tape
    // `graphmind replay` wrote under the OS temp dir (owner-only) for the
    // child it spawns; the other two are closed enums choosing a policy.
    // The path names a file, never its contents, and nothing read here is
    // recorded, sent or logged. Documented in reference/environment.
    'GRAPHMIND_REPLAY',
    'GRAPHMIND_REPLAY_ON_MISS',
    'GRAPHMIND_REPLAY_ON_LOSSY',
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

  it('the CLI copies the whole environment only into a child process it spawns', () => {
    const dist = join(PACKAGES_DIR, 'cli', 'dist');
    const spreaders = jsFiles(dist).filter((file) =>
      /\.\.\.process\.env/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    // Passing the parent environment to a child you spawn is not recording it;
    // anywhere else it would be a red flag. Both of these spawn a command the
    // USER named (the demo agent; the agent being replayed), which would have
    // inherited this environment anyway had they run it from their own shell
    // — withholding it would break their provider keys and proxy settings for
    // no gain.
    expect(spreaders.map((file) => relative(dist, file)).sort()).toEqual([
      join('commands', 'demo.js'),
      join('commands', 'replay.js'),
    ]);
  });
});
