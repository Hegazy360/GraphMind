/**
 * Full-stack smoke test: real adapter -> real @graphmind-ai/client transport ->
 * real graphmind-ai CLI server -> real UI-socket protocol -> control relay
 * back into the running agent.
 *
 * Scenario: a two-step mock agent calls convertCurrency, which always throws.
 * A headless "debugger" speaking the viewer protocol receives exec.paused,
 * injects a corrected result, and the agent's final answer must contain it.
 *
 * Requires a graphmind-ai server on 127.0.0.1:4747 (override GM_HTTP/GM_WS).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { simulateReadableStream, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { graphmind } from '@graphmind-ai/sdk';
import { PROTOCOL_VERSION } from '@graphmind-ai/schema';

const HTTP = process.env.GM_HTTP ?? 'http://127.0.0.1:4747';
const WS_UI = process.env.GM_WS ?? 'ws://127.0.0.1:4747/ws/ui';
const INJECTED = { amount: 100, converted: 91.3, currency: 'USD', note: 'INJECTED_BY_DEBUGGER' };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ---------- headless debugger (speaks the CLI's UI subprotocol) ----------
interface DebuggerLog {
  sawRunUpdate: boolean;
  sawReplayStart: boolean;
  pausedEnvelope: { runId: string; payload: { pauseId: string; nodeId: string; point: string } } | null;
  injectedForPause: string | null;
}

function startHeadlessDebugger(): { log: DebuggerLog; close: () => void; ready: Promise<void> } {
  const log: DebuggerLog = { sawRunUpdate: false, sawReplayStart: false, pausedEnvelope: null, injectedForPause: null };
  const socket = new WebSocket(WS_UI);
  const subscribed = new Set<string>();
  let seq = 0;
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));

  const ready = new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      send({ type: 'subscribe', runId: '*' });
      resolve();
    });
    socket.once('error', reject);
  });

  socket.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, any>;
    if (frame.type === 'runs' || frame.type === 'run.update') {
      const runs = frame.type === 'runs' ? frame.runs : [frame.run];
      for (const run of runs) {
        if (run && !subscribed.has(run.id)) {
          subscribed.add(run.id);
          send({ type: 'subscribe', runId: run.id });
          log.sawRunUpdate = true;
        }
      }
    }
    if (frame.type === 'replay.start') log.sawReplayStart = true;
    if (frame.type === 'event' && frame.envelope?.type === 'exec.paused') {
      const env = frame.envelope;
      log.pausedEnvelope = { runId: env.runId, payload: env.payload };
      // The hero moment: inject a corrected tool result into the paused run.
      send({
        type: 'control',
        envelope: {
          gm: PROTOCOL_VERSION,
          seq: seq++,
          ts: Date.now(),
          runId: env.runId,
          type: 'exec.resume',
          payload: { pauseId: env.payload.pauseId, action: 'inject', output: INJECTED },
        },
      });
      log.injectedForPause = env.payload.pauseId;
    }
  });

  return { log, close: () => socket.close(), ready };
}

// ---------- the instrumented agent (mock model, planted bug) ----------
const usage = { inputTokens: 12, outputTokens: 9, totalTokens: 21 };
const finish = (unified: 'stop' | 'tool-calls') =>
  ({ type: 'finish', usage, finishReason: { unified, raw: unified } }) as const;

function makeMockModel(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async (options: any) => {
      const index = call++;
      let parts: any[];
      if (index === 0) {
        parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't0' },
          { type: 'text-delta', id: 't0', delta: 'Checking the exchange rate. ' },
          { type: 'text-end', id: 't0' },
          {
            type: 'tool-call',
            toolCallId: 'call-fx-1',
            toolName: 'convertCurrency',
            input: JSON.stringify({ amount: 100, from: 'EUR', to: 'USD' }),
          },
          finish('tool-calls'),
        ];
      } else {
        const results: unknown[] = [];
        for (const message of options.prompt) {
          if (message.role !== 'tool') continue;
          for (const part of message.content) {
            if (part.type === 'tool-result') {
              results.push(
                part.output?.type === 'json' || part.output?.type === 'error-json'
                  ? part.output.value
                  : part.output?.value ?? part.output,
              );
            }
          }
        }
        parts = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: `Budget check: ${JSON.stringify(results)}` },
          { type: 'text-end', id: 't1' },
          finish('stop'),
        ];
      }
      return {
        stream: simulateReadableStream({ chunks: parts, initialDelayInMs: 5, chunkDelayInMs: 2 }),
      };
    },
  });
}

async function main(): Promise<void> {
  const dbg = startHeadlessDebugger();
  await dbg.ready;

  const gm = graphmind({ app: 'e2e-smoke' });

  // Attach guarantee: force the lazy transport to connect and await the
  // handshake, so error gates are armed before the real scenario runs.
  const attached = await gm.ready();
  check('gm.ready() attached to CLI before scenario', attached && gm.session.attached);

  const readyAgain = Date.now();
  check(
    'gm.ready() after attach resolves true instantly',
    (await gm.ready()) && Date.now() - readyAgain < 50,
  );

  const model = gm.wrapModel(makeMockModel());
  const tools = gm.wrapTools({
    convertCurrency: tool({
      description: 'Convert an amount between currencies',
      inputSchema: z.object({ amount: z.number(), from: z.string(), to: z.string() }),
      execute: async () => {
        throw new Error('FX rate service returned HTTP 500');
      },
    }),
  });

  const result = await gm.run('e2e-run', async () => {
    const r = streamText({
      model,
      tools,
      prompt: 'Convert 100 EUR to USD and report.',
      stopWhen: stepCountIs(4),
      onError: () => {},
    });
    await r.consumeStream();
    return { text: await r.text };
  });

  await delay(500); // let final envelopes flush through the server
  gm.dispose();
  dbg.close();

  check('debugger saw the run announced', dbg.log.sawRunUpdate);
  check('replay-then-tail delivered', dbg.log.sawReplayStart);
  check(
    'pause-on-error reached the debugger',
    dbg.log.pausedEnvelope?.payload.point === 'error' &&
      dbg.log.pausedEnvelope.payload.nodeId === 'tool:convertCurrency',
    JSON.stringify(dbg.log.pausedEnvelope?.payload ?? null),
  );
  check('inject control was sent', dbg.log.injectedForPause !== null);
  check(
    'injected value reached the final answer',
    result.text.includes('INJECTED_BY_DEBUGGER'),
    result.text.slice(0, 120),
  );

  const runs = (await (await fetch(`${HTTP}/api/runs`)).json()) as { runs: any[] };
  const run = runs.runs.find((r) => r.app === 'e2e-smoke');
  check('server recorded the run', run !== undefined);
  check('run finished ok', run?.status === 'ok', `status=${run?.status}`);
  check('events persisted', (run?.eventCount ?? 0) >= 8, `eventCount=${run?.eventCount}`);

  console.log(failures === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('E2E crashed:', error);
  process.exit(1);
});
