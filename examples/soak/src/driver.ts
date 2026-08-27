/**
 * Drives a planned workload through a real `@graphmind-ai/client` session
 * over a real WebSocket.
 *
 * Pacing matters and is measured, not assumed: `session.emit` is synchronous
 * and fire-and-forget, so a tight `for` loop never yields and every frame
 * piles up in the WebSocket's send queue instead of reaching the server. The
 * driver therefore hands the event loop back every `yieldEvery` events, and
 * reports both the wall time of the emit loop and the time the *server* took
 * to catch up — the gap between those two numbers is the queue.
 */
import { createSession, type Session, type SessionOptions } from '@graphmind-ai/client';
import type { PlannedEvent } from './workload.ts';
import { delay, tick } from './util.ts';

export interface DriveOptions {
  /** Yield to the event loop every N events. Default 64. */
  yieldEvery?: number;
  /** Cap emission at this many events per second. 0 = as fast as possible. */
  rate?: number;
  /** Called after every `yieldEvery` events with the index reached. */
  onProgress?: (index: number) => void;
}

export interface DriveResult {
  runId: string;
  sent: number;
  /** Wall time of the emit loop itself, ms. */
  emitMs: number;
  /** Total time inside `session.emit` calls, ms (client-side overhead). */
  inEmitMs: number;
  startedAt: number;
  finishedAt: number;
}

export function makeSession(url: string, options: Partial<SessionOptions> = {}): Session {
  return createSession({
    url,
    appName: 'soak',
    sdk: { name: 'soak-mock', version: '0.0.0' },
    // Local loopback: the 300ms production default is generous here, but keep
    // realistic values so the harness exercises the shipped behaviour.
    connectTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
    ...options,
  });
}

/** Emit a planned workload inside one `session.run`. */
export async function drive(
  session: Session,
  runName: string,
  plan: readonly PlannedEvent[],
  options: DriveOptions = {},
): Promise<DriveResult> {
  const yieldEvery = options.yieldEvery ?? 64;
  const rate = options.rate ?? 0;
  let runId = '';
  let inEmitMs = 0;
  const startedAt = Date.now();
  const emitStart = performance.now();

  await session.run(runName, async (ctx) => {
    runId = ctx.runId;
    const loopStart = performance.now();
    for (let index = 0; index < plan.length; index += 1) {
      const event = plan[index] as PlannedEvent;
      const before = performance.now();
      session.emit(event.type, event.payload);
      inEmitMs += performance.now() - before;
      if ((index + 1) % yieldEvery === 0) {
        options.onProgress?.(index + 1);
        if (rate > 0) {
          const target = loopStart + ((index + 1) / rate) * 1000;
          const wait = target - performance.now();
          if (wait > 1) await delay(wait);
          else await tick();
        } else {
          await tick();
        }
      }
    }
  });

  const emitMs = performance.now() - emitStart;
  return { runId, sent: plan.length, emitMs, inEmitMs, startedAt, finishedAt: Date.now() };
}
