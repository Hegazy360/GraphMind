/**
 * `graphmind replay <runId> -- <command>` — re-run your agent against a
 * recording instead of the outside world.
 *
 *   graphmind replay last -- node agent.js          # replay, report
 *   graphmind replay last --assert -- node agent.js # ...and fail on a divergence
 *   graphmind replay <id> --dry                     # can this run be replayed?
 *
 * WHAT IT DOES, in order: build a tape from the stored run (replay/tape.ts),
 * write it to a temp file, start a server to record the new run into, spawn
 * your command with `GRAPHMIND_REPLAY` pointing at the tape, then compare
 * the trajectory the replay produced against the recording's
 * (replay/compare.ts).
 *
 * The command is yours and runs unchanged — the substitution happens inside
 * `@graphmind-ai/sdk`, which reads `GRAPHMIND_REPLAY`. There is nothing to
 * add to your code.
 *
 * WHAT IS AND IS NOT HERMETIC is printed before every replay rather than
 * buried in docs, because the honest answer is "only what GraphMind gates":
 * tool calls and (for the Vercel AI SDK) model steps are served from the
 * tape; a bare `fetch`, a database write, a file written by a tool that
 * also returns a value — all of those happen for real, again. `--dry` says
 * what a replay would cover without running anything.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeKind } from '@graphmind-ai/schema';
import type { ParsedCli } from '../args.js';
import { DEFAULT_PORT, resolveDbPath } from '../paths.js';
import { startServer, type GraphMindServer } from '../server.js';
import { SqliteStorage } from '../sqlite-storage.js';
import type { StoredEvent } from '../storage.js';
import { recordTelemetry } from '../telemetry.js';
import { VERSION } from '../version.js';
import { compareTrajectories, type CompareResult } from '../replay/compare.js';
import { buildTape, trajectoryOf, type BuildTapeResult } from '../replay/tape.js';
import { applySubstitutions, parseSubstitution, SubstituteError, type Substitution } from '../replay/substitute.js';

export interface ReplayIo {
  log(message: string): void;
  error(message: string): void;
}

/**
 * The events of a recorded run, read from an NDJSON file written by
 * `graphmind record` (one wire envelope per line).
 *
 * This is how a replay runs with no local database at all: commit the
 * fixture, replay against it. CI needs exactly that — there is no
 * `~/.graphmind/graphmind.db` on a fresh runner, and a recording that lives
 * in the repo is reviewable in a diff.
 *
 * Deliberately strict about the lines it does not understand: a malformed
 * line is skipped and counted, never guessed at.
 */
function eventsFromNdjson(path: string): { runId: string; events: StoredEvent[]; skipped: number } {
  const text = readFileSync(path, 'utf8');
  const events: StoredEvent[] = [];
  let runId: string | undefined;
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const envelope = parsed as Partial<StoredEvent> & { payload?: unknown };
    if (
      typeof envelope.runId !== 'string' ||
      typeof envelope.seq !== 'number' ||
      typeof envelope.type !== 'string'
    ) {
      skipped += 1;
      continue;
    }
    runId ??= envelope.runId;
    events.push({
      runId: envelope.runId,
      seq: envelope.seq,
      ts: typeof envelope.ts === 'number' ? envelope.ts : 0,
      type: envelope.type,
      nodeId: (envelope.payload as { nodeId?: string } | undefined)?.nodeId ?? null,
      payload: envelope.payload,
    });
  }
  if (runId === undefined) {
    throw new Error(
      `${path} has no GraphMind envelopes — it should be a file written by \`graphmind record\`.`,
    );
  }
  events.sort((a, b) => a.seq - b.seq);
  return { runId, events, skipped };
}

/** Is a GraphMind server already answering on this port? (Same probe as `demo`.) */
async function serverIsUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = (await response.json()) as { name?: string };
    return body.name === 'graphmind-ai';
  } catch {
    return false;
  }
}

/** `last` picks the most recently started run, as `graphmind runs` lists them. */
function resolveRunId(storage: SqliteStorage, arg: string): string {
  if (arg !== 'last') return arg;
  const newest = storage.listRuns()[0];
  if (newest === undefined) throw new Error('no runs stored yet — record one first.');
  return newest.id;
}

function countKinds(result: BuildTapeResult): Map<NodeKind, number> {
  const counts = new Map<NodeKind, number>();
  for (const entry of result.tape.entries) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  return counts;
}

/** The pre-flight: what this tape covers, and what it cannot. */
function describeTape(result: BuildTapeResult, io: ReplayIo): void {
  const counts = countKinds(result);
  const parts = [...counts.entries()].map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  io.log(`Tape: ${result.tape.entries.length} recorded call(s) — ${parts.join(', ') || 'none'}`);
  if (result.unfinished > 0) {
    io.log(
      `  ${result.unfinished} execution(s) never completed in the recording and are not on the tape; ` +
        'reaching one is a miss.',
    );
  }
  if (result.lossy > 0) {
    io.log(
      `  ${result.lossy} recorded value(s) were too large to keep in full (over the payload cap) and ` +
        'cannot be replayed faithfully; they refuse to answer unless you pass --on-lossy=live.',
    );
  }
  io.log('');
  const tape = result.tape;
  if (tape.cutSeq !== undefined) {
    const named = (tape.substituted ?? [])
      .map((target) => (target.ordinal === 0 ? target.nodeId : `${target.nodeId}#${target.ordinal}`))
      .join(', ');
    io.log(`COUNTERFACTUAL: ${named} answers with your value instead of its recorded one.`);
    io.log('Everything the recording captured before it replays; EVERYTHING AFTER RUNS FOR');
    io.log('REAL — the conversation has diverged, so the model is called and tools execute.');
    io.log('That needs a provider key and costs tokens.');
  } else if (tape.liveModel === true) {
    io.log('LIVE MODEL: tool calls replay from the recording; every model step calls the');
    io.log('provider for real. That needs a provider key and costs tokens. Use it to test a');
    io.log('prompt, a tool description or a model change against a fixed tool environment.');
  } else {
    io.log('Hermetic for: tool calls, and model steps under the Vercel AI SDK adapter.');
  }
  io.log('NOT hermetic:  anything your code does outside GraphMind — plain HTTP, database');
  io.log('               writes, files. Those happen for real, again. Model steps under the');
  io.log('               Anthropic, OpenAI and LangGraph adapters still call their provider.');
}

function describeResult(comparison: CompareResult, counterfactual: boolean, io: ReplayIo): void {
  io.log('');
  if (counterfactual) {
    // Divergence is the POINT here, not a failure: the reader wants to know
    // what the agent did differently once the value changed.
    io.log(
      `What changed: ${comparison.recorded} call(s) recorded, ${comparison.actual} this time` +
        (comparison.divergences.length === 0 ? '' : ''),
    );
    if (comparison.divergences.length === 0) {
      io.log('The agent took exactly the same path despite the substitution.');
      return;
    }
    io.log('');
    for (const divergence of comparison.divergences) io.log(`  ${divergence.message}`);
    return;
  }
  io.log(
    `Trajectory: ${comparison.matched}/${comparison.recorded} call(s) matched the recording` +
      (comparison.actual !== comparison.recorded ? ` (the replay made ${comparison.actual})` : ''),
  );
  if (comparison.divergences.length === 0) {
    io.log('No divergence: the replay did exactly what the recording did.');
    return;
  }
  io.log('');
  for (const divergence of comparison.divergences) {
    io.log(`  ${divergence.kind.padEnd(12)} ${divergence.message}`);
  }
  if (comparison.ok) {
    io.log('');
    io.log('Nothing worse than an acceptable alternative — treated as a pass.');
  }
}

export async function runReplay(parsed: ParsedCli, io: ReplayIo = console): Promise<number> {
  recordTelemetry('replay');

  const arg = parsed.positionals[0];
  if (arg === undefined) {
    io.error('usage: graphmind replay <runId|last|recording.ndjson> [--assert] [--dry] -- <command...>');
    return 1;
  }
  const command = parsed.rest ?? [];
  const dry = parsed.flags.dry === true;
  if (!dry && command.length === 0) {
    io.error(
      'graphmind replay: nothing to run. Put your agent command after `--`, e.g.\n' +
        '  graphmind replay last -- node agent.js\n' +
        'Or pass --dry to see what a replay of this run would cover.',
    );
    return 1;
  }

  // The recording comes either from a committed NDJSON fixture (CI: no
  // database exists) or from the local database.
  const fromFile = arg.endsWith('.ndjson') || (arg !== 'last' && existsSync(arg));
  const dbPath = resolveDbPath(parsed.flags.db);
  let built: BuildTapeResult;
  let runId: string;
  try {
    if (fromFile) {
      const loaded = eventsFromNdjson(arg);
      runId = loaded.runId;
      if (loaded.skipped > 0) {
        io.error(`graphmind replay: skipped ${loaded.skipped} unreadable line(s) in ${arg}.`);
      }
      built = buildTape(runId, loaded.events);
    } else {
      const storage = new SqliteStorage(dbPath);
      try {
        runId = resolveRunId(storage, arg);
        const run = storage.getRun(runId);
        if (run === undefined) {
          io.error(`graphmind replay: no run "${runId}" (graphmind runs lists what is stored).`);
          return 1;
        }
        if (run.source === 'import') {
          io.error(
            `graphmind replay: run "${runId}" came from \`graphmind import\`. An imported trace is ` +
              'history, not a recording of gated calls, so it cannot be replayed. Replay a run ' +
              'GraphMind recorded itself, or a fixture written by `graphmind record`.',
          );
          return 1;
        }
        built = buildTape(runId, storage.listEvents(runId).events);
      } finally {
        storage.close();
      }
    }
  } catch (error) {
    io.error(`graphmind replay: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // Counterfactual / live-model modes are expressed IN the tape, so the
  // file the child reads fully describes the replay it is about to do.
  const counterfactual = parsed.flags.substitute.length > 0;
  if (counterfactual || parsed.flags.liveModel) {
    if (parsed.flags.assert === true) {
      io.error(
        'graphmind replay: --assert cannot be combined with --substitute or --live-model. ' +
          'Both of those deliberately let the run diverge, so asserting it did not is a ' +
          'contradiction — drop --assert and read the report.',
      );
      return 1;
    }
    try {
      const substitutions: Substitution[] = parsed.flags.substitute.map(parseSubstitution);
      built = { ...built, tape: applySubstitutions(built.tape, substitutions) };
      if (parsed.flags.liveModel) built = { ...built, tape: { ...built.tape, liveModel: true } };
    } catch (error) {
      if (error instanceof SubstituteError) {
        io.error(`graphmind replay: ${error.message}`);
        return 1;
      }
      throw error;
    }
  }

  io.log(`Replaying ${runId}${built.tape.app === undefined ? '' : ` (${built.tape.app})`}`);
  io.log('');
  describeTape(built, io);

  if (built.tape.entries.length === 0) {
    io.error('');
    io.error('graphmind replay: this run recorded no replayable calls — nothing to serve.');
    return 1;
  }
  if (dry) {
    io.log('');
    io.log('--dry: nothing was run.');
    return 0;
  }

  // The replayed run needs somewhere to be recorded. Reuse a server already
  // on the port (so the viewer shows it live), else start one here.
  const port = parsed.flags.port ?? DEFAULT_PORT;
  let started: GraphMindServer | undefined;
  if (!(await serverIsUp(port))) {
    started = await startServer({
      port,
      ...(parsed.flags.db === undefined ? {} : { dbPath: parsed.flags.db }),
    });
    io.log('');
    io.log(`GraphMind v${VERSION} listening on ${started.url} (started for the replay)`);
  }
  const ingestUrl = `ws://127.0.0.1:${started?.port ?? port}/ingest`;

  const dir = mkdtempSync(join(tmpdir(), 'graphmind-replay-'));
  const tapePath = join(dir, 'tape.json');
  writeFileSync(tapePath, JSON.stringify(built.tape), { mode: 0o600 });

  io.log('');
  io.log(`Running: ${command.join(' ')}`);
  io.log('─'.repeat(72));

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), {
        stdio: 'inherit',
        env: {
          ...process.env,
          GRAPHMIND: '1',
          GRAPHMIND_URL: ingestUrl,
          GRAPHMIND_REPLAY: tapePath,
          ...(parsed.flags.onMiss !== undefined ? { GRAPHMIND_REPLAY_ON_MISS: parsed.flags.onMiss } : {}),
          ...(parsed.flags.onLossy !== undefined ? { GRAPHMIND_REPLAY_ON_LOSSY: parsed.flags.onLossy } : {}),
        },
      });
      child.on('error', (error) => {
        io.error(`graphmind replay: failed to run "${command[0]}" (${error.message})`);
        resolve(127);
      });
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  io.log('─'.repeat(72));

  // The replayed run is whatever landed in the database after the original.
  const after = new SqliteStorage(dbPath);
  let comparison: CompareResult | undefined;
  try {
    const newest = after.listRuns().find((candidate) => candidate.id !== runId);
    if (newest === undefined) {
      io.error('graphmind replay: the command recorded no run — was the agent instrumented?');
      return exitCode === 0 ? 1 : exitCode;
    }
    const replayed = buildTape(newest.id, after.listEvents(newest.id).events);
    comparison = compareTrajectories(trajectoryOf(built.tape.entries), trajectoryOf(replayed.tape.entries));
    describeResult(comparison, counterfactual, io);
    io.log('');
    io.log(`Replayed run: http://127.0.0.1:${started?.port ?? port}/#/run/${encodeURIComponent(newest.id)}`);
  } finally {
    after.close();
    if (started !== undefined) await started.close();
  }

  if (parsed.flags.json) io.log(JSON.stringify(comparison, null, 2));
  if (exitCode !== 0) {
    io.error('');
    io.error(`graphmind replay: the command exited ${exitCode}.`);
    return exitCode;
  }
  if (parsed.flags.assert === true && comparison !== undefined && !comparison.ok) {
    io.error('');
    io.error('graphmind replay --assert: the replay diverged from the recording (see above).');
    return 1;
  }
  return 0;
}
