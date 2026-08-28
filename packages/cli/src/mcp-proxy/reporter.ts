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
 * A request that never gets an answer keeps its node OPEN — that is a real
 * server bug and the graph has to show it. Only when the child process dies
 * do the still-open requests become errors, because then we know for a fact
 * no answer is coming.
 */
import {
  type GateDecision,
  type GateNode,
  type PausePoint,
  type RunStatus,
  type Session,
  type TokenDelta,
} from '@graphmind-ai/client';
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
  SESSION_NODE_ID,
  commandLabel,
  directionLabel,
  mapMethod,
  otherSide,
  type Direction,
  type MappedNode,
} from './mapping.js';
import { coerceInjectedFor } from './coerce.js';
import { FORWARD, type FrameAction } from './relay.js';

/** How the reporter reaches the two ends of the pipe. */
export interface FrameSink {
  writeFrame(raw: Buffer): Promise<void>;
}

export interface ReporterOptions {
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
  now?: () => number;
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

export class ProxyReporter {
  private readonly session: Session;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly label: string;
  private readonly now: () => number;
  private readonly stderrFlushMs: number;

  private instanceCounter = 0;
  private sessionStartedAt = 0;
  private sessionOpen = false;
  private unmatchedResponses = 0;
  private unparseableFrames = 0;
  private unansweredAtExit = 0;
  private negotiated: string | undefined;

  private stderrBuffer = '';
  private stderrTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ReporterOptions) {
    this.session = options.session;
    this.label = commandLabel(options.command, options.args);
    this.now = options.now ?? Date.now;
    this.stderrFlushMs = options.stderrFlushMs ?? 40;
  }

  /** Requests still waiting for an answer. */
  get outstanding(): number {
    return this.pending.size;
  }

  /** The protocol version the two peers agreed on, once `initialize` returns. */
  get negotiatedProtocolVersion(): string | undefined {
    return this.negotiated;
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
  }

  /**
   * The child is gone. Every request still in flight is now provably
   * unanswerable, so it stops being "still running" and becomes an error.
   */
  sessionFinished(exit: { code: number | null; signal: string | null }): void {
    this.flushStderr();
    if (this.stderrTimer !== undefined) clearTimeout(this.stderrTimer);
    const reason =
      exit.signal !== null
        ? `the MCP server was killed by ${exit.signal}`
        : `the MCP server exited with code ${exit.code ?? 0}`;
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
    const ok = exit.signal === null && (exit.code ?? 0) === 0;
    this.session.emit('node.finished', {
      nodeId: SESSION_NODE_ID,
      instanceId: SESSION_NODE_ID,
      output: { exitCode: exit.code, signal: exit.signal },
      durationMs: Math.max(0, this.now() - this.sessionStartedAt),
      status: ok ? 'ok' : 'error',
    });
  }

  /**
   * The MCP server's stderr — the one channel a stdio server can legitimately
   * log to. Streamed onto the session node as text deltas so the logs sit
   * next to the protocol they explain. The bytes the client sees are written
   * separately and are not touched by this.
   */
  noteStderr(chunk: Buffer): void {
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
          '(they are marked as errors on the graph)',
      );
    }
    if (this.unmatchedResponses > 0) {
      lines.push(`${this.unmatchedResponses} response(s) arrived with no matching request id`);
    }
    if (this.unparseableFrames > 0) {
      lines.push(`${this.unparseableFrames} frame(s) were not JSON-RPC (relayed verbatim)`);
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
    const value = parseFrame(raw);
    if (value === undefined) {
      this.unparseableFrames += 1;
      this.trace(direction, `non-JSON frame (${raw.length} bytes), relayed verbatim`);
      return FORWARD;
    }
    const frame = classify(value);
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
   * `session.gate`, plus a stderr notice if it actually holds. Every gate in
   * this file goes through here.
   */
  private async gate(point: PausePoint, node: MappedNode, label: string): Promise<GateDecision> {
    const decision = this.session.gate(point, toGateNode(node));
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
    const node = mapMethod(frame.method, frame.params);
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

    const decision = await this.gate('before', node, `${frame.method} #${String(frame.id)}`);
    if (decision.action === 'inject') {
      // Coerced into the result shape this method must answer with; see
      // coerce.ts. Without it, injecting `{"price":42}` at a `tools/call`
      // gate hands the host a tool result with no content and no error.
      const output = coerceInjectedFor(frame.method, frame.params, decision.output);
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
    this.remember(entry);
    return FORWARD;
  }

  private async onNotification(
    direction: Direction,
    _raw: Buffer,
    frame: Extract<ClassifiedFrame, { kind: 'notification' }>,
  ): Promise<FrameAction> {
    const node = mapMethod(frame.method, frame.params);
    const instanceId = this.nextInstanceId();
    const startedAt = this.now();
    this.session.emit('node.started', {
      nodeId: node.nodeId,
      parentId: SESSION_NODE_ID,
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
        durationMs: Math.max(0, this.now() - startedAt),
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
    this.rememberNegotiated(entry.method, frame.result);

    const failed = frame.error !== undefined || isErrorResult(frame.result);
    const output = frame.error !== undefined ? { error: frame.error } : frame.result;
    if (failed) {
      this.session.emit('node.error', {
        nodeId: entry.node.nodeId,
        instanceId: entry.instanceId,
        error: describeFailure(entry.method, frame.error, frame.result),
      });
    }
    this.trace(direction, `<- ${entry.method} #${String(frame.id)} ${failed ? 'ERROR' : 'ok'}`);

    const point: PausePoint = failed ? 'error' : 'after';
    const decision = await this.gate(point, entry.node, `${entry.method} #${String(frame.id)}`);

    if (decision.action === 'retry') {
      // Re-send the ORIGINAL bytes down the same path the request took. The
      // node stays open (same instanceId) and closes on the new answer.
      entry.retries += 1;
      this.remember(entry);
      await this.options.sinkFor(entry.origin).writeFrame(entry.raw);
      this.trace(direction, `retry #${entry.retries} of ${entry.method} re-sent`);
      return { kind: 'drop' };
    }
    if (decision.action === 'inject') {
      const output = coerceInjectedFor(entry.method, entry.params, decision.output);
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
        const node = mapMethod(item.method, item.params);
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
        const node = mapMethod(item.method, item.params);
        const instanceId = this.nextInstanceId();
        this.session.emit('node.started', {
          nodeId: node.nodeId,
          parentId: SESSION_NODE_ID,
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
        if (failed) {
          this.session.emit('node.error', {
            nodeId: entry.node.nodeId,
            instanceId: entry.instanceId,
            error: describeFailure(entry.method, item.error, item.result),
          });
        }
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

  private start(entry: PendingRequest, params: unknown, extra?: Record<string, unknown>): void {
    this.session.emit('node.started', {
      nodeId: entry.node.nodeId,
      parentId: SESSION_NODE_ID,
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
      durationMs: Math.max(0, this.now() - entry.startedAt),
      status,
      method: entry.method,
      ...(entry.retries > 0 ? { retries: entry.retries } : {}),
      ...extra,
    });
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

  private async replyTo(direction: Direction, raw: Buffer): Promise<void> {
    await this.options.sinkFor(otherSide(direction)).writeFrame(raw);
  }

  private nextInstanceId(): string {
    this.instanceCounter += 1;
    return `mcp_${this.instanceCounter}`;
  }

  /** Record the negotiated protocol version from the `initialize` result. */
  private rememberNegotiated(method: string, result: unknown): void {
    if (method !== 'initialize' || this.negotiated !== undefined) return;
    if (typeof result !== 'object' || result === null) return;
    const version = (result as Record<string, unknown>)['protocolVersion'];
    if (typeof version === 'string') this.negotiated = version;
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
function describeFailure(
  method: string,
  error: JsonRpcErrorBody | undefined,
  result: unknown,
): { name: string; message: string } {
  if (error !== undefined) {
    return { name: `JsonRpcError(${error.code})`, message: error.message };
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
