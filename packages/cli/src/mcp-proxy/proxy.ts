/**
 * `graphmind mcp-proxy` — a transparent man-in-the-middle for an MCP server.
 *
 *   MCP client  --stdio-->  [ proxy ]  --stdio-->  real MCP server (any language)
 *                               |
 *                               +--ws--> GraphMind (live graph + gates)
 *
 * The proxy owns four streams and one child process. Its contract, in order
 * of importance:
 *
 *  1. It relays the conversation byte-for-byte. With nothing armed, the
 *     server sees exactly the bytes the client wrote and vice versa.
 *  2. It never breaks the session. If GraphMind is not running, if the
 *     WebSocket dies mid-hold, if the observer throws, if a payload is too
 *     big to frame — the pipe keeps working. (`@graphmind-ai/client` supplies
 *     the fail-open half of that; this file supplies the rest.)
 *  3. stdout is the protocol channel and carries nothing else. Every human
 *     word this command says goes to stderr, and the server's own stderr is
 *     passed through unmodified.
 */
import { AsyncResource } from 'node:async_hooks';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { createSession, type Session, type SessionOptions } from '@graphmind-ai/client';
import { commandLabel, type Direction } from './mapping.js';
import { FrameRelay } from './relay.js';
import { ProxyReporter } from './reporter.js';
import { FrameWriter } from './writer.js';
import { VERSION } from '../version.js';

/** Frame-assembly ceiling. Above this the relay degrades to a raw byte pipe. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** How long the server gets to exit after the client hangs up, before SIGTERM. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** ...and after SIGTERM, before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** `--wait-for-attach` budget. */
export const ATTACH_WAIT_MS = 3_000;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface McpProxyOptions {
  command: string;
  args: readonly string[];
  /** Frames from the MCP client (normally process.stdin). */
  clientIn: Readable;
  /** Frames back to the MCP client (normally process.stdout). NOTHING else. */
  clientOut: Writable;
  /** Where the server's stderr is mirrored (normally process.stderr). */
  clientErr: Writable;
  /** Human-facing diagnostics sink. Defaults to a stderr writer. */
  log?: (line: string) => void;
  /** Reuse an existing session (tests); otherwise one is created. */
  session?: Session;
  sessionOptions?: SessionOptions;
  /** Injectable spawner (tests). */
  spawnFn?: typeof spawn;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxFrameBytes?: number;
  trace?: boolean;
  /**
   * Pipe the child's stderr through us (default) so it can also be streamed
   * onto the session node, or `false` to hand it the real fd with `inherit`
   * — which keeps isatty(2) honest for servers that colour their logs.
   */
  captureStderr?: boolean;
  /** Block the first frame until the debugger attaches (or times out). */
  waitForAttach?: boolean;
  /** Viewer address, quoted on stderr when a gate holds. */
  viewerUrl?: string;
  /** Install SIGINT/SIGTERM forwarding. Off in tests. */
  handleSignals?: boolean;
  /**
   * Grace period after the client hangs up before the server is asked to
   * stop, and again before it is killed. Exposed for tests; a well-behaved
   * MCP server exits on stdin EOF long before either fires.
   */
  shutdownGraceMs?: number;
  killGraceMs?: number;
  now?: () => number;
}

export interface McpProxyHandle {
  readonly child: ChildProcess;
  readonly reporter: ProxyReporter;
  readonly session: Session;
  /** Resolves with the process exit code once everything has drained. */
  done: Promise<number>;
  /** Terminate the child (used by signal handlers and tests). */
  stop(signal?: NodeJS.Signals): void;
}

/** A Readable that is already at EOF. */
function closedReadable(): Readable {
  const stream = new PassThrough();
  stream.end();
  return stream;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = (osConstants.signals as Record<string, number | undefined>)[signal];
  return typeof number === 'number' ? 128 + number : 1;
}

export function exitCodeFor(info: ExitInfo): number {
  if (info.signal !== null) return signalExitCode(info.signal);
  return info.code ?? 0;
}

export function startMcpProxy(options: McpProxyOptions): McpProxyHandle {
  const log = options.log ?? ((line: string) => void options.clientErr.write(`${line}\n`));
  const captureStderr = options.captureStderr !== false;
  const spawnFn = options.spawnFn ?? spawn;
  const label = commandLabel(options.command, options.args);

  const session =
    options.session ??
    createSession({
      appName: label,
      // The SDK badge in the viewer names what produced the run. 'stdio' is a
      // transport, not a version; the transport is reported in `meta` below.
      sdk: { name: 'mcp-proxy', version: VERSION },
      meta: { transport: 'stdio', command: options.command, args: [...options.args] },
      ...options.sessionOptions,
    });

  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'inherit'],
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };

  const child = spawnFn(options.command, [...options.args], spawnOptions);

  // A spawn that fails (ENOENT) can leave the stdio handles null. Substitute
  // inert streams so the pipeline still builds and still shuts down cleanly.
  const childStdin: Writable = child.stdin ?? new PassThrough();
  const childStdout: Readable = child.stdout ?? closedReadable();

  let settleExit: (info: ExitInfo) => void = () => {};
  const exited = new Promise<ExitInfo>((resolve) => {
    settleExit = resolve;
  });
  let exitSettled = false;
  const settleOnce = (info: ExitInfo): void => {
    if (exitSettled) return;
    exitSettled = true;
    settleExit(info);
  };

  child.on('close', (code, signal) => settleOnce({ code, signal }));
  child.on('error', (error) => {
    // ENOENT and friends: the command does not exist. Say so clearly — this
    // is by far the most common way a wrapped MCP config is wrong.
    log(`graphmind mcp-proxy: cannot run "${options.command}": ${error.message}`);
    settleOnce({ code: 127, signal: null });
  });

  const toServer = new FrameWriter(childStdin, (error) =>
    log(`graphmind mcp-proxy: the server stopped reading its stdin (${error.message})`),
  );
  const toClient = new FrameWriter(options.clientOut, (error) =>
    log(`graphmind mcp-proxy: the MCP client closed the pipe (${error.message})`),
  );
  const sinkFor = (direction: Direction): FrameWriter =>
    direction === 'client-to-server' ? toServer : toClient;

  const reporter = new ProxyReporter({
    session,
    command: options.command,
    args: options.args,
    sinkFor,
    log,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.viewerUrl === undefined ? {} : { viewerUrl: options.viewerUrl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const degradeWarning = (side: string) => (pendingBytes: number) => {
    log(
      `graphmind mcp-proxy: a ${side} frame exceeded ${maxFrameBytes} bytes ` +
        `(${pendingBytes} buffered); relaying raw from here on — the graph will ` +
        'stop updating but the session keeps working (raise --max-frame-bytes)',
    );
  };
  const interceptFailed = (side: string) => (error: unknown) => {
    log(
      `graphmind mcp-proxy: internal error observing a ${side} frame; relayed unchanged ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  };

  // `ready()` is awaited BEFORE the run opens, not inside it: every listener
  // below has to be registered in one synchronous block so that it — and
  // everything it schedules — inherits the run's AsyncLocalStorage context.
  // An `await` in the middle would leave the stderr observer emitting into an
  // anonymous implicit run instead of this one.
  const attached =
    options.waitForAttach === true ? session.ready({ timeoutMs: ATTACH_WAIT_MS }) : undefined;

  const done = (attached ?? Promise.resolve(false))
    .then(() =>
      session.run(`mcp-proxy: ${label}`, async () => {
        reporter.sessionStarted();

        // Stream events must be attributed to THIS run, and an `emitter.on`
        // callback does not inherit the AsyncLocalStorage context it was
        // registered in — it runs in whatever context emitted the event (for
        // a child's stdout, the context that called spawn). Everything that
        // reaches `reporter` from a listener is therefore bound to the run's
        // context explicitly; without this the whole conversation lands in an
        // anonymous "implicit" run beside the real one.
        const inRun = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) =>
          AsyncResource.bind(fn);

        // The server's stderr is the one channel it can legitimately log to.
        // Mirror it byte-for-byte first, then (only then) show it to the
        // debugger. Nothing is lost while we were waiting to attach: the pipe
        // stays paused until this listener exists.
        if (captureStderr && child.stderr !== null) {
          child.stderr.on(
            'data',
            inRun((chunk: Buffer) => {
              try {
                options.clientErr.write(chunk);
              } catch {
                // a closed stderr must not take the session down
              }
              reporter.noteStderr(chunk);
            }),
          );
          child.stderr.on('error', () => {});
        }

        const clientRelay = new FrameRelay({
          source: options.clientIn,
          sink: toServer,
          intercept: inRun((raw: Buffer) => reporter.handleFrame('client-to-server', raw)),
          maxFrameBytes,
          onDegrade: degradeWarning('client'),
          onInterceptError: interceptFailed('client'),
        });
        const serverRelay = new FrameRelay({
          source: childStdout,
          sink: toClient,
          intercept: inRun((raw: Buffer) => reporter.handleFrame('server-to-client', raw)),
          maxFrameBytes,
          onDegrade: degradeWarning('server'),
          onInterceptError: interceptFailed('server'),
        });

        // The client hung up: pass the EOF on, then make sure we do not become
        // a zombie holding a server nobody is talking to.
        void clientRelay.whenFinished().then(() => {
          void toServer.end();
          armShutdown();
        });

        const info = await exited;
        // The child is gone, but its last frames may still be in flight.
        await serverRelay.whenFinished();
        await toClient.drained();
        reporter.sessionFinished(info);
        return info;
      }),
    )
    .then(
      async (info) => {
        for (const line of reporter.summary()) log(`graphmind mcp-proxy: ${line}`);
        await session.dispose();
        return exitCodeFor(info);
      },
      async (error) => {
        log(
          `graphmind mcp-proxy: unexpected internal failure (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        await session.dispose().catch(() => {});
        return 1;
      },
    );

  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  function armShutdown(): void {
    if (shutdownTimer !== undefined || exitSettled) return;
    shutdownTimer = setTimeout(() => {
      if (exitSettled) return;
      log('graphmind mcp-proxy: client disconnected; asking the server to stop');
      stop('SIGTERM');
      const killer = setTimeout(() => {
        if (!exitSettled) stop('SIGKILL');
      }, options.killGraceMs ?? KILL_GRACE_MS);
      killer.unref?.();
    }, options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
    shutdownTimer.unref?.();
  }

  function stop(signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }

  if (options.handleSignals === true) {
    const forward = (signal: NodeJS.Signals) => () => stop(signal);
    process.once('SIGINT', forward('SIGINT'));
    process.once('SIGTERM', forward('SIGTERM'));
  }

  void exited.then(() => {
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
  });

  return { child, reporter, session, done, stop };
}
