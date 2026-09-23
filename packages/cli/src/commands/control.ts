/**
 * `graphmind pauses`, `graphmind wait`, `graphmind resume` — drive a paused
 * agent from a terminal or a coding agent (Phase 7, contract C3).
 *
 *   graphmind pauses [--run <id>] [--json]
 *   graphmind wait   [--run <id>] [--timeout <s>] [--json]
 *   graphmind resume <pauseId> --run <id> --action continue|retry|inject|abort
 *                    [--output <json|@file>] [--input <json|@file>]
 *                    [--operator <label>] [--timeout <s>] [--json]
 *
 * All three talk HTTP to the `graphmind serve` on `--port` (default 4747).
 * Listing and waiting are reads (no credential, same as `/api/runs`).
 * `resume` presents the agent token from `$GRAPHMIND_HOME/run/serve-<port>.json`,
 * which the server writes at start (0600) — and the SERVER decides what that
 * token may do (`serve --allow-control=off|resume|inject|edit`, default off),
 * so an allow-listed shell command cannot do more than the human allowed.
 *
 * Exit codes (documented in `graphmind --help` and reference/cli):
 *   0 ok · 1 usage/unexpected · 2 timeout · 3 server unreachable ·
 *   4 nothing to act on (no such pause; `wait --run`: the run ended) ·
 *   5 not authorized (no/stale token, level too low, edit refused by the hub) ·
 *   6 refused (the app would not run the edit, or a placeholder/truncated value) ·
 *   7 taken (another resume won the pause)
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedCli } from '../args.js';
import { DEFAULT_PORT, type EnvLike } from '../paths.js';
import { readRunFile } from '../run-files.js';
import { recordTelemetry } from '../telemetry.js';

export const EXIT = {
  ok: 0,
  usage: 1,
  timeout: 2,
  unreachable: 3,
  gone: 4,
  unauthorized: 5,
  refused: 6,
  taken: 7,
} as const;

export const EXIT_CODE_HELP: readonly string[] = [
  '  0  ok (resumed; a pause was found; listed)',
  '  1  usage error, or something unexpected',
  '  2  timeout (wait: no pause in time; resume: no answer from the app yet)',
  '  3  no GraphMind server on that port',
  '  4  nothing to act on (no such pause; wait --run: the run ended)',
  '  5  not authorized (no or stale token file, --allow-control too low, edit refused)',
  '  6  refused (the app would not run the edit; placeholder or truncated value)',
  '  7  taken (another resume — the viewer, another agent — won the pause)',
];

/** Default `wait --timeout`: returns before a coding agent's 2-minute tool timeout. */
export const DEFAULT_WAIT_SECONDS = 90;
/** Values up to this many JSON characters are printed inline; larger ones go to a file. */
export const INLINE_LIMIT = 2_000;

export interface ControlIo {
  log(message: string): void;
  error(message: string): void;
  env: EnvLike;
}

const defaultIo = (): ControlIo => ({
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  env: process.env as EnvLike,
});

interface Pause {
  runId: string;
  pauseId: string;
  nodeId: string;
  point: string;
  reason?: string;
  smart?: { rule?: string; detail?: string };
  loop?: { repeats?: number; kind?: string };
  editable?: boolean;
  since: number;
  state: 'open' | 'resolving';
  app?: string;
}

class Unreachable extends Error {}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function request(
  port: number,
  path: string,
  init: RequestInit & { timeoutMs: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl(port)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    if (cause === 'ECONNREFUSED' || cause === 'ECONNRESET' || cause === 'EHOSTUNREACH') {
      throw new Unreachable(`no GraphMind server on port ${port} (start it with \`graphmind serve\`)`);
    }
    if ((error as Error).name === 'TimeoutError') {
      throw new Unreachable(`the GraphMind server on port ${port} did not answer in time`);
    }
    throw new Unreachable(
      `could not reach GraphMind on port ${port} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON: leave the body empty; the status still speaks
  }
  return { status: response.status, body };
}

function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function pointLabel(point: string): string {
  return point === 'before' ? 'before the call' : point === 'after' ? 'after the call' : 'on error';
}

function reasonLabel(pause: Pause): string {
  if (pause.smart?.rule !== undefined) return `smart hold: ${pause.smart.rule}`;
  if (pause.reason === 'loop') {
    const kind = pause.loop?.kind ?? 'repeat';
    return `loop (${kind}${pause.loop?.repeats === undefined ? '' : `, ${pause.loop.repeats} calls`})`;
  }
  return pause.reason ?? 'breakpoint';
}

function asPauses(value: unknown): Pause[] {
  return Array.isArray(value) ? (value as Pause[]) : [];
}

// -- pauses -------------------------------------------------------------------

export async function runPauses(parsed: ParsedCli, io: ControlIo = defaultIo()): Promise<number> {
  recordTelemetry('pauses');
  if (parsed.positionals.length > 0) {
    io.error(`graphmind pauses: unexpected argument "${parsed.positionals[0]}"`);
    return EXIT.usage;
  }
  const port = parsed.flags.port ?? DEFAULT_PORT;
  const query = parsed.flags.run === undefined ? '' : `?runId=${encodeURIComponent(parsed.flags.run)}`;
  let result;
  try {
    result = await request(port, `/api/pauses${query}`, { timeoutMs: 5_000 });
  } catch (error) {
    io.error(`graphmind pauses: ${(error as Error).message}`);
    return EXIT.unreachable;
  }
  if (result.status !== 200) {
    io.error(`graphmind pauses: the server answered ${result.status}`);
    return EXIT.usage;
  }
  const pauses = asPauses(result.body['pauses']);
  if (parsed.flags.json) {
    io.log(JSON.stringify({ pauses }));
    return EXIT.ok;
  }
  if (pauses.length === 0) {
    io.log(`No open pauses on ${baseUrl(port)}${parsed.flags.run === undefined ? '' : ` in run ${parsed.flags.run}`}.`);
    io.log('Block until one appears:  graphmind wait');
    return EXIT.ok;
  }
  io.log(`${pauses.length} held pause(s) on ${baseUrl(port)}\n`);
  io.log(
    `  ${'RUN'.padEnd(24)} ${'PAUSE'.padEnd(10)} ${'NODE'.padEnd(26)} ${'POINT'.padEnd(7)} ` +
      `${'REASON'.padEnd(22)} ${'STATE'.padEnd(10)} SINCE`,
  );
  const now = Date.now();
  for (const pause of pauses) {
    io.log(
      `  ${pause.runId.slice(0, 24).padEnd(24)} ${pause.pauseId.slice(0, 10).padEnd(10)} ` +
        `${pause.nodeId.slice(0, 26).padEnd(26)} ${pause.point.padEnd(7)} ` +
        `${reasonLabel(pause).slice(0, 22).padEnd(22)} ${pause.state.padEnd(10)} ${ago(pause.since, now)}` +
        (pause.editable === true ? '  (editable)' : ''),
    );
  }
  const first = pauses[0] as Pause;
  io.log(`\nInspect one:  graphmind wait --run ${first.runId}`);
  io.log(`Release it:   graphmind resume ${first.pauseId} --run ${first.runId} --action continue`);
  return EXIT.ok;
}

// -- wait ---------------------------------------------------------------------

interface Rendered {
  inline?: unknown;
  file?: string;
  bytes?: number;
}

/** Small values inline; big ones to a private temp file (the Playwright CLI pattern). */
function renderValue(value: unknown, name: string, dir: () => string): Rendered {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    json = JSON.stringify(String(value));
  }
  if (json.length <= INLINE_LIMIT) return { inline: value };
  const file = join(dir(), `${name}.json`);
  writeFileSync(file, `${json}\n`, { mode: 0o600 });
  return { file, bytes: Buffer.byteLength(json) };
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export async function runWait(parsed: ParsedCli, io: ControlIo = defaultIo()): Promise<number> {
  recordTelemetry('wait');
  if (parsed.positionals.length > 0) {
    io.error(`graphmind wait: unexpected argument "${parsed.positionals[0]}"`);
    return EXIT.usage;
  }
  const port = parsed.flags.port ?? DEFAULT_PORT;
  const runId = parsed.flags.run;
  const timeoutS = parsed.flags.timeout ?? DEFAULT_WAIT_SECONDS;
  const deadline = timeoutS === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;

  let found: Pause | undefined;
  let runEnded: { status: string } | undefined;
  for (;;) {
    const remaining = deadline - Date.now();
    const chunk = Math.max(0, Math.min(30, Math.ceil(remaining / 1000)));
    const params = new URLSearchParams();
    if (runId !== undefined) params.set('runId', runId);
    params.set('wait', String(chunk));
    let result;
    try {
      result = await request(port, `/api/pauses?${params.toString()}`, { timeoutMs: chunk * 1000 + 10_000 });
    } catch (error) {
      io.error(`graphmind wait: ${(error as Error).message}`);
      return EXIT.unreachable;
    }
    if (result.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (result.status !== 200) {
      io.error(`graphmind wait: the server answered ${result.status}`);
      return EXIT.usage;
    }
    found = asPauses(result.body['pauses']).find((pause) => pause.state === 'open');
    if (found !== undefined) break;
    const run = result.body['run'] as { status?: string } | null | undefined;
    if (runId !== undefined && run !== null && run !== undefined && run.status !== 'running') {
      runEnded = { status: String(run.status) };
      break;
    }
    if (Date.now() >= deadline) break;
  }

  if (found === undefined) {
    if (runEnded !== undefined) {
      if (parsed.flags.json) io.log(JSON.stringify({ pause: null, run: { id: runId, status: runEnded.status } }));
      else io.log(`Run ${runId} ended (${runEnded.status}) without pausing.`);
      return EXIT.gone;
    }
    if (parsed.flags.json) io.log(JSON.stringify({ pause: null, timedOut: true }));
    else io.log(`No pause within ${timeoutS}s${runId === undefined ? '' : ` in run ${runId}`}. Run it again to keep waiting.`);
    return EXIT.timeout;
  }

  // The held node's recorded input (and error, if any), for a decision.
  let detail: Record<string, unknown> = {};
  try {
    const result = await request(
      port,
      `/api/runs/${encodeURIComponent(found.runId)}/pauses/${encodeURIComponent(found.pauseId)}`,
      { timeoutMs: 10_000 },
    );
    if (result.status === 200 && typeof result.body['pause'] === 'object' && result.body['pause'] !== null) {
      detail = result.body['pause'] as Record<string, unknown>;
    }
  } catch {
    // the summary below still names the pause; the detail is a convenience
  }
  const node = (detail['node'] ?? {}) as {
    kind?: string;
    name?: string;
    instanceId?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
  let tempDir: string | undefined;
  const dir = (): string => {
    tempDir ??= mkdtempSync(join(tmpdir(), 'graphmind-pause-'));
    return tempDir;
  };
  const values: [string, unknown][] = [];
  if (Object.hasOwn(node, 'input')) values.push(['input', node.input]);
  if (Object.hasOwn(node, 'output')) values.push(['output', node.output]);
  if (Object.hasOwn(node, 'error')) values.push(['error', node.error]);
  const rendered = values.map(([name, value]) => [name, renderValue(value, name, dir)] as const);

  const commands = nextCommands(found);
  if (parsed.flags.json) {
    const out: Record<string, unknown> = {
      pause: {
        ...found,
        node: {
          ...(node.kind === undefined ? {} : { kind: node.kind }),
          ...(node.name === undefined ? {} : { name: node.name }),
          ...(node.instanceId === undefined ? {} : { instanceId: node.instanceId }),
        },
      },
      next: commands,
    };
    for (const [name, value] of rendered) {
      if (value.file !== undefined) {
        out[`${name}File`] = value.file;
        out[`${name}Bytes`] = value.bytes;
      } else {
        out[name] = value.inline;
      }
    }
    io.log(JSON.stringify(out));
    return EXIT.ok;
  }

  io.log(`Paused: run ${found.runId} · pause ${found.pauseId}${found.app === undefined ? '' : ` · app ${found.app}`}`);
  const named = node.name === undefined ? found.nodeId : `${found.nodeId} (${node.kind ?? 'node'} "${node.name}")`;
  io.log(`  node      ${named}, ${pointLabel(found.point)}`);
  io.log(`  reason    ${reasonLabel(found)}${found.smart?.detail === undefined ? '' : ` — ${found.smart.detail}`}`);
  io.log(
    `  editable  ${found.editable === true ? 'yes (--input runs the REAL call with the arguments you give)' : 'no'}`,
  );
  for (const [name, value] of rendered) {
    if (value.file !== undefined) {
      io.log(`  ${name.padEnd(9)} ${kb(value.bytes ?? 0)} → ${value.file}`);
    } else {
      io.log(`  ${name.padEnd(9)} ${JSON.stringify(value.inline)}`);
    }
  }
  io.log('Next:');
  for (const command of commands) io.log(`  ${command}`);
  return EXIT.ok;
}

function nextCommands(pause: Pause): string[] {
  const base = `graphmind resume ${pause.pauseId} --run ${pause.runId}`;
  const out = [`${base} --action continue`];
  if (pause.editable === true) {
    out.push(
      pause.point === 'before'
        ? `${base} --action continue --input @edited-input.json`
        : `${base} --action retry --input @edited-input.json`,
    );
  }
  if (pause.point !== 'before') out.push(`${base} --action retry`);
  out.push(`${base} --action inject --output '<json result>'`);
  out.push(`${base} --action abort`);
  return out;
}

// -- resume -------------------------------------------------------------------

const ACTIONS = ['continue', 'retry', 'inject', 'abort'] as const;

/** `--output`/`--input` value: `@path` reads a file; anything else must be JSON. */
function readJsonArg(flag: string, raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (error) {
      return { ok: false, message: `${flag}: cannot read ${raw.slice(1)} (${(error as Error).message})` };
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      message:
        `${flag} must be JSON or @file (a plain string needs JSON quotes: ${flag} '"text"'; ` +
        `a value starting with "-" needs ${flag}=<value>)`,
    };
  }
}

export async function runResume(parsed: ParsedCli, io: ControlIo = defaultIo()): Promise<number> {
  recordTelemetry('resume');
  const usage = 'usage: graphmind resume <pauseId> --run <id> --action continue|retry|inject|abort';
  const pauseId = parsed.positionals[0];
  if (pauseId === undefined || pauseId === '' || parsed.positionals.length > 1) {
    io.error(parsed.positionals.length > 1 ? `graphmind resume: unexpected argument "${parsed.positionals[1]}"` : usage);
    return EXIT.usage;
  }
  const runId = parsed.flags.run;
  if (runId === undefined || runId === '') {
    io.error(`graphmind resume: --run <id> is required (graphmind pauses lists them)\n${usage}`);
    return EXIT.usage;
  }
  const action = parsed.flags.action;
  if (action === undefined || !(ACTIONS as readonly string[]).includes(action)) {
    io.error(`graphmind resume: --action must be one of ${ACTIONS.join(', ')}\n${usage}`);
    return EXIT.usage;
  }
  if (parsed.flags.output !== undefined && action !== 'inject') {
    io.error('graphmind resume: --output is only meaningful with --action inject');
    return EXIT.usage;
  }
  if (action === 'inject' && parsed.flags.output === undefined) {
    io.error("graphmind resume: --action inject needs --output <json|@file> (e.g. --output '{\"ok\":true}')");
    return EXIT.usage;
  }
  const body: Record<string, unknown> = { action };
  for (const [flag, key, raw] of [
    ['--output', 'output', parsed.flags.output],
    ['--input', 'input', parsed.flags.input],
  ] as const) {
    if (raw === undefined) continue;
    const value = readJsonArg(flag, raw);
    if (!value.ok) {
      io.error(`graphmind resume: ${value.message}`);
      return EXIT.usage;
    }
    body[key] = value.value;
  }
  if (parsed.flags.operator !== undefined) body['operator'] = parsed.flags.operator;
  const waitS = Math.min(120, Math.max(1, parsed.flags.timeout ?? 30));
  body['timeoutMs'] = Math.round(waitS * 1000);

  const port = parsed.flags.port ?? DEFAULT_PORT;
  const credential = readRunFile(io.env, port);
  if (!credential.ok) {
    io.error(`graphmind resume: ${credential.message}`);
    return credential.reason === 'missing' ? EXIT.unauthorized : EXIT.unauthorized;
  }

  let result;
  try {
    result = await request(
      port,
      `/api/runs/${encodeURIComponent(runId)}/pauses/${encodeURIComponent(pauseId)}/resume`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential.content.agentToken}`,
        },
        body: JSON.stringify(body),
        timeoutMs: waitS * 1000 + 15_000,
      },
    );
  } catch (error) {
    io.error(`graphmind resume: ${(error as Error).message}`);
    return EXIT.unreachable;
  }

  const { status } = result;
  const answer = result.body;
  if (parsed.flags.json) io.log(JSON.stringify(answer));
  const message = typeof answer['message'] === 'string' ? answer['message'] : '';
  const code = typeof answer['code'] === 'string' ? answer['code'] : undefined;
  if (status === 401) {
    if (!parsed.flags.json) {
      io.error(
        `graphmind resume: the server refused the agent token in ${credential.path} — it is from an ` +
          'earlier `graphmind serve`; the file is rewritten when the server on this port restarts',
      );
    }
    return EXIT.unauthorized;
  }
  const outcome = typeof answer['outcome'] === 'string' ? answer['outcome'] : undefined;
  if (outcome === undefined) {
    if (!parsed.flags.json) io.error(`graphmind resume: ${message || `the server answered ${status}`}`);
    return status === 429 ? EXIT.timeout : EXIT.usage;
  }
  const where = `pause ${pauseId} (run ${runId})`;
  const say = (line: string, toError = false): void => {
    if (parsed.flags.json) return;
    if (toError) io.error(line);
    else io.log(line);
  };
  switch (outcome) {
    case 'resumed':
      say(`resumed ${where}: ${action}${body['input'] === undefined ? '' : ' with the edited input'} (as ${String(answer['principal'] ?? 'agent')})`);
      return EXIT.ok;
    case 'refused':
      say(`refused ${where}${code === undefined ? '' : ` [${code}]`}: ${message}`, true);
      return status === 403 ? EXIT.unauthorized : EXIT.refused;
    case 'taken':
      say(`taken ${where}${code === undefined ? '' : ` [${code}]`}: ${message}`, true);
      return EXIT.taken;
    case 'timeout':
      say(`no answer yet for ${where}${code === undefined ? '' : ` [${code}]`}: ${message}`, true);
      return EXIT.timeout;
    case 'no-such-pause':
      say(`${where} is not held${code === undefined ? '' : ` [${code}]`}: ${message}`, true);
      return EXIT.gone;
    default:
      say(`graphmind resume: unexpected outcome "${outcome}"`, true);
      return EXIT.usage;
  }
}
