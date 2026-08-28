/**
 * The first thing anyone sees: a run arriving live on the canvas.
 *
 * The bundled fixture is replayed at its recorded pace (~10s wall clock), so
 * these assertions are about a graph that grows over time — not a snapshot
 * that was rendered all at once.
 */
import {
  FIXTURE_NODES,
  edgeInto,
  expect,
  nodeBody,
  nodeCard,
  openFixtureRun,
  runStatusPill,
  test,
  waitForPlantedPause,
} from './harness.js';

interface StatusSample {
  t: number;
  id: string;
  status: string;
}

/** Record every (node, status) transition the DOM goes through, with timings. */
async function startStatusTrace(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const bag = window as unknown as Record<string, unknown>;
    const samples: StatusSample[] = [];
    const seen = new Set<string>();
    bag['__gmTrace'] = samples;
    bag['__gmTraceTimer'] = setInterval(() => {
      for (const el of document.querySelectorAll('.react-flow__node')) {
        const id = el.getAttribute('data-id');
        if (id === null) continue;
        const card = el.querySelector('[class*="gm-node--"]');
        const match = /gm-node--([a-z]+)/.exec(card?.getAttribute('class') ?? '');
        const status = match?.[1];
        if (status === undefined) continue;
        const key = `${id}:${status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        samples.push({ t: performance.now(), id, status });
      }
    }, 30);
  });
}

async function readStatusTrace(
  page: import('@playwright/test').Page,
): Promise<StatusSample[]> {
  return await page.evaluate(() => {
    const bag = window as unknown as Record<string, unknown>;
    clearInterval(bag['__gmTraceTimer'] as ReturnType<typeof setInterval>);
    return (bag['__gmTrace'] ?? []) as StatusSample[];
  });
}

function firstAt(trace: StatusSample[], id: string, status: string): number | undefined {
  return trace.find((s) => s.id === id && s.status === status)?.t;
}

test('the fixture run streams onto the canvas: cards appear, light up, and settle', async ({
  page,
}) => {
  await openFixtureRun(page);
  await startStatusTrace(page);

  // Every node the run declares — five executed tools, one ungated provider
  // tool, the step and the agent — eventually has a card.
  for (const nodeId of Object.values(FIXTURE_NODES)) {
    await expect(nodeCard(page, nodeId)).toBeVisible();
  }

  await waitForPlantedPause(page);
  await nodeCard(page, FIXTURE_NODES.currency).getByRole('button', { name: 'Continue' }).click();

  await expect(runStatusPill(page)).toHaveText('done', { timeout: 30_000 });
  await expect(nodeBody(page, FIXTURE_NODES.agent)).toHaveClass(/gm-node--ok/);

  const trace = await readStatusTrace(page);

  // A hinted-but-not-yet-executed tool renders as a ghost before it runs.
  const flightsGhost = firstAt(trace, FIXTURE_NODES.flights, 'ghost');
  const flightsRunning = firstAt(trace, FIXTURE_NODES.flights, 'running');
  const flightsOk = firstAt(trace, FIXTURE_NODES.flights, 'ok');
  expect(flightsGhost, 'searchFlights should appear as a graph.hint ghost').toBeDefined();
  expect(flightsRunning, 'searchFlights should light up when it runs').toBeDefined();
  expect(flightsOk, 'searchFlights should settle to done').toBeDefined();
  expect(flightsGhost ?? 0).toBeLessThan(flightsRunning ?? 0);
  expect(flightsRunning ?? 0).toBeLessThan(flightsOk ?? 0);

  // …and this is a stream, not a single paint: the gap between "hinted" and
  // "finished" is real wall-clock time (the recording puts ~1.4s between them).
  expect((flightsOk ?? 0) - (flightsGhost ?? 0)).toBeGreaterThan(500);

  // The planted failure was visible as a held gate at some point.
  expect(firstAt(trace, FIXTURE_NODES.currency, 'paused')).toBeDefined();

  // Statuses observed across the whole run, for a cheap regression signal.
  const observed = new Set(trace.map((s) => s.status));
  expect([...observed].sort()).toEqual(expect.arrayContaining(['ghost', 'ok', 'paused', 'running']));
});

test('tokens stream into the active LLM card, reasoning first then text', async ({ page }) => {
  await openFixtureRun(page);

  const tail = nodeCard(page, FIXTURE_NODES.llm).locator('.gm-token-tail');

  // Sampled continuously rather than asserted at two moments.
  //
  // The reasoning phase is short, and each `expect` is a fresh round trip: on
  // a loaded machine the stream could move on to the visible answer between
  // "the text is there" and "the class is there", so the second assertion
  // retried toward a state that had already passed. Collecting samples and
  // asserting on the SEQUENCE tests the same behaviour — reasoning first,
  // then text, in one card — and cannot lose a race.
  const samples: { text: string; reasoning: boolean; caret: boolean }[] = [];
  await expect
    .poll(
      async () => {
        samples.push(
          await tail.evaluate((el: Element) => ({
            text: (el as HTMLElement).innerText,
            reasoning: el.classList.contains('gm-token-tail--reasoning'),
            caret: el.querySelector('.gm-caret') !== null,
          })),
        );
        return samples.some((s) => s.text.includes("I'll start by finding"));
      },
      {
        message: 'the visible answer should stream into the LLM card',
        timeout: 30_000,
        intervals: [50],
      },
    )
    .toBe(true);

  // The recording opens with a reasoning stream…
  const reasoning = samples.filter((s) => s.reasoning);
  expect(reasoning.length, 'the reasoning stream should have been rendered').toBeGreaterThan(0);
  expect(reasoning.some((s) => s.text.includes('Budget of'))).toBe(true);
  // …rendered as a live tail, with a caret while the step runs.
  expect(samples.some((s) => s.caret), 'a caret should show while the step runs').toBe(true);
  // …and then the visible answer takes over the same card, no longer styled
  // as reasoning.
  const answer = samples.find((s) => s.text.includes("I'll start by finding"));
  expect(answer?.reasoning).toBe(false);
  // The order matters: reasoning came first.
  expect(samples.indexOf(reasoning[0]!)).toBeLessThan(samples.indexOf(answer!));

  // Tokens keep arriving after that: the tail text changes again on its own.
  const midRun = await tail.innerText();
  await expect
    .poll(async () => (await tail.innerText()) !== midRun, {
      message: 'the token tail should keep updating as the run streams',
      timeout: 25_000,
    })
    .toBe(true);
});

test('edges into a running node animate, and settle when it finishes', async ({ page }) => {
  await openFixtureRun(page);

  const edge = edgeInto(page, FIXTURE_NODES.llm);
  await expect(edge).toHaveClass(/gm-edge-active/, { timeout: 20_000 });

  const path = edge.locator('.react-flow__edge-path');
  const animation = await path.evaluate((el) => {
    const running = el
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .length;
    return { name: getComputedStyle(el).animationName, running };
  });
  expect(animation.name).toBe('gm-edge-flow');
  expect(animation.running, 'the marching-ants animation should be running').toBeGreaterThan(0);

  // Prove it is actually moving, not merely declared.
  const offset = await path.evaluate((el) => getComputedStyle(el).strokeDashoffset);
  await expect
    .poll(async () => await path.evaluate((el) => getComputedStyle(el).strokeDashoffset), {
      message: 'stroke-dashoffset should advance while the edge animates',
      timeout: 5_000,
    })
    .not.toBe(offset);

  // A finished tool's edge stops being active.
  await expect(edgeInto(page, FIXTURE_NODES.flights)).toHaveClass(/gm-edge-done/, {
    timeout: 25_000,
  });
});
