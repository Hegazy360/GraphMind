/**
 * A mock LLM provider: a real HTTP server that speaks enough of the Anthropic
 * Messages API and the OpenAI Chat Completions API to drive a two-step
 * tool-calling agent.
 *
 * Why a real server rather than a stubbed client: the point of this audit is
 * what happens to credentials that live in the provider client's CONFIG — the
 * apiKey, the default headers, the baseURL. Those only become real when the
 * real SDK builds a real request from them. The mock records every request it
 * receives (URL, headers, body) so each test can first PROVE the canary was
 * genuinely on the wire, and only then assert that GraphMind did not record
 * it. Without that proof the "no leak" assertions would be vacuous.
 *
 * The responses deliberately carry hostile extras: an `_debug_echo` field
 * containing the caller's own Authorization header, exactly as a chatty
 * OpenAI-compatible gateway might. Adapters must field-pick the response, not
 * record it wholesale.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  /** The raw request target, including query string. */
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface MockProviderOptions {
  /** Text/args to script into the model's replies. */
  readonly toolArg: string;
  /** Fail every request with this HTTP status instead of answering. */
  readonly failWith?: number;
  /**
   * Make the error body echo the caller's own credential, the way some
   * OpenAI-compatible gateways do ("invalid api key: sk-..."). Used to
   * document a residual risk, not to test GraphMind's own behaviour.
   */
  readonly echoAuthInError?: boolean;
  /** Name of the tool the scripted model asks for. */
  readonly toolName?: string;
}

export class MockProvider {
  readonly requests: RecordedRequest[] = [];
  /** Every response body the mock sent, so tests can prove what came back. */
  readonly responses: string[] = [];

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private options: MockProviderOptions,
  ) {}

  static async start(options: MockProviderOptions): Promise<MockProvider> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const provider = new MockProvider(server, port, options);
    server.on('request', (req, res) => {
      void provider.handle(req, res);
    });
    return provider;
  }

  /** `http://127.0.0.1:<port>` — append your own path + query. */
  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  configure(options: Partial<MockProviderOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /** Write and log one response body. */
  private send(res: ServerResponse, body: string): void {
    this.responses.push(body);
    res.end(body);
  }

  /** Everything the mock ever sent back — for "the provider really said that" proofs. */
  responseText(): string {
    return this.responses.join('\n---\n');
  }

  /** Every header value the mock ever received, joined — for wire proofs. */
  wireText(): string {
    return this.requests
      .map((r) => `${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n${r.body}`)
      .join('\n---\n');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  // -- request handling -----------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
    this.requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body });

    const authValue = headers['authorization'] ?? headers['x-api-key'] ?? '';

    if (this.options.failWith !== undefined) {
      const status = this.options.failWith;
      res.writeHead(status, { 'content-type': 'application/json' });
      this.send(
        res,
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message:
              this.options.echoAuthInError === true
                ? `invalid credentials: ${authValue} (mock gateway)`
                : 'invalid credentials (mock provider)',
          },
        }),
      );
      return;
    }

    const path = new URL(req.url ?? '/', this.origin).pathname;
    const auth = authValue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (path.endsWith('/messages')) {
      this.respondAnthropic(res, parsed, auth);
      return;
    }
    if (path.endsWith('/chat/completions')) {
      this.respondOpenAi(res, parsed, auth);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    this.send(res, JSON.stringify({ error: { message: `mock provider: no route for ${path}` } }));
  }

  private get toolName(): string {
    return this.options.toolName ?? 'fetchCredential';
  }

  /** Second turn = an explicit step counter, or a tool result in the thread. */
  private isFinalTurn(body: Record<string, unknown>): boolean {
    if (typeof body['step'] === 'number') return body['step'] > 0;
    const text = JSON.stringify(body);
    return text.includes('tool_result') || text.includes('"tool"');
  }

  private respondAnthropic(
    res: ServerResponse,
    body: Record<string, unknown>,
    auth: string,
  ): void {
    const final = this.isFinalTurn(body);
    const message = final
      ? {
          id: 'msg_mock_final',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'Done — the credential was rotated.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 12 },
          // Hostile extra: a chatty gateway echoing the caller's own auth.
          _debug_echo: { authorization: auth },
        }
      : {
          id: 'msg_mock_tool',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [
            { type: 'text', text: 'Looking that up.' },
            {
              type: 'tool_use',
              id: 'toolu_mock_1',
              name: this.toolName,
              input: { vault: this.options.toolArg },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 10 },
          _debug_echo: { authorization: auth },
        };
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_mock_1' });
    this.send(res, JSON.stringify(message));
  }

  private respondOpenAi(res: ServerResponse, body: Record<string, unknown>, auth: string): void {
    const final = this.isFinalTurn(body);
    const completion = {
      id: 'chatcmpl_mock',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o-mini',
      choices: [
        final
          ? {
              index: 0,
              message: { role: 'assistant', content: 'Done — the credential was rotated.' },
              finish_reason: 'stop',
            }
          : {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Looking that up.',
                tool_calls: [
                  {
                    id: 'call_mock_1',
                    type: 'function',
                    function: {
                      name: this.toolName,
                      arguments: JSON.stringify({ vault: this.options.toolArg }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      // Hostile extra: a chatty gateway echoing the caller's own auth.
      _debug_echo: { authorization: auth },
    };
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_mock_1' });
    this.send(res, JSON.stringify(completion));
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
