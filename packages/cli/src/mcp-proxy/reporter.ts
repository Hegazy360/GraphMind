/**
 * The debugger half of the proxy: turns a JSON-RPC conversation into a
 * GraphMind run, and turns the debugger's gate decisions back into protocol
 * actions.
 *
 * Everything here is built on `@graphmind-ai/client` — the session owns the
 * transport, the ring buffer, the breakpoints and the fail-open rules; this
 * file only decides which node a frame is and what a decision means over the
 * wire.
 *
 * The shape of a session (what the viewer draws):
 *
 *   mcp:session                (kind server)   the proxied command; one run
 *   ├─ mcp:protocol            (kind custom, name "protocol", opened FOLDED:
 *   │  │                        `node.started … collapsed: true`)
 *   │  ├─ mcp:initialize
 *   │  ├─ mcp:notifications/initialized
 *   │  ├─ mcp:tools/list, mcp:resources/list, mcp:prompts/list, mcp:ping, …
 *   │  └─ mcp:stdout-noise     (kind custom, name "stdout noise", ERROR-badged:
 *   │                           one execution per line the server wrote to
 *   │                           stdout that is not JSON-RPC — plain text or a
 *   │                           structured logger's JSON — see `noteStdoutNoise`)
 *   ├─ tool:<name>             (kind tool)      tools/call
 *   ├─ resource:<uri>          (kind resource)  resources/read
 *   ├─ prompt:<name>           (kind prompt)    prompts/get
 *   ├─ llm:sampling            (kind llm)       sampling/createMessage
 *   └─ mcp:elicitation/*, mcp:completion/complete (kind custom, work)
 *
 * The split is the wire-level truth, not a heuristic: `isWorkMethod` in
 * mapping.ts is the one rule, and an unknown method lands under
 * `mcp:protocol`. Nothing about gating changes with the parent — a
 * breakpoint on `initialize` holds it under the folded group exactly as it
 * did when it was a flat sibling, and an `initialize` that fails trips the
 * error gate and badges the folded card red. `mcp:protocol` is created
 * lazily on the first protocol frame (so a session with none has no empty
 * group) and closed when the session closes, with counts on its output.
 *
 * Gate semantics (the debugger part), per direction:
 *
 *   REQUEST, before it reaches the peer            -> gate('before')
 *     continue / retry  forward it unchanged
 *     inject            do NOT forward; answer the sender with the injected
 *                       value as the JSON-RPC `result`
 *     abort             do NOT forward; answer the sender with a JSON-RPC
 *                       error (-32099)
 *
 *   RESPONSE, before it reaches the requester      -> gate('after')
 *   ...or gate('error') when it carries a JSON-RPC `error`, or an MCP tool
 *   result with `isError: true` (armed by default by `graphmind serve`)
 *     continue          forward it unchanged
 *     inject            forward a rewritten frame carrying the injected
 *                       `result` (or the whole frame, if the injected object
 *                       has its own `jsonrpc` field)
 *     retry             drop it and re-send the original request to the
 *                       server; the node stays open until the new answer
 *     abort             drop it and answer the requester with -32099
 *
 *   NOTIFICATION (no id, no answer)                -> gate('before')
 *     continue / retry  forward
 *     inject            forward the injected object in its place
 *     abort             swallow it
 *
 * Edited tool arguments (0.6.0, contract C2), client->server `tools/call`
 * only: every gate of the call is offered as `editable` (the session shows it
 * only when the app and the debugger both enabled edits). The edit comes in
 * the shape of the node's recorded input — the request's `params`, `{name,
 * arguments, _meta}` — and only `arguments` may differ (see `toolEdit`).
 *     continue + input  at `before`: the held frame is re-serialized with its
 *                       `params.arguments` replaced by the edited arguments
 *                       merged into the live ones — `name`, `_meta`, the id
 *                       and every other key keep their values and order —
 *                       and relayed in place of the original bytes. It is the
 *                       only frame that is re-serialized; every other frame
 *                       stays byte-for-byte.
 *     retry + input     at `after` / `error`: the same rewrite, re-sent down
 *                       the retry path; the rewritten bytes become what a
 *                       later plain `retry` re-sends.
 *   Before an edit runs it is checked against the tool's `inputSchema` as the
 *   server listed it in its last `tools/list` answer (a conservative
 *   JSON-schema-lite check: only what the schema clearly forbids is refused,
 *   and the gate stays held); with no schema known, the server is the judge.
 *   The node's recorded input keeps the client's arguments and
 *   `exec.resumed.edited` records what ran. At the tool's `after` / `error`
 *   gate the JSON-RPC result (including `isError`) goes to the session's
 *   after-gate detectors.
 *
 * A request that never gets an answer keeps its node OPEN — that is a real
 * server bug and the graph has to show it. Only when the child process dies
 * do the still-open requests become errors, because then we know for a fact
 * no answer is coming.
 *
 * Two silent failures are made loud here (they are the two an MCP developer
 * actually hits, per real user reports):
 *
 *   1. The server logs to stdout. stdout IS the wire, so a `console.log` in a
 *      handler corrupts the stream; before, the proxy relayed the line and
 *      said nothing. Now the FIRST such line prints one default-on stderr
 *      line (quoting <= 200 bytes, with the fix), every line is counted for
 *      `summary()`, and each one (up to a cap) is an error-badged execution
 *      of `mcp:stdout-noise` so someone watching only the viewer sees it.
 *      The bytes are still relayed verbatim — the proxy never edits the wire
 *      on its own initiative.
 *   2. The server never got going. When it exits before its first response
 *      (or could not be spawned at all), the tail of its stderr (a bounded
 *      ring, see stderr-ring.ts) is printed with the failure and attached to
 *      the session node's error, so the exit code arrives with the reason.
 *
 * Timing: durations are `performance.now()` deltas rounded to 0.01 ms (see
 * clock.ts); envelope timestamps stay integer epoch ms (the client's job).
 */
import {
  canonicalize,
  editedArgs,
  isEditableToolInput,
  jsonSchemaLiteCheck,
  mergeToolInput,
  toolGateOptions,
  type GateDecision,
  type GateNode,
  type GateOptions,
  type InputValidation,
  type PausePoint,
  type RunStatus,
  type Session,
  type TokenDelta,
  type ToolEdit,
} from '@graphmind-ai/client';
import { durationBetween, monotonicNow, type Clock } from './clock.js';
import { describeExit } from './exit-status.js';
import {
  GRAPHMIND_ABORTED_CODE,
  classify,
  encodeFrame,
  errorResponse,
  idKey,
  injectedResponse,
  isErrorResult,
  parseFrame,
  type ClassifiedFrame,
  type JsonRpcErrorBody,
  type JsonRpcId,
} from './jsonrpc.js';
import {
  PROTOCOL_NODE_ID,
  PROTOCOL_NODE_NAME,
  SESSION_NODE_ID,
  STDOUT_NOISE_NODE_ID,
  STDOUT_NOISE_NODE_NAME,
  commandLabel,
  directionLabel,
  mapMethod,
  otherSide,
  type Direction,
  type MappedNode,
} from './mapping.js';
import { coerceInjectedFor, stampModernEra } from './coerce.js';
import { FORWARD, type FrameAction } from './relay.js';
import { StderrRing } from './stderr-ring.js';

/** How the reporter reaches the two ends of the pipe. */
export interface FrameSink {
  writeFrame(raw: Buffer): Promise<void>;
}

export interface ReporterOptions {
  /**
   * GRAPHMIND_HIDE_OUTPUTS / GRAPHMIND_HIDE_TOOL_RESULTS as the session resolved
   * them. `node.error` is never redacted by the session, so the reporter must
   * not copy a failed (`isError`) result's content into it when results are
   * hidden — that content IS the result, not an exception message.
   */
  hideOutputs?: boolean;
  hideToolResults?: boolean;
  /** GRAPHMIND_HIDE_INPUTS: the session label drops the command's arguments. */
  hideInputs?: boolean;
  session: Session;
  command: string;
  args: readonly string[];
  /** The stream a frame travelling in `direction` should be written to. */
  sinkFor(direction: Direction): FrameSink;
  /** Human-facing diagnostics. NEVER stdout — that is the protocol channel. */
  log(line: string): void;
  /** One line per frame on stderr. Off by default. */
  trace?: boolean;
  /** node.token flush interval for captured server stderr. Default 40ms. */
  stderrFlushMs?: number;
  /** Viewer address, quoted when a gate holds. */
  viewerUrl?: string;
  /** Monotonic clock for durations (tests). Default `performance.now`. */
  now?: Clock;
  /**
   * Whether the server's stderr flows through us. When it does not
   * (`--inherit-stderr`) the failure line says so instead of quoting a tail.
   */
  stderrCaptured?: boolean;
}

interface PendingRequest {
  node: MappedNode;
  instanceId: string;
  method: string;
  /** The originating side, i.e. where the answer must be delivered. */
  origin: Direction;
  id: JsonRpcId;
  startedAt: number;
  /** The exact request bytes, kept so `retry` can re-send them verbatim. */
  raw: Buffer;
  /** The request's params, kept so an injected value can be coerced (uri). */
  params: unknown;
  retries: number;
}

const MAX_PENDING = 10_000;
/** Tools whose `inputSchema` is remembered from `tools/list` (for checking edits). */
const MAX_TOOL_SCHEMAS = 1_000;
/**
 * How long a gate may hold before we say so on stderr.
 *
 * Holding is the whole point of the product, but from the MCP client's side a
 * hold is indistinguishable from a hung server — a `tools/call` simply stops
 * answering until its own timeout fires. One line on stderr (which is where
 * MCP clients surface server logs) turns "my server froze" into "GraphMind is
 * holding this; go and look". Long enough that a normal gated-and-immediately-
 * continued frame stays silent.
 */
const HOLD_NOTICE_MS = 250;
/** Cap on a single stderr batch so a chatty server cannot balloon one event. */
const MAX_STDERR_BATCH = 64 * 1024;
/** How much of a stdout line that is not JSON-RPC is quoted (stderr line and node input). */
export const STDOUT_NOISE_QUOTE_BYTES = 200;
/**
 * How many such stdout lines become executions on the graph. A server
 * that logs on every request would otherwise turn the folded group into a
 * thousand red cards; past the cap the lines are only counted.
 */
export const STDOUT_NOISE_MAX_RECORDED = 25;
/** How many stderr lines the failure line quotes on the terminal. */
const STDERR_TAIL_ON_TERMINAL = 40;

export class ProxyReporter {
  private readonly session: Session;
  private readonly pending = new Map<string, PendingRequest>();
  /**
   * Each tool's `inputSchema` from the server's `tools/list` answers (pages
   * accumulate); dropped on `notifications/tools/list_changed`. Only ever used
   * to check an edited `tools/call` before it is relayed.
   */
  private readonly toolSchemas = new Map<string, unknown>();
  private readonly label: string;
  private readonly now: Clock;
  private readonly stderrFlushMs: number;
  private readonly stderrRing = new StderrRing();

  private instanceCounter = 0;
  private sessionStartedAt = 0;
  private sessionOpen = false;
  private unmatchedResponses = 0;
  private unparseableClientFrames = 0;
  private unansweredAtExit = 0;
  private negotiated: string | undefined;
  /** 'legacy' after an `initialize` result, 'modern' after a successful `server/discover`. */
  private era: 'legacy' | 'modern' | undefined;
  private firstResponseSeen = false;
  private spawnFailure: string | undefined;
  private spawnFailureReported = false;
  private earlyDeathReported = false;
  private earlyDeathReason: string | undefined;

  private protocolStartedAt: number | undefined;
  private protocolCalls = 0;
  private protocolErrors = 0;

  private stdoutNoiseCount = 0;
  private stdoutNoiseRecorded = 0;

  private stderrBuffer = '';
  private stderrTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ReporterOptions) {
    this.session = options.session;
    this.label = commandLabel(options.command, options.args, undefined, options.hideInputs === true);
    this.now = options.now ?? monotonicNow;
    this.stderrFlushMs = options.stderrFlushMs ?? 40;
  }

  /** Requests still waiting for an answer. */
  get outstanding(): number {
    return this.pending.size;
  }

  /** The protocol version the two peers agreed on, once `initialize` returns. */
  get protocolEra(): 'legacy' | 'modern' | undefined {
    return this.era;
  }

  get negotiatedProtocolVersion(): string | undefined {
    return this.negotiated;
  }

  /** Lines the server wrote to stdout that were not JSON-RPC, so far. */
  get stdoutNoiseLines(): number {
    return this.stdoutNoiseCount;
  }

  /** Whether the server has answered anything yet. */
  get hasResponded(): boolean {
    return this.firstResponseSeen;
  }

  /** The command could not be started at all (spawn threw or emitted 'error'). */
  get spawnFailed(): boolean {
    return this.spawnFailure !== undefined;
  }

  /** The server exited before its first JSON-RPC frame (see `reportEarlyDeath`). */
  get diedEarly(): boolean {
    return this.earlyDeathReported;
  }

  /**
   * Why the session never got going — the run-level error message. Undefined
   * for a session that answered at least once, whatever happened afterwards.
   */
  get failureReason(): string | undefined {
    if (this.spawnFailure !== undefined) return this.spawnFailure;
    if (this.earlyDeathReported) {
      return `${this.earlyDeathReason ?? 'the server exited'} before answering anything`;
    }
    return undefined;
  }

  // -- lifecycle ------------------------------------------------------------

  sessionStarted(): void {
    this.sessionOpen = true;
    this.sessionStartedAt = this.now();
    this.session.emit('graph.hint', {
      nodes: [{ nodeId: SESSION_NODE_ID, kind: 'server', name: this.label }],
    });
    this.session.emit('node.started', {
      nodeId: SESSION_NODE_ID,
      kind: 'server',
      name: this.label,
      instanceId: SESSION_NODE_ID,
      input: { command: this.options.command, args: [...this.options.args] },
      transport: 'stdio',
    });
    // A spawn that already failed (ENOENT fires before the run opens under
    // --wait-for-attach; a synchronous throw always does) is reported now,
    // in order, after the node exists.
    this.reportSpawnFailure();
  }

  /**
   * The command could not be started at all — `spawn` threw synchronously
   * (Windows `EINVAL` for a `.cmd`) or emitted `error` (ENOENT). Recorded on
   * the session node as its error so the viewer shows the reason, not just
   * an exit code of 127.
   *
   * Deliberately NOT emitted from here. This is called from the child's
   * 'error' listener, which runs outside the run's async context; an emit
   * from there opens an anonymous implicit run beside the real one, and the
   * SpawnError ends up in a run with nothing else in it. It is emitted
   * in-context instead: by `sessionStarted()` when it is already known when
   * the run opens (`--wait-for-attach`, or a synchronous throw), otherwise
   * by `sessionFinished()`, which follows within the same tick.
   */
  noteSpawnFailure(message: string): void {
    if (this.spawnFailure !== undefined) return;
    this.spawnFailure = message;
  }

  private reportSpawnFailure(): void {
    if (this.spawnFailure === undefined || this.spawnFailureReported) return;
    this.spawnFailureReported = true;
    this.emitSessionError('SpawnError', this.spawnFailure);
  }

  /**
   * The child is gone. Every request still in flight is now provably
   * unanswerable, so it stops being "still running" and becomes an error.
   */
  sessionFinished(exit: { code: number | null; signal: string | null }): void {
    this.flushStderr();
    if (this.stderrTimer !== undefined) clearTimeout(this.stderrTimer);
    const reason = describeExit(exit);
    this.unansweredAtExit = this.pending.size;
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      this.session.emit('node.error', {
        nodeId: entry.node.nodeId,
        instanceId: entry.instanceId,
        error: { name: 'McpServerExited', message: `${reason} before answering ${entry.method}` },
      });
      this.finish(entry, undefined, 'error', { unanswered: true });
    }
    if (!this.sessionOpen) return;
    this.sessionOpen = false;

    // ENOENT that arrived after the run opened (the common case without
    // --wait-for-attach): put the SpawnError on the session node now, from
    // inside the run, before the node closes.
    this.reportSpawnFailure();

    const ok = exit.signal === null && (exit.code ?? 0) === 0;
    // Died before it ever answered: the exit code alone explains nothing, so
    // the stderr tail travels with it — on the terminal and on the node.
    const earlyDeath =
      !this.firstResponseSeen &&
      this.spawnFailure === undefined &&
      (!ok || this.unansweredAtExit > 0);
    if (earlyDeath) this.reportEarlyDeath(reason);

    if (this.protocolStartedAt !== undefined) {
      this.session.emit('node.finished', {
        nodeId: PROTOCOL_NODE_ID,
        instanceId: PROTOCOL_NODE_ID,
        output: {
          calls: this.protocolCalls,
          errors: this.protocolErrors,
          stdoutNoise: this.stdoutNoiseCount,
        },
        durationMs: durationBetween(this.protocolStartedAt, this.now()),
        status: 'ok',
      });
    }
    this.session.emit('node.finished', {
      nodeId: SESSION_NODE_ID,
      instanceId: SESSION_NODE_ID,
      output: { exitCode: exit.code, signal: exit.signal },
      durationMs: durationBetween(this.sessionStartedAt, this.now()),
      status: ok && this.spawnFailure === undefined ? 'ok' : 'error',
    });
  }

  /**
   * The MCP server's stderr — the one channel a stdio server can legitimately
   * log to. Streamed onto the session node as text deltas so the logs sit
   * next to the protocol they explain, and remembered (bounded) so a server
   * that dies early can be quoted. The bytes the client sees are written
   * separately and are not touched by this.
   */
  noteStderr(chunk: Buffer): void {
    this.stderrRing.push(chunk);
    this.stderrBuffer += chunk.toString('utf8');
    if (this.stderrBuffer.length >= MAX_STDERR_BATCH) {
      this.flushStderr();
      return;
    }
    if (this.stderrTimer !== undefined) return;
    this.stderrTimer = setTimeout(() => {
      this.stderrTimer = undefined;
      this.flushStderr();
    }, this.stderrFlushMs);
    this.stderrTimer.unref?.();
  }

  flushStderr(): void {
    if (this.stderrBuffer === '') return;
    const value = this.stderrBuffer;
    this.stderrBuffer = '';
    const deltas: TokenDelta[] = [{ t: 'text', v: value }];
    this.session.emit('node.token', { nodeId: SESSION_NODE_ID, deltas });
  }

  /** A one-line end-of-session report for the developer's terminal. */
  summary(): string[] {
    const lines: string[] = [];
    if (this.unansweredAtExit > 0) {
      lines.push(
        `${this.unansweredAtExit} request(s) were still unanswered when the server exited ` +
          (this.session.enabled ? '(they are marked as errors on the graph)' : '(nothing was recorded: GraphMind is disabled)'),
      );
    }
    if (this.unmatchedResponses > 0) {
      lines.push(`${this.unmatchedResponses} response(s) arrived with no matching request id`);
    }
    if (this.stdoutNoiseCount > 0) {
      lines.push(
        `${this.stdoutNoiseCount} line(s) the server wrote to stdout were not JSON-RPC and were relayed ` +
          `verbatim — stdout is the MCP wire; log to stderr${this.session.enabled ? ' (see "stdout noise" on the graph)' : ''}`,
      );
    }
    if (this.unparseableClientFrames > 0) {
      lines.push(
        `${this.unparseableClientFrames} frame(s) from the client were not JSON-RPC (relayed verbatim)`,
      );
    }
    return lines;
  }

  // -- the interceptor ------------------------------------------------------

  /**
   * Called by the relay for every complete frame, in order. Returning
   * `FORWARD` relays the original bytes untouched, which is what every path
   * that cannot classify or does not need to change a frame does.
   */
  async handleFrame(direction: Direction, raw: Buffer): Promise<FrameAction> {
    if (!this.sessionOpen) {
      // The session is over: the server is gone and the run is closed. A
      // frame the client had already written (an MCP host pipes `initialize`
      // the instant it spawns us, so this is the norm after a spawn failure
      // or a boot crash) cannot be answered or gated, and a node started
      // after run.finished would be a ghost in a finished run. Relay only.
      this.trace(direction, `frame after the session ended (${raw.length} bytes), relayed verbatim`);
      return FORWARD;
    }
    const value = parseFrame(raw);
    const frame = value === undefined ? undefined : classify(value);
    if (frame === undefined || frame.kind === 'other') {
      // Not JSON at all, or JSON that is not a JSON-RPC message. The second
      // kind is what a structured logger (pino, bunyan, winston-json) puts on
      // stdout by default — one JSON object per line — and the MCP client
      // rejects it exactly as it rejects plain text, so it must not pass for
      // "the server answered" just because JSON.parse succeeded.
      this.onUnparseable(direction, raw);
      return FORWARD;
    }
    if (direction === 'server-to-client') this.firstResponseSeen = true;
    switch (frame.kind) {
      case 'request':
        return await this.onRequest(direction, raw, frame);
      case 'notification':
        return await this.onNotification(direction, raw, frame);
      case 'response':
        return await this.onResponse(direction, raw, frame);
      case 'batch':
        // Batches were removed in MCP 2025-06-18. Older peers still emit
        // them: observe every element so the graph stays complete, but do
        // not gate — a half-held batch is not a thing the protocol has a
        // representation for.
        this.observeBatch(direction, frame);
        this.trace(direction, `batch of ${frame.items.length} (observed, not gated)`);
        return FORWARD;
      default:
        this.trace(direction, 'unrecognised JSON-RPC frame, relayed verbatim');
        return FORWARD;
    }
  }

  /**
   * A frame that is not JSON-RPC (plain text, or JSON of some other shape).
   * From the client that is just counted (a client bug, rare). From the
   * SERVER it is the classic stdio mistake — a log line on the wire — and it
   * gets the full treatment described in the header. Blank lines are
   * neither: they carry nothing worth quoting.
   */
  private onUnparseable(direction: Direction, raw: Buffer): void {
    const blank = raw.toString('utf8').trim() === '';
    if (direction === 'client-to-server' || blank) {
      if (!blank) this.unparseableClientFrames += 1;
      this.trace(direction, `frame that is not JSON-RPC (${raw.length} bytes), relayed verbatim`);
      return;
    }
    this.noteStdoutNoise(raw);
  }

  private noteStdoutNoise(raw: Buffer): void {
    this.stdoutNoiseCount += 1;
    const quoted = raw.subarray(0, STDOUT_NOISE_QUOTE_BYTES).toString('utf8');
    const truncated = raw.length > STDOUT_NOISE_QUOTE_BYTES;
    this.trace('server-to-client', `stdout line that is not JSON-RPC (${raw.length} bytes), relayed verbatim`);

    if (this.stdoutNoiseCount === 1) {
      // Once per session, default-on. JSON.stringify keeps control characters
      // and ANSI escapes from doing anything to the terminal.
      this.options.log(
        `graphmind mcp-proxy: the MCP server wrote a line to stdout that is not JSON-RPC: ` +
          `${JSON.stringify(quoted)}${truncated ? ` (first ${STDOUT_NOISE_QUOTE_BYTES} bytes)` : ''} ` +
          '— stdout is the MCP wire; log to stderr instead (console.error, or your logger ' +
          'pointed at stderr). Relayed verbatim; the client may reject it. Further lines are ' +
          'counted, not printed.',
      );
    }
    if (!this.sessionOpen || this.stdoutNoiseRecorded >= STDOUT_NOISE_MAX_RECORDED) return;
    this.stdoutNoiseRecorded += 1;
    this.ensureProtocolNode();
    const instanceId = this.nextInstanceId();
    const message =
      `the MCP server wrote a line to stdout that is not JSON-RPC (line ${this.stdoutNoiseCount}, ${raw.length} bytes): ` +
      `${JSON.stringify(quoted)}${truncated ? '…' : ''} — stdout is the MCP wire; log to stderr`;
    this.session.emit('node.started', {
      nodeId: STDOUT_NOISE_NODE_ID,
      parentId: PROTOCOL_NODE_ID,
      kind: 'custom',
      name: STDOUT_NOISE_NODE_NAME,
      instanceId,
      input: {
        text: quoted,
        bytes: raw.length,
        truncated,
        count: this.stdoutNoiseCount,
        hint: 'stdout is the MCP wire; log to stderr',
      },
      direction: directionLabel('server-to-client'),
    });
    this.session.emit('node.error', {
      nodeId: STDOUT_NOISE_NODE_ID,
      instanceId,
      error: { name: 'StdoutNoise', message },
    });
    this.session.emit('node.finished', {
      nodeId: STDOUT_NOISE_NODE_ID,
      instanceId,
      output: undefined,
      durationMs: 0,
      status: 'error',
    });
  }

  /**
   * `session.gate`, plus a stderr notice if it actually holds. Every gate in
   * this file goes through here.
   */
  private async gate(
    point: PausePoint,
    node: MappedNode,
    label: string,
    options?: GateOptions,
  ): Promise<GateDecision> {
    const decision = this.session.gate(point, toGateNode(node), options);
    let held = false;
    const timer = setTimeout(() => {
      held = true;
      const where =
        this.options.viewerUrl === undefined
          ? 'the GraphMind viewer'
          : this.options.viewerUrl;
      this.options.log(
        `graphmind mcp-proxy: HOLDING ${label} at the ${point} gate — resume it in ${where} ` +
          '(the MCP client is waiting; it will time out on its own if you do not)',
      );
    }, HOLD_NOTICE_MS);
    timer.unref?.();
    try {
      const settled = await decision;
      if (held) this.options.log(`graphmind mcp-proxy: released ${label} (${settled.action})`);
      return settled;
    } finally {
      clearTimeout(timer);
    }
  }

  private async onRequest(
    direction: Direction,
    raw: Buffer,
    frame: Extract<ClassifiedFrame, { kind: 'request' }>,
  ): Promise<FrameAction> {
    const node = mapMethod(frame.method, frame.params, direction);
    const instanceId = this.nextInstanceId();
    const entry: PendingRequest = {
      node,
      instanceId,
      method: frame.method,
      origin: direction,
      id: frame.id,
      startedAt: this.now(),
      raw,
      params: frame.params,
      retries: 0,
    };
    this.start(entry, frame.params);
    this.trace(direction, `-> ${frame.method} #${String(frame.id)}`);

    const decision = await this.gate(
      'before',
      node,
      `${frame.method} #${String(frame.id)}`,
      toolGateOptions(this.session, () => this.toolEdit(entry)),
    );
    if (decision.action === 'inject') {
      // Coerced into the result shape this method must answer with; see
      // coerce.ts. Without it, injecting `{"price":42}` at a `tools/call`
      // gate hands the host a tool result with no content and no error.
      const output = this.forWire(
        frame.method,
        coerceInjectedFor(frame.method, frame.params, decision.output),
      );
      await this.replyTo(direction, injectedResponse(frame.id, output));
      this.finish(entry, output, 'ok', { injected: true, gatedAt: 'before' });
      return { kind: 'drop' };
    }
    if (decision.action === 'abort') {
      const message = `${frame.method} aborted by the GraphMind debugger`;
      await this.replyTo(direction, errorResponse(frame.id, GRAPHMIND_ABORTED_CODE, message));
      this.session.emit('node.error', {
        nodeId: node.nodeId,
        instanceId,
        error: { name: 'GraphMindAborted', message },
      });
      this.finish(entry, undefined, 'aborted', { gatedAt: 'before' });
      return { kind: 'drop' };
    }
    // continue / retry: nothing has been sent yet, so both mean "send it".
    // An accepted edit (continue + input) sends the rewritten frame instead.
    const edited = editedArgs(decision);
    if (edited !== undefined && this.applyEditedArguments(entry, edited.args)) {
      this.remember(entry);
      this.trace(direction, `-> ${frame.method} #${String(frame.id)} sent with edited arguments`);
      return { kind: 'replace', raw: entry.raw };
    }
    this.remember(entry);
    return FORWARD;
  }

  private async onNotification(
    direction: Direction,
    _raw: Buffer,
    frame: Extract<ClassifiedFrame, { kind: 'notification' }>,
  ): Promise<FrameAction> {
    const node = mapMethod(frame.method, frame.params, direction);
    const instanceId = this.nextInstanceId();
    const startedAt = this.now();
    // The server's tool list changed: the remembered schemas may be stale, and
    // a stale schema must never refuse an edit the server would accept.
    if (frame.method === 'notifications/tools/list_changed' && direction === 'server-to-client') {
      this.toolSchemas.clear();
    }
    this.parentReady(node);
    this.session.emit('node.started', {
      nodeId: node.nodeId,
      parentId: node.parentId,
      kind: node.kind,
      name: node.name,
      instanceId,
      input: frame.params,
      method: frame.method,
      direction: directionLabel(direction),
      notification: true,
    });
    this.trace(direction, `~> ${frame.method} (notification)`);

    const decision = await this.gate('before', node, `${frame.method} (notification)`);
    const done = (status: RunStatus, extra?: Record<string, unknown>): void => {
      this.session.emit('node.finished', {
        nodeId: node.nodeId,
        instanceId,
        output: undefined,
        durationMs: durationBetween(startedAt, this.now()),
        status,
        notification: true,
        ...extra,
      });
    };
    if (decision.action === 'abort') {
      done('aborted');
      return { kind: 'drop' };
    }
    if (decision.action === 'inject') {
      // A notification has no reply to substitute, so `inject` means "send
      // this instead". Anything that cannot be a JSON-RPC frame (undefined, a
      // scalar, a cycle) would be garbage on the wire: relay the original.
      const raw = isFrameObject(decision.output) ? encodeFrame(decision.output) : undefined;
      if (raw === undefined) {
        this.options.log(
          'graphmind mcp-proxy: inject on a notification needs a JSON object; ' +
            `relaying ${frame.method} unchanged`,
        );
        done('ok');
        return FORWARD;
      }
      done('ok', { injected: true });
      return { kind: 'replace', raw };
    }
    done('ok');
    return FORWARD;
  }

  private async onResponse(
    direction: Direction,
    raw: Buffer,
    frame: Extract<ClassifiedFrame, { kind: 'response' }>,
  ): Promise<FrameAction> {
    // The answer travels the opposite way from the request that asked for it.
    const origin = otherSide(direction);
    const key = pendingKey(origin, frame.id);
    const entry = this.pending.get(key);
    if (entry === undefined) {
      this.unmatchedResponses += 1;
      this.trace(direction, `<- response #${String(frame.id)} with no pending request`);
      return FORWARD;
    }
    this.pending.delete(key);
    this.rememberNegotiated(entry.method, entry.params, frame.result, frame.error);
    this.rememberToolSchemas(entry, frame.result, frame.error);

    const failed = frame.error !== undefined || isErrorResult(frame.result);
    const output = frame.error !== undefined ? { error: frame.error } : frame.result;
    if (failed) this.recordError(entry, describeFailure(entry.method, frame.error, frame.result, this.hidesResultOf(entry.method)));
    this.trace(direction, `<- ${entry.method} #${String(frame.id)} ${failed ? 'ERROR' : 'ok'}`);

    const point: PausePoint = failed ? 'error' : 'after';
    const decision = await this.gate(
      point,
      entry.node,
      `${entry.method} #${String(frame.id)}`,
      toolGateOptions(
        this.session,
        () => this.toolEdit(entry),
        entry.node.kind === 'tool' ? { result: output } : undefined,
      ),
    );

    if (decision.action === 'retry') {
      // Re-send the request bytes down the same path the request took — the
      // original bytes, or the rewritten ones once an edit was accepted
      // (retry + input rewrites them now). The node stays open (same
      // instanceId) and closes on the new answer.
      const edited = editedArgs(decision);
      if (edited !== undefined) this.applyEditedArguments(entry, edited.args);
      entry.retries += 1;
      this.remember(entry);
      await this.options.sinkFor(entry.origin).writeFrame(entry.raw);
      this.trace(direction, `retry #${entry.retries} of ${entry.method} re-sent`);
      return { kind: 'drop' };
    }
    if (decision.action === 'inject') {
      const output = this.forWire(
        entry.method,
        coerceInjectedFor(entry.method, entry.params, decision.output),
      );
      this.finish(entry, output, 'ok', { injected: true, gatedAt: point });
      return { kind: 'replace', raw: injectedResponse(frame.id, output) };
    }
    if (decision.action === 'abort') {
      const message = `${entry.method} aborted by the GraphMind debugger`;
      this.finish(entry, undefined, 'aborted', { gatedAt: point });
      return { kind: 'replace', raw: errorResponse(frame.id, GRAPHMIND_ABORTED_CODE, message) };
    }
    this.finish(entry, output, failed ? 'error' : 'ok');
    return FORWARD;
  }

  /**
   * Batches are relayed untouched, but every element still becomes a node so
   * the graph does not silently lose half a conversation.
   */
  private observeBatch(direction: Direction, frame: Extract<ClassifiedFrame, { kind: 'batch' }>): void {
    for (const item of frame.items) {
      if (item.kind === 'request') {
        const node = mapMethod(item.method, item.params, direction);
        const entry: PendingRequest = {
          node,
          instanceId: this.nextInstanceId(),
          method: item.method,
          origin: direction,
          id: item.id,
          startedAt: this.now(),
          raw:
            encodeFrame({
              jsonrpc: '2.0',
              id: item.id,
              method: item.method,
              params: item.params,
            }) ?? Buffer.alloc(0),
          params: item.params,
          retries: 0,
        };
        this.start(entry, item.params, { batched: true });
        this.remember(entry);
      } else if (item.kind === 'notification') {
        const node = mapMethod(item.method, item.params, direction);
        const instanceId = this.nextInstanceId();
        this.parentReady(node);
        this.session.emit('node.started', {
          nodeId: node.nodeId,
          parentId: node.parentId,
          kind: node.kind,
          name: node.name,
          instanceId,
          input: item.params,
          method: item.method,
          notification: true,
          batched: true,
        });
        this.session.emit('node.finished', {
          nodeId: node.nodeId,
          instanceId,
          output: undefined,
          durationMs: 0,
          status: 'ok',
          batched: true,
        });
      } else if (item.kind === 'response') {
        const entry = this.pending.get(pendingKey(otherSide(direction), item.id));
        if (entry === undefined) {
          this.unmatchedResponses += 1;
          continue;
        }
        this.pending.delete(pendingKey(otherSide(direction), item.id));
        const failed = item.error !== undefined || isErrorResult(item.result);
        if (failed) this.recordError(entry, describeFailure(entry.method, item.error, item.result, this.hidesResultOf(entry.method)));
        this.finish(
          entry,
          item.error !== undefined ? { error: item.error } : item.result,
          failed ? 'error' : 'ok',
          { batched: true },
        );
      }
    }
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Make sure a node's parent exists on the graph before the node does. Work
   * hangs off the session node (always there); protocol traffic hangs off
   * `mcp:protocol`, created on first use.
   */
  private parentReady(node: MappedNode): void {
    if (node.parentId !== PROTOCOL_NODE_ID) return;
    this.protocolCalls += 1;
    this.ensureProtocolNode();
  }

  private ensureProtocolNode(): void {
    if (this.protocolStartedAt !== undefined) return;
    this.protocolStartedAt = this.now();
    this.session.emit('node.started', {
      nodeId: PROTOCOL_NODE_ID,
      parentId: SESSION_NODE_ID,
      kind: 'custom',
      name: PROTOCOL_NODE_NAME,
      instanceId: PROTOCOL_NODE_ID,
      input: {
        about:
          'MCP protocol traffic (handshake, discovery, keepalive, notifications); ' +
          'tools/call, resources/read, prompts/get and sampling sit on the session node',
      },
      collapsed: true,
    });
  }

  private start(entry: PendingRequest, params: unknown, extra?: Record<string, unknown>): void {
    this.parentReady(entry.node);
    this.session.emit('node.started', {
      nodeId: entry.node.nodeId,
      parentId: entry.node.parentId,
      kind: entry.node.kind,
      name: entry.node.name,
      instanceId: entry.instanceId,
      input: params,
      method: entry.method,
      direction: directionLabel(entry.origin),
      jsonrpcId: entry.id,
      ...extra,
    });
  }

  private recordError(entry: PendingRequest, error: { name: string; message: string }): void {
    if (entry.node.parentId === PROTOCOL_NODE_ID) this.protocolErrors += 1;
    this.session.emit('node.error', {
      nodeId: entry.node.nodeId,
      instanceId: entry.instanceId,
      error,
    });
  }

  private finish(
    entry: PendingRequest,
    output: unknown,
    status: RunStatus,
    extra?: Record<string, unknown>,
  ): void {
    this.session.emit('node.finished', {
      nodeId: entry.node.nodeId,
      instanceId: entry.instanceId,
      output,
      durationMs: durationBetween(entry.startedAt, this.now()),
      status,
      method: entry.method,
      ...(entry.retries > 0 ? { retries: entry.retries } : {}),
      ...extra,
    });
  }

  private emitSessionError(name: string, message: string): void {
    this.session.emit('node.error', {
      nodeId: SESSION_NODE_ID,
      instanceId: SESSION_NODE_ID,
      error: { name, message },
    });
  }

  /**
   * The server exited before its first response. Print the reason with the
   * stderr tail, and put both on the session node.
   */
  private reportEarlyDeath(reason: string): void {
    this.earlyDeathReported = true;
    this.earlyDeathReason = reason;
    const captured = this.options.stderrCaptured !== false;
    const tail = this.stderrRing.tail();
    const head = `${reason} before answering anything`;
    let detail: string;
    if (!captured) {
      detail = 'its stderr was inherited (--inherit-stderr), so look above for the reason';
    } else if (tail.length === 0) {
      detail = 'it wrote nothing to stderr';
    } else {
      const shown = tail.slice(Math.max(0, tail.length - STDERR_TAIL_ON_TERMINAL));
      const omitted = this.stderrRing.seen - shown.length;
      detail =
        `its last stderr output was${omitted > 0 ? ` (${omitted} earlier line(s) omitted here; the last ${tail.length} are on the session node)` : ''}:\n` +
        shown.map((line) => `    ${line}`).join('\n');
    }
    this.options.log(`graphmind mcp-proxy: ${head} — ${detail}`);
    const onNode = captured && tail.length > 0 ? `\n\nlast stderr output:\n${tail.join('\n')}` : '';
    this.emitSessionError('McpServerExitedEarly', `${head}${onNode}`);
  }

  private remember(entry: PendingRequest): void {
    if (this.pending.size >= MAX_PENDING) {
      // Pathological peer (or a server that answers nothing). Keep the newest
      // and let the oldest go rather than growing without bound.
      const oldest = this.pending.keys().next();
      if (oldest.done !== true) this.pending.delete(oldest.value);
    }
    this.pending.set(pendingKey(entry.origin, entry.id), entry);
  }

  // -- edited tool arguments (contract C2) -----------------------------------

  /**
   * How a held request can take edited arguments: a client->server
   * `tools/call` whose `arguments` are an object (or absent — a call that
   * forgot its arguments can be given them).
   *
   * The edit arrives in the shape of the node's recorded input, which for the
   * proxy is the request's whole `params` — `{name, arguments, _meta}` — so
   * the viewer's before/after diff lines up with `node.started.input`. Only
   * `arguments` may change: any other key must be absent or equal to what
   * the client sent (`name` and `_meta` are locked), else the edit is refused
   * (`shape`). The proposed `arguments` are merged into the live ones
   * (`mergeToolInput`: top-level argument keys replace, the rest keep their
   * live values), then checked against the tool's `inputSchema` from the last
   * `tools/list`, read when the edit arrives; without one the merged
   * arguments are relayed as they are and the server judges them. The
   * verdict — and `exec.resumed.edited.after` — is the effective `params`.
   */
  private toolEdit(entry: PendingRequest): ToolEdit | undefined {
    if (entry.method !== 'tools/call' || entry.node.kind !== 'tool') return undefined;
    const params = entry.params;
    if (!isFrameObject(params) || !isEditableToolInput(params['arguments'])) return undefined;
    const name = params['name'];
    return {
      args: params,
      // `merged` is `{...params, ...proposed}` (see toolArgsValidator).
      check: (merged, context) => {
        const proposed = merged as Record<string, unknown>;
        const hidden = context?.inputHidden === true;
        for (const key of Object.keys(proposed)) {
          if (key === 'arguments') continue;
          // Under a HIDE switch the recorded params are hidden too: comparing
          // an edit's `_meta` (or any key) with the live value would answer
          // "equal or not" for a hidden value, one guess per edit. Refuse any
          // key but `arguments` without looking at the live one.
          if (hidden) {
            return {
              ok: false,
              code: 'shape',
              message: "the input is hidden: send only the tool's arguments, as a full replacement",
            };
          }
          if (canonicalize(proposed[key]) !== canonicalize(params[key])) {
            return {
              ok: false,
              code: 'shape',
              message: `only the tool's arguments can be edited; ${JSON.stringify(key.slice(0, 48))} must stay as the client sent it`,
            };
          }
        }
        const args = mergeToolInput(params['arguments'], proposed['arguments'], context);
        if (!args.ok) return args;
        const effective = (value: unknown): InputValidation => ({ ok: true, value: { ...params, arguments: value } });
        const schema = typeof name === 'string' ? this.toolSchemas.get(name) : undefined;
        if (schema === undefined) return effective(args.value);
        const verdict = jsonSchemaLiteCheck(schema)(args.value) as InputValidation;
        return verdict.ok ? effective(verdict.value) : verdict;
      },
    };
  }

  /**
   * Rewrite the request's `params.arguments` to those of `edited` (the
   * validated effective params, see `toolEdit`): the frame is parsed from its
   * exact bytes, only `arguments` is replaced — the id, `name`, `_meta` and
   * every other key keep their values and order — and it is re-serialized.
   * `entry.raw` / `entry.params` become the edited request, so a later retry
   * re-sends what last ran. False (nothing changed, one line on stderr) if the
   * frame cannot be rewritten, which a request the proxy already parsed and
   * an edit the session already serialized never produce.
   */
  private applyEditedArguments(entry: PendingRequest, edited: unknown): boolean {
    const message = parseFrame(entry.raw);
    const params = isFrameObject(message) ? message['params'] : undefined;
    const args = isFrameObject(edited) ? edited['arguments'] : undefined;
    const nextParams = { ...(isFrameObject(params) ? params : {}), arguments: args };
    const raw = isFrameObject(message) ? encodeFrame({ ...message, params: nextParams }) : undefined;
    if (raw === undefined) {
      this.options.log(
        `graphmind mcp-proxy: could not rewrite ${entry.method} #${String(entry.id)} with the edited arguments; ` +
          'relaying the request as the client sent it',
      );
      return false;
    }
    entry.raw = raw;
    entry.params = nextParams;
    return true;
  }

  /** Remember each tool's `inputSchema` from a successful client->server `tools/list`. */
  private rememberToolSchemas(entry: PendingRequest, result: unknown, error: JsonRpcErrorBody | undefined): void {
    if (entry.method !== 'tools/list' || entry.origin !== 'client-to-server' || error !== undefined) return;
    if (!isFrameObject(result) || !Array.isArray(result['tools'])) return;
    for (const tool of result['tools'] as unknown[]) {
      if (!isFrameObject(tool) || typeof tool['name'] !== 'string') continue;
      const schema = tool['inputSchema'];
      if (!isFrameObject(schema)) {
        this.toolSchemas.delete(tool['name']);
        continue;
      }
      if (!this.toolSchemas.has(tool['name']) && this.toolSchemas.size >= MAX_TOOL_SCHEMAS) continue;
      this.toolSchemas.set(tool['name'], schema);
    }
  }

  private async replyTo(direction: Direction, raw: Buffer): Promise<void> {
    await this.options.sinkFor(otherSide(direction)).writeFrame(raw);
  }

  private nextInstanceId(): string {
    this.instanceCounter += 1;
    return `mcp_${this.instanceCounter}`;
  }

  /** Record the negotiated protocol version from the `initialize` result. */
  /** Whether the session hides this method's result (and so must its error text). */
  private hidesResultOf(method: string): boolean {
    return this.options.hideOutputs === true || (this.options.hideToolResults === true && method === 'tools/call');
  }

  /** Injected values must be shaped for the era the peers actually negotiated. */
  private forWire(method: string, value: unknown): unknown {
    return this.era === 'modern' ? stampModernEra(method, value) : value;
  }

  /**
   * Record the version the peers agreed on. Legacy: the `initialize` result.
   * Modern (2026-07-28): there is no initialize; a SUCCESSFUL `server/discover`
   * settles the era, and the version is the one the client claimed in its
   * request envelope (`params._meta['io.modelcontextprotocol/protocolVersion']`)
   * when the server lists it, else the server's first offer. A failed discover
   * (-32601 from a legacy-only server) records nothing, so the fallback
   * `initialize` still wins — the first answer settles it.
   */
  private rememberNegotiated(
    method: string,
    params: unknown,
    result: unknown,
    error: JsonRpcErrorBody | undefined,
  ): void {
    if (this.negotiated !== undefined || error !== undefined || !isFrameObject(result)) return;
    if (method === 'initialize') {
      const version = result['protocolVersion'];
      if (typeof version === 'string') {
        this.negotiated = version;
        this.era = 'legacy';
      }
      return;
    }
    if (method === 'server/discover' && Array.isArray(result['supportedVersions'])) {
      const offered = result['supportedVersions'].filter((v): v is string => typeof v === 'string');
      const meta =
        isFrameObject(params) && isFrameObject(params['_meta']) ? params['_meta'] : undefined;
      const claimed = meta?.['io.modelcontextprotocol/protocolVersion'];
      const version = typeof claimed === 'string' && offered.includes(claimed) ? claimed : offered[0];
      if (version !== undefined) {
        this.negotiated = version;
        this.era = 'modern';
      }
    }
  }

  private trace(direction: Direction, message: string): void {
    if (this.options.trace !== true) return;
    this.options.log(`[${directionLabel(direction)}] ${message}`);
  }
}

/** Only a JSON object can be a JSON-RPC frame. */
function isFrameObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toGateNode(node: MappedNode): GateNode {
  return { nodeId: node.nodeId, kind: node.kind, name: node.name };
}

function pendingKey(origin: Direction, id: JsonRpcId): string {
  return `${origin}|${idKey(id)}`;
}

/**
 * Both ways an MCP call can fail, described the same way: a JSON-RPC error
 * object, or a tool result carrying `isError: true`.
 */
/** Why a failed result's content is missing from its error message. */
const REDACTED_NOTE = 'GRAPHMIND_HIDE_TOOL_RESULTS or GRAPHMIND_HIDE_OUTPUTS';

function describeFailure(
  method: string,
  error: JsonRpcErrorBody | undefined,
  result: unknown,
  hideContent = false,
): { name: string; message: string } {
  if (error !== undefined) {
    return { name: `JsonRpcError(${error.code})`, message: error.message };
  }
  if (hideContent) {
    return {
      name: 'McpToolError',
      message: `${method} returned isError: true — content hidden (${REDACTED_NOTE})`,
    };
  }
  const content = (result as { content?: unknown } | null | undefined)?.content;
  let detail = '';
  try {
    detail = typeof content === 'string' ? content : JSON.stringify(content) ?? '';
  } catch {
    detail = '[unserializable content]';
  }
  return {
    name: 'McpToolError',
    message: `${method} returned isError: true${detail === '' ? '' : ` — ${detail.slice(0, 500)}`}`,
  };
}
