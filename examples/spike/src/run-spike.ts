/**
 * Spike runner: proves/refutes cooperative pause-resume of an in-flight
 * AI SDK agent loop via wrapLanguageModel middleware + wrapped tool execute.
 *
 * Scenarios map to assertions (a)-(f) from the spike brief. Everything is
 * asserted programmatically from trace timestamps; nothing is eyeballed.
 */

import {
  getTotalTimeoutMs,
  getStepTimeoutMs,
  getFirstChunkTimeoutMs,
  getChunkTimeoutMs,
} from 'ai';
import { Trace, now, sleep } from './trace.js';
import { GateEngine } from './gate.js';
import { runAgent } from './agent.js';
import { startFakeDebugger, type PausedEvent } from './control-server.js';
import { Suite, fmt, deepEqual } from './assert.js';

import { readFileSync } from 'node:fs';

const AI_VERSION: string = (
  JSON.parse(
    readFileSync(new URL('../node_modules/ai/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

// ---------------------------------------------------------------------------
// (c2 + f) BASELINE: no debugger connected at all.
// ---------------------------------------------------------------------------
async function scenarioBaseline(suite: Suite): Promise<void> {
  console.log('\n== BASELINE (c2, f): no debugger attached ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);

  const run = await runAgent(engine);

  const opens = trace.findAll('gate:open');
  suite.check(
    'c2.1',
    'no debugger: full loop runs with zero pauses',
    opens.length === 0 && run.stepCount === 3,
    `pauses=${opens.length}, steps=${run.stepCount}, total=${fmt(run.durationMs)}`,
  );

  const overheads = engine.passThroughOverheadsMs;
  const max = Math.max(...overheads);
  const avg = overheads.reduce((a, b) => a + b, 0) / overheads.length;
  suite.check(
    'c2.2',
    'no debugger: per-gate overhead < 1ms (measured at await site)',
    overheads.length === 6 && max < 1,
    `gates=${overheads.length}, max=${max.toFixed(3)}ms, avg=${avg.toFixed(3)}ms`,
  );

  // (f) STREAM TEE: middleware-observed deltas === SDK step texts, per step.
  const perStepOk = run.stepTexts.map(
    (stepText, i) => stepText === (engine.observedTextByStep[i] ?? ''),
  );
  suite.check(
    'f.1',
    'tee: observed text deltas match SDK step texts exactly (all 3 steps)',
    perStepOk.length === 3 && perStepOk.every(Boolean),
    perStepOk.map((ok, i) => `step${i}:${ok ? 'match' : 'MISMATCH'}`).join(' '),
  );
  suite.check(
    'f.2',
    'tee: final answer text matches observed final-step deltas',
    run.text === engine.observedTextByStep[2],
    `finalLen=${run.text.length}`,
  );
}

// ---------------------------------------------------------------------------
// (a) HOLD: breakpoint on searchFlights, resume after 2100ms.
// ---------------------------------------------------------------------------
async function scenarioHold(suite: Suite): Promise<void> {
  console.log('\n== (a) HOLD: breakpoint on before-tool:searchFlights ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);
  const ctl = await startFakeDebugger(
    {
      breakpoints: ['before-tool:searchFlights'],
      onPaused: async (msg, c) => {
        await sleep(2100);
        c.resume(msg.pauseId, { type: 'continue' });
      },
    },
    trace,
  );
  await engine.connect(`ws://127.0.0.1:${ctl.port}`);

  const run = await runAgent(engine);
  await ctl.close();
  engine.close();

  const open = trace.find('gate:open', e => e.data['toolName'] === 'searchFlights');
  const resolved = trace.find('gate:resolved', e => e.data['toolName'] === 'searchFlights');
  const bodyStart = trace.find('tool:body-start', e => e.data['toolName'] === 'searchFlights');
  const heldMs = open !== undefined && resolved !== undefined ? resolved.at - open.at : undefined;

  suite.check(
    'a.1',
    'execution held >= 2000ms until WS controller resumed',
    heldMs !== undefined && heldMs >= 2000,
    `held=${fmt(heldMs)}`,
  );
  suite.check(
    'a.2',
    'tool execute did NOT start during hold (body-start after resume)',
    open !== undefined &&
      resolved !== undefined &&
      bodyStart !== undefined &&
      bodyStart.at >= resolved.at &&
      bodyStart.at - open.at >= 2000,
    bodyStart !== undefined && resolved !== undefined
      ? `bodyStart ${fmt(bodyStart.at - resolved.at)} after resume`
      : 'missing trace events',
  );
  suite.check(
    'a.3',
    'run completed normally after resume',
    run.stepCount === 3 && run.text.length > 0,
    `steps=${run.stepCount}, total=${fmt(run.durationMs)}`,
  );
}

// ---------------------------------------------------------------------------
// (b) PARALLEL: two tool calls in one step gate independently.
// ---------------------------------------------------------------------------
async function scenarioParallel(suite: Suite): Promise<void> {
  console.log('\n== (b) PARALLEL: independent gates for two parallel tool calls ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);

  const paused: PausedEvent[] = [];
  let midCheck:
    | { currencyStillPending: boolean; currencyBodyStarted: boolean; weatherResumedAt: number }
    | undefined;

  const ctl = await startFakeDebugger(
    {
      breakpoints: ['before-tool:checkWeather', 'before-tool:convertCurrency'],
      onPaused: async (msg, c) => {
        paused.push(msg);
        if (paused.length < 2) return; // wait until BOTH gates are held
        const weather = paused.find(p => p.node.toolName === 'checkWeather');
        const currency = paused.find(p => p.node.toolName === 'convertCurrency');
        if (weather === undefined || currency === undefined) return;

        trace.mark('test:both-paused');
        c.resume(weather.pauseId, { type: 'continue' });
        const weatherResumedAt = now();
        await sleep(600);
        midCheck = {
          currencyStillPending: engine.isPendingPause(currency.pauseId),
          currencyBodyStarted:
            trace.find('tool:body-start', e => e.data['toolName'] === 'convertCurrency') !==
            undefined,
          weatherResumedAt,
        };
        trace.mark('test:mid-check', { ...midCheck });
        c.resume(currency.pauseId, { type: 'continue' });
      },
    },
    trace,
  );
  await engine.connect(`ws://127.0.0.1:${ctl.port}`);

  const run = await runAgent(engine);
  await ctl.close();
  engine.close();

  const weatherOpen = trace.find('gate:open', e => e.data['toolName'] === 'checkWeather');
  const currencyOpen = trace.find('gate:open', e => e.data['toolName'] === 'convertCurrency');
  const weatherResolved = trace.find('gate:resolved', e => e.data['toolName'] === 'checkWeather');
  const currencyResolved = trace.find(
    'gate:resolved',
    e => e.data['toolName'] === 'convertCurrency',
  );
  const currencyBodyStart = trace.find(
    'tool:body-start',
    e => e.data['toolName'] === 'convertCurrency',
  );
  const weatherBodyStart = trace.find(
    'tool:body-start',
    e => e.data['toolName'] === 'checkWeather',
  );

  suite.check(
    'b.1',
    'both tool calls were gated concurrently (both held before either resolved)',
    weatherOpen !== undefined &&
      currencyOpen !== undefined &&
      weatherResolved !== undefined &&
      currencyResolved !== undefined &&
      weatherOpen.at < Math.min(weatherResolved.at, currencyResolved.at) &&
      currencyOpen.at < Math.min(weatherResolved.at, currencyResolved.at),
    weatherOpen !== undefined && currencyOpen !== undefined
      ? `opens ${fmt(Math.abs(weatherOpen.at - currencyOpen.at))} apart`
      : 'missing gate:open events',
  );
  suite.check(
    'b.2',
    'after resuming weather only, currency stayed held (checked 600ms later)',
    midCheck !== undefined &&
      midCheck.currencyStillPending &&
      !midCheck.currencyBodyStarted,
    midCheck !== undefined
      ? `pending=${String(midCheck.currencyStillPending)}, bodyStarted=${String(midCheck.currencyBodyStarted)}`
      : 'mid-check never ran',
  );
  suite.check(
    'b.3',
    'weather ran during the window; currency body only after its own resume',
    weatherBodyStart !== undefined &&
      weatherResolved !== undefined &&
      currencyResolved !== undefined &&
      currencyBodyStart !== undefined &&
      weatherBodyStart.at >= weatherResolved.at &&
      weatherBodyStart.at < currencyResolved.at &&
      currencyBodyStart.at >= currencyResolved.at &&
      currencyResolved.at - weatherResolved.at >= 550,
    weatherResolved !== undefined && currencyResolved !== undefined
      ? `resumes ${fmt(currencyResolved.at - weatherResolved.at)} apart`
      : 'missing events',
  );
  suite.check('b.4', 'run completed normally', run.stepCount === 3 && run.text.length > 0);
}

// ---------------------------------------------------------------------------
// (c1) FAIL-OPEN: kill the WS server while a gate is held.
// ---------------------------------------------------------------------------
async function scenarioFailOpen(suite: Suite): Promise<void> {
  console.log('\n== (c1) FAIL-OPEN: kill WS server during a held gate ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);
  const ctl = await startFakeDebugger(
    {
      breakpoints: ['before-tool:searchFlights'],
      onPaused: async (_msg, c) => {
        await sleep(300);
        c.killAbruptly(); // debugger "crashes" while the gate is held
      },
    },
    trace,
  );
  await engine.connect(`ws://127.0.0.1:${ctl.port}`);

  const run = await runAgent(engine);
  engine.close();

  const kill = trace.find('ctl:kill');
  const auto = trace.find('gate:auto-continue', e => e.data['toolName'] === 'searchFlights');
  const lag = kill !== undefined && auto !== undefined ? auto.at - kill.at : undefined;

  suite.check(
    'c1.1',
    'held gate auto-continued within 100ms of server kill',
    lag !== undefined && lag >= 0 && lag <= 100,
    `lag=${fmt(lag)}`,
  );
  suite.check(
    'c1.2',
    'run completed fully after debugger crash (fail-open)',
    run.stepCount === 3 && run.text.length > 0,
    `steps=${run.stepCount}`,
  );
  const opensAfterKill =
    kill === undefined ? [] : trace.findAll('gate:open', e => e.at > kill.at);
  suite.check(
    'c1.3',
    'no further pauses after disconnect (breakpoints cleared)',
    opensAfterKill.length === 0,
    `laterPauses=${opensAfterKill.length}`,
  );
}

// ---------------------------------------------------------------------------
// (d) INJECT-ON-ERROR: convertCurrency throws; debugger injects a fix.
// ---------------------------------------------------------------------------
const INJECTED = {
  amount: 100,
  converted: 91.3,
  currency: 'USD',
  note: 'injected-by-debugger',
};

async function scenarioInjectOnError(suite: Suite): Promise<void> {
  console.log('\n== (d) INJECT-ON-ERROR: tool throws, debugger injects corrected output ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);
  const ctl = await startFakeDebugger(
    {
      breakpoints: ['on-error:convertCurrency'],
      onPaused: (msg, c) => {
        c.resume(msg.pauseId, { type: 'inject', output: INJECTED });
      },
    },
    trace,
  );
  await engine.connect(`ws://127.0.0.1:${ctl.port}`);

  const run = await runAgent(engine, { currencyThrows: true });
  await ctl.close();
  engine.close();

  const threw = trace.find('tool:body-throw', e => e.data['toolName'] === 'convertCurrency');
  const errorGate = trace.find(
    'gate:open',
    e => e.data['toolName'] === 'convertCurrency',
  );
  const injected = trace.find('tool:error-injected', e => e.data['toolName'] === 'convertCurrency');
  suite.check(
    'd.1',
    'tool threw and the on-error gate fired (wrapper caught before SDK)',
    threw !== undefined &&
      errorGate !== undefined &&
      injected !== undefined &&
      threw.at < errorGate.at &&
      errorGate.at < injected.at,
    threw !== undefined && errorGate !== undefined
      ? `error->gate ${fmt(errorGate.at - threw.at)}`
      : 'missing events',
  );

  const sdkSawError = trace.find('run:onError');
  suite.check(
    'd.2',
    'loop continued: 3 steps, no error surfaced to the SDK stream',
    run.stepCount === 3 && sdkSawError === undefined,
    `steps=${run.stepCount}, finish=${run.finalFinishReason}`,
  );

  // Inspect the params the MIDDLEWARE saw on the step-3 doStream call.
  const step3Params = engine.doStreamParamsByStep[2];
  let promptValue: unknown;
  if (step3Params !== undefined) {
    outer: for (const message of step3Params.prompt) {
      if (message.role !== 'tool') continue;
      for (const part of message.content) {
        if (part.type === 'tool-result' && part.toolName === 'convertCurrency') {
          promptValue = part.output.type === 'json' ? part.output.value : part.output;
          break outer;
        }
      }
    }
  }
  suite.check(
    'd.3',
    'injected payload appears verbatim in the next doStream prompt (middleware params)',
    deepEqual(promptValue, INJECTED),
    `found=${JSON.stringify(promptValue)}`,
  );
  suite.check(
    'd.4',
    'final assistant answer reflects the injected value',
    run.text.includes('91.3') && run.text.includes('injected-by-debugger'),
    `answer="${run.text.slice(0, 120)}..."`,
  );
}

// ---------------------------------------------------------------------------
// (e) LONG HOLD: 30s before-step hold; nothing in flight; no timeouts.
// ---------------------------------------------------------------------------
async function scenarioLongHold(suite: Suite): Promise<void> {
  console.log('\n== (e) LONG HOLD: 30s pause at before-step:1 (this takes 30s) ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);
  const ctl = await startFakeDebugger(
    {
      breakpoints: ['before-step:1'],
      onPaused: async (msg, c) => {
        await sleep(30_000);
        c.resume(msg.pauseId, { type: 'continue' });
      },
    },
    trace,
  );
  await engine.connect(`ws://127.0.0.1:${ctl.port}`);

  const run = await runAgent(engine);
  await ctl.close();
  engine.close();

  const resolved = trace.find('gate:resolved', e => e.data['stepIndex'] === 1);
  const heldMs = resolved?.data['heldMs'] as number | undefined;
  suite.check(
    'e.1',
    'before-step gate held >= 30000ms',
    heldMs !== undefined && heldMs >= 30_000,
    `held=${fmt(heldMs)}`,
  );

  const doStream1 = trace.find('mock:doStream', e => e.data['call'] === 1);
  suite.check(
    'e.2',
    'nothing in flight during hold: step-2 doStream only invoked after resume',
    resolved !== undefined && doStream1 !== undefined && doStream1.at >= resolved.at,
    resolved !== undefined && doStream1 !== undefined
      ? `doStream ${fmt(doStream1.at - resolved.at)} after resume`
      : 'missing events',
  );

  const sdkError = trace.find('run:onError');
  suite.check(
    'e.3',
    'no SDK/provider timeout or error fired; run completed normally',
    sdkError === undefined && run.stepCount === 3 && run.text.length > 0,
    `steps=${run.stepCount}, finish=${run.finalFinishReason}, total=${fmt(run.durationMs)}`,
  );

  const noDefaults =
    getTotalTimeoutMs(undefined) === undefined &&
    getStepTimeoutMs(undefined) === undefined &&
    getFirstChunkTimeoutMs(undefined) === undefined &&
    getChunkTimeoutMs(undefined) === undefined;
  suite.check(
    'e.4',
    'ai@7 timeout config is opt-in: no default total/step/firstChunk/chunk timeout',
    noDefaults,
    'getTotalTimeoutMs(undefined) et al. all return undefined',
  );
}

// ---------------------------------------------------------------------------
// (g) RETRY + CONTINUE (informational): exercise the remaining resume actions.
// retry -> the wrapper re-invokes the original execute;
// continue -> the wrapper rethrows and the SDK takes over (tool-error part).
// ---------------------------------------------------------------------------
async function scenarioRetryThenContinue(suite: Suite): Promise<void> {
  console.log('\n== (g) RETRY then CONTINUE: remaining resume actions + SDK rethrow path ==');
  const trace = new Trace();
  const engine = new GateEngine(trace);
  let pauseCount = 0;
  const ctl = await startFakeDebugger(
    {
      breakpoints: ['on-error:convertCurrency'],
      onPaused: (msg, c) => {
        pauseCount += 1;
        // First failure: ask the wrapper to retry. Tool throws again.
        // Second failure: continue -> rethrow to the SDK.
        c.resume(msg.pauseId, pauseCount === 1 ? { type: 'retry' } : { type: 'continue' });
      },
    },
    trace,
  );
  await engine.connect(`ws://127.0.0.1:${ctl.port}`);

  const run = await runAgent(engine, { currencyThrows: true });
  await ctl.close();
  engine.close();

  const execStarts = trace.findAll(
    'tool:wrapper-exec-start',
    e => e.data['toolName'] === 'convertCurrency',
  );
  const errorGates = trace.findAll('gate:open', e => e.data['toolName'] === 'convertCurrency');
  suite.check(
    'g.1',
    'retry re-invoked the original execute (2 attempts, 2 error gates)',
    execStarts.length === 2 && errorGates.length === 2,
    `attempts=${execStarts.length}, errorGates=${errorGates.length}`,
  );

  // After 'continue' the SDK sees the throw: it must record a tool-error and
  // keep the loop alive (error text is sent to the model as the tool result).
  const step3Params = engine.doStreamParamsByStep[2];
  let errorOutputType: string | undefined;
  if (step3Params !== undefined) {
    outer: for (const message of step3Params.prompt) {
      if (message.role !== 'tool') continue;
      for (const part of message.content) {
        if (part.type === 'tool-result' && part.toolName === 'convertCurrency') {
          errorOutputType = part.output.type;
          break outer;
        }
      }
    }
  }
  suite.check(
    'g.2',
    'continue/rethrow: SDK converted the throw into an error tool result and kept looping',
    run.stepCount === 3 &&
      (errorOutputType === 'error-text' || errorOutputType === 'error-json'),
    `steps=${run.stepCount}, toolResultOutputType=${String(errorOutputType)}, finish=${run.finalFinishReason}`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`spike-pause-resume against ai@${AI_VERSION} (Node ${process.version})`);
  const suite = new Suite();
  const t0 = now();

  await scenarioBaseline(suite);
  await scenarioHold(suite);
  await scenarioParallel(suite);
  await scenarioFailOpen(suite);
  await scenarioInjectOnError(suite);
  await scenarioRetryThenContinue(suite);
  await scenarioLongHold(suite);

  console.log(`\nTotal runtime: ${fmt(now() - t0)}`);
  suite.printSummary();
  process.exitCode = suite.failures.length === 0 ? 0 : 1;
}

await main();
