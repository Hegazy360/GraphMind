/**
 * Shared doubles for the control-plane suites: an app holding a gate that can
 * answer resumes the way a 0.6 client does (or ignore them the way an old one
 * ignores an unknown pause), and small HTTP helpers for the control routes.
 */
import { connect } from 'node:net';
import type { MessagePayloadMap } from '@graphmind-ai/schema';
import { FakeApp } from './helpers.js';

export const ALL_CAPABILITIES = ['pause', 'step', 'inject', 'retry', 'abort', 'run-claim', 'edit-input'];

export interface HeldAppOptions {
  runId?: string;
  pauseId?: string;
  nodeId?: string;
  point?: 'before' | 'after' | 'error';
  editable?: boolean;
  capabilities?: string[];
  /**
   * How the app answers an `exec.resume`: `echo` (0.6: exec.resumed with the
   * requestId), `legacy` (0.5: exec.resumed without it), `refuse` (exec.refused
   * with the requestId), `ignore` (an old client and an unknown pause id).
   */
  answer?: 'echo' | 'legacy' | 'refuse' | 'ignore';
  input?: unknown;
}

export interface HeldApp {
  app: FakeApp;
  runId: string;
  pauseId: string;
  /** Every exec.resume payload the app received, in order. */
  resumes: MessagePayloadMap['exec.resume'][];
  /** Hold another gate in the same run. */
  hold(pauseId: string, opts?: { editable?: boolean; point?: 'before' | 'after' | 'error' }): void;
  setAnswer(answer: NonNullable<HeldAppOptions['answer']>): void;
}

export async function heldApp(port: number, opts: HeldAppOptions = {}): Promise<HeldApp> {
  const runId = opts.runId ?? 'run-held';
  const pauseId = opts.pauseId ?? 'p1';
  const nodeId = opts.nodeId ?? 'tool:search';
  const app = await FakeApp.connect(port, {
    app: 'held-app',
    capabilities: opts.capabilities ?? ALL_CAPABILITIES,
  });
  let answer = opts.answer ?? 'echo';
  const resumes: MessagePayloadMap['exec.resume'][] = [];
  app.ws.on('message', (data) => {
    let frame: { type?: string; payload?: MessagePayloadMap['exec.resume'] };
    try {
      frame = JSON.parse(String(data)) as typeof frame;
    } catch {
      return;
    }
    if (frame.type !== 'exec.resume' || frame.payload === undefined) return;
    const payload = frame.payload;
    resumes.push(payload);
    if (answer === 'ignore') return;
    if (answer === 'refuse') {
      app.send('exec.refused', runId, {
        pauseId: payload.pauseId,
        code: 'schema',
        message: 'expected "query" to be a string',
        ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
      });
      return;
    }
    app.send('exec.resumed', runId, {
      pauseId: payload.pauseId,
      action: payload.action,
      ...(answer === 'echo' && payload.requestId !== undefined ? { requestId: payload.requestId } : {}),
      ...(answer === 'echo' && payload.input !== undefined ? { edited: { after: payload.input } } : {}),
    });
  });
  app.send('run.started', runId, { app: 'held-app', sdk: { name: 'test', version: '0.0.0' } });
  app.send('node.started', runId, {
    nodeId,
    kind: 'tool',
    name: nodeId.replace(/^tool:/, ''),
    instanceId: 'i1',
    input: opts.input ?? { query: 'lisbon' },
  });
  const hold = (id: string, extra: { editable?: boolean; point?: 'before' | 'after' | 'error' } = {}): void => {
    const editable = extra.editable ?? opts.editable;
    app.send('exec.paused', runId, {
      pauseId: id,
      nodeId,
      point: extra.point ?? opts.point ?? 'before',
      reason: 'breakpoint',
      ...(editable === undefined ? {} : { editable }),
    });
  };
  hold(pauseId);
  return {
    app,
    runId,
    pauseId,
    resumes,
    hold,
    setAnswer(next) {
      answer = next;
    },
  };
}

export interface HttpResult {
  status: number;
  body: any;
  headers: Headers;
}

export async function postResume(
  port: number,
  runId: string,
  pauseId: string,
  body: unknown,
  token: string | undefined,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/runs/${encodeURIComponent(runId)}/pauses/${encodeURIComponent(pauseId)}/resume`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  );
  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export async function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  let parsed: unknown = undefined;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One raw HTTP/1.1 request with exactly these headers (fetch filters Host, Origin, Cookie). */
export function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close');
      socket.write(`${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    let text = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0);
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      const parsedHeaders: Record<string, string> = {};
      for (const line of head.split('\r\n').slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) parsedHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status, headers: parsedHeaders, body: split === -1 ? '' : text.slice(split + 4) });
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
