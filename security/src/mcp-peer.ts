/**
 * A real MCP server, instrumented by `@graphmind-ai/mcp`, driven by a real MCP
 * client over the SDK's in-memory transport pair — with a real GraphMind
 * server on the other side.
 *
 * The point of the seam: `gm.wrapServer()` puts GraphMind *inside* the
 * request, between the SDK's routing/validation and the host's handler body.
 * Everything a hostile MCP client sends — tool arguments, resource URIs,
 * prompt arguments — therefore becomes a GraphMind envelope, and everything
 * the host returns is recorded and can be *replaced* by the debugger with
 * `inject`. Three untrusted-ish inputs meet in one place:
 *
 *   1. the client's request arguments (untrusted: another vendor's agent),
 *   2. the host's result (semi-trusted: it can still be enormous or cyclic),
 *   3. the debugger's injected value (the operator, but typed by hand).
 *
 * The non-negotiable invariants are the adapter's own: it must never throw
 * into the host server, and it must never emit something that breaks the
 * GraphMind server or the viewer.
 *
 * Nothing here is mocked. `@graphmind-ai/mcp` is imported through its
 * published entry point, like every other package this suite audits.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { graphmind, type Graphmind } from '@graphmind-ai/mcp';
import { z } from 'zod';
import type { WireServer } from './wire.js';

/** How the tool under test should behave on a given call. */
export interface EchoBehaviour {
  /** Returned verbatim as the tool's structured result. Default: the args. */
  result?: unknown;
  /** Throw instead of returning. */
  throws?: Error;
}

export interface McpPeer {
  readonly client: Client;
  readonly gm: Graphmind;
  /** Errors GraphMind let escape into the host handler. Must stay empty. */
  readonly hostErrors: unknown[];
  /** One entry per time the host handler body actually ran. */
  readonly handlerCalls: unknown[];
  /** What the next tool call should do. */
  behaviour: EchoBehaviour;
  close(): Promise<void>;
}

/**
 * Build the pair. The tool's input schema is `{ payload: z.any() }` on
 * purpose: the SDK validates arguments before GraphMind sees them, so a
 * permissive schema is the only way to get hostile values as far as the
 * adapter — which is the boundary under test.
 */
export async function startMcpPeer(server: WireServer): Promise<McpPeer> {
  const hostErrors: unknown[] = [];
  const handlerCalls: unknown[] = [];
  const peer: { behaviour: EchoBehaviour } = { behaviour: {} };

  const gm = graphmind({
    url: server.ingestUrl,
    app: 'mcp-under-audit',
    waitForAttach: 3_000,
    logger: () => {
      /* the adapter's own warnings are not the subject here */
    },
  });

  const mcp = gm.wrapServer(new McpServer({ name: 'audited-server', version: '0.0.0' }));

  mcp.registerTool(
    'echo',
    { description: 'returns whatever it is given', inputSchema: { payload: z.any() } },
    (args: { payload?: unknown }) => {
      try {
        handlerCalls.push(args?.payload);
        if (peer.behaviour.throws !== undefined) throw peer.behaviour.throws;
        const value = 'result' in peer.behaviour ? peer.behaviour.result : args?.payload;
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) ?? 'null' }] };
      } catch (error) {
        // A throw here is the host's own (peer.behaviour.throws). Anything
        // *else* that lands here came out of GraphMind, which would be a
        // fail-open violation — so it is recorded, then rethrown so the SDK
        // still turns it into a normal tool error for the client.
        if (error !== peer.behaviour.throws) hostErrors.push(error);
        throw error;
      }
    },
  );

  mcp.registerPrompt(
    'greet',
    { description: 'a prompt', argsSchema: { who: z.string() } },
    (args: { who: string }) => ({
      messages: [
        { role: 'user' as const, content: { type: 'text' as const, text: `hello ${args.who}` } },
      ],
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);

  const client = new Client({ name: 'hostile-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    gm,
    hostErrors,
    handlerCalls,
    get behaviour(): EchoBehaviour {
      return peer.behaviour;
    },
    set behaviour(value: EchoBehaviour) {
      peer.behaviour = value;
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch {
        /* best effort */
      }
      try {
        await mcp.close();
      } catch {
        /* best effort */
      }
      await gm.dispose();
    },
  };
}
