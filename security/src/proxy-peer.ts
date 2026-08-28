/**
 * A hostile MCP client on one side of `graphmind mcp-proxy`, and a
 * byte-faithful echo server on the other.
 *
 * The proxy is the one place in GraphMind where **both** peers are untrusted:
 * it sits between somebody's coding agent and somebody else's MCP server,
 * relaying JSON-RPC it did not write and cannot validate. Its first contract
 * is not "observe correctly", it is *be invisible* —
 *
 *   > It relays the conversation byte-for-byte. With nothing armed, the server
 *   > sees exactly the bytes the client wrote and vice versa.
 *
 * — and the only way to test that claim is to write bytes no well-behaved peer
 * would, and compare what came out the far end with what went in. So the
 * fixture server here echoes its input verbatim: any mangling anywhere in the
 * proxy (framing, JSON round-tripping, `\r` handling, encoding) shows up as a
 * diff instead of as a subtle behaviour change nobody notices.
 *
 * The real shipped `dist/cli.js` is spawned as a child process, so this is
 * `graphmind mcp-proxy` exactly as a user's `mcpServers` config would run it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_ENTRY } from './harness.js';

/**
 * The fixture MCP "server": newline framing, and every frame is written back
 * byte-identical. Not a real MCP server — the proxy relays whatever it is
 * given, and a real server would normalise the bytes we are trying to watch.
 */
const ECHO_SERVER = `
const chunks = [];
process.stdin.on('data', (chunk) => {
  let buf = Buffer.concat([chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0), chunk]);
  chunks.length = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) break;
    process.stdout.write(Buffer.concat([buf.subarray(0, nl), Buffer.from('\\n')]));
    buf = buf.subarray(nl + 1);
  }
  if (buf.length > 0) chunks.push(buf);
});
process.stdin.on('end', () => process.exit(0));
`;

export interface ProxyPeerOptions {
  /** GraphMind server port to report to. Omit to point at a dead port. */
  port?: number;
  /** `--max-frame-bytes`. Minimum accepted by the CLI is 1024. */
  maxFrameBytes?: number;
}

export class ProxyPeer {
  /** Everything the proxy wrote to stdout — the protocol channel. */
  private readonly out: Buffer[] = [];
  readonly stderr: string[] = [];
  private exited = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly dir: string,
  ) {}

  static async start(options: ProxyPeerOptions = {}): Promise<ProxyPeer> {
    const dir = mkdtempSync(join(tmpdir(), 'graphmind-proxy-'));
    const serverPath = join(dir, 'echo-server.mjs');
    writeFileSync(serverPath, ECHO_SERVER);

    const args = [CLI_ENTRY, 'mcp-proxy'];
    // A dead port when none is given: the fail-open contract says the pipe
    // works whether or not GraphMind is up, and both halves are tested.
    args.push('--port', String(options.port ?? 1));
    if (options.maxFrameBytes !== undefined) {
      args.push('--max-frame-bytes', String(options.maxFrameBytes));
    }
    args.push('--', process.execPath, serverPath);

    const child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GRAPHMIND_TELEMETRY: '0', CI: '1' },
    }) as ChildProcessWithoutNullStreams;

    const peer = new ProxyPeer(child, dir);
    child.stdout.on('data', (chunk: Buffer) => peer.out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => peer.stderr.push(String(chunk)));
    child.on('exit', () => {
      peer.exited = true;
    });
    // The proxy prints two banner lines to stderr before it is wired up.
    await peer.waitFor(() => peer.stderr.join('').includes('mcp-proxy'), 15_000, 'the proxy banner');
    return peer;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Raw bytes the client (this process) has received so far. */
  stdout(): Buffer {
    return Buffer.concat(this.out);
  }

  /** Write raw bytes to the proxy's stdin, exactly as given. */
  write(data: Buffer | string): void {
    this.child.stdin.write(data);
  }

  /** Write one newline-terminated frame. */
  frame(text: string): void {
    this.write(`${text}\n`);
  }

  async waitFor(
    predicate: () => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
  }

  /** Wait until the client has received at least `bytes` bytes on stdout. */
  async waitForBytes(bytes: number, timeoutMs = 30_000): Promise<void> {
    await this.waitFor(
      () => this.stdout().length >= bytes,
      timeoutMs,
      `${bytes} bytes back from the proxy (have ${this.stdout().length})`,
    );
  }

  async close(): Promise<void> {
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      if (this.exited) return resolve();
      this.child.once('exit', () => resolve());
      setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, 8_000).unref();
    });
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
