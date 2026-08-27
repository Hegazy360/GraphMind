/**
 * Correctness, not just speed.
 *
 * Reads a run back out of the server the way the viewer's history pane does
 * (`GET /api/runs/:id/events`, paginated) and proves the storage contract:
 * every event that was sent is stored exactly once, in ascending `seq`, with
 * its per-run ordinal `i` present exactly once and in the order it was
 * emitted — and the derived run summary counts agree.
 */
import type { SoakServer } from './server-handle.ts';

export interface StoredEnvelope {
  gm: number;
  seq: number;
  ts: number;
  runId: string;
  type: string;
  payload: unknown;
}

export interface RunSummaryBody {
  id: string;
  app: string;
  status: string;
  eventCount: number;
  errorCount: number;
  live: boolean;
  source: string;
}

export interface VerifyExpectation {
  /** Ordinals `0..ordinals-1` must each appear exactly once. */
  ordinals: number;
  /** Total stored events expected (workload + run.started + run.finished). */
  total: number;
  /** Expected `node.error` count in the derived summary. */
  errors: number;
}

export interface VerifyResult {
  runId: string;
  ok: boolean;
  problems: string[];
  storedTotal: number;
  fetched: number;
  pages: number;
  pageMs: number[];
  fetchMs: number;
  fetchBytes: number;
  seqAscending: boolean;
  duplicateSeqs: number;
  missingOrdinals: number[];
  duplicateOrdinals: number[];
  ordinalInversions: number;
  summary: RunSummaryBody | undefined;
  typeCounts: Record<string, number>;
}

const PAGE_LIMIT = 5000;

interface EventsPageBody {
  total: number;
  events: StoredEnvelope[];
  nextAfterSeq: number | null;
}

export async function fetchAllEvents(
  server: SoakServer,
  runId: string,
  limit = PAGE_LIMIT,
): Promise<{ events: StoredEnvelope[]; total: number; pageMs: number[]; bytes: number }> {
  const events: StoredEnvelope[] = [];
  const pageMs: number[] = [];
  let bytes = 0;
  let total = 0;
  let afterSeq: number | null = -1;
  while (afterSeq !== null) {
    const page: { ms: number; bytes: number; body: EventsPageBody } = await server.api<EventsPageBody>(
      `/api/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
    );
    pageMs.push(page.ms);
    bytes += page.bytes;
    total = page.body.total;
    events.push(...page.body.events);
    afterSeq = page.body.nextAfterSeq;
  }
  return { events, total, pageMs, bytes };
}

export async function verifyRun(
  server: SoakServer,
  runId: string,
  expected: VerifyExpectation,
): Promise<VerifyResult> {
  const started = performance.now();
  const { events, total, pageMs, bytes } = await fetchAllEvents(server, runId);
  const fetchMs = performance.now() - started;

  const problems: string[] = [];
  const typeCounts: Record<string, number> = {};
  const seenSeq = new Set<number>();
  let duplicateSeqs = 0;
  let seqAscending = true;
  let lastSeq = -Infinity;

  const ordinalSeen = new Map<number, number>();
  let ordinalInversions = 0;
  let lastOrdinal = -1;

  for (const event of events) {
    typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
    if (seenSeq.has(event.seq)) duplicateSeqs += 1;
    seenSeq.add(event.seq);
    if (event.seq <= lastSeq) seqAscending = false;
    lastSeq = event.seq;
    const payload = event.payload as { i?: unknown } | null;
    if (payload !== null && typeof payload === 'object' && typeof payload.i === 'number') {
      ordinalSeen.set(payload.i, (ordinalSeen.get(payload.i) ?? 0) + 1);
      if (payload.i < lastOrdinal) ordinalInversions += 1;
      lastOrdinal = payload.i;
    }
  }

  const missingOrdinals: number[] = [];
  const duplicateOrdinals: number[] = [];
  for (let i = 0; i < expected.ordinals; i += 1) {
    const count = ordinalSeen.get(i) ?? 0;
    if (count === 0) missingOrdinals.push(i);
    else if (count > 1) duplicateOrdinals.push(i);
  }

  const summaryResponse = await server.api<{ runs: RunSummaryBody[] }>('/api/runs');
  const summary = summaryResponse.body.runs.find((run) => run.id === runId);

  if (events.length !== total) problems.push(`fetched ${events.length} events but total says ${total}`);
  if (total !== expected.total) problems.push(`stored ${total} events, expected ${expected.total}`);
  if (!seqAscending) problems.push('events are not in ascending seq order');
  if (duplicateSeqs > 0) problems.push(`${duplicateSeqs} duplicate seq(s)`);
  if (missingOrdinals.length > 0) {
    problems.push(
      `${missingOrdinals.length} missing ordinal(s), first ${missingOrdinals.slice(0, 5).join(',')}`,
    );
  }
  if (duplicateOrdinals.length > 0) problems.push(`${duplicateOrdinals.length} duplicated ordinal(s)`);
  if (ordinalInversions > 0) problems.push(`${ordinalInversions} ordinal inversion(s)`);
  if (summary === undefined) problems.push('run missing from /api/runs');
  else {
    if (summary.eventCount !== expected.total) {
      problems.push(`summary eventCount ${summary.eventCount} != ${expected.total}`);
    }
    if (summary.errorCount !== expected.errors) {
      problems.push(`summary errorCount ${summary.errorCount} != ${expected.errors}`);
    }
  }

  return {
    runId,
    ok: problems.length === 0,
    problems,
    storedTotal: total,
    fetched: events.length,
    pages: pageMs.length,
    pageMs,
    fetchMs,
    fetchBytes: bytes,
    seqAscending,
    duplicateSeqs,
    missingOrdinals,
    duplicateOrdinals,
    ordinalInversions,
    summary,
    typeCounts,
  };
}

/** Same exactly-once/ordering checks, applied to what a UI socket received. */
export function verifyTrace(
  order: readonly number[],
  expectedOrdinals: number,
): { duplicates: number; missing: number; inversions: number } {
  const seen = new Map<number, number>();
  let inversions = 0;
  let last = -1;
  for (const ordinal of order) {
    if (ordinal < 0) continue;
    seen.set(ordinal, (seen.get(ordinal) ?? 0) + 1);
    if (ordinal < last) inversions += 1;
    last = ordinal;
  }
  let duplicates = 0;
  let missing = 0;
  for (let i = 0; i < expectedOrdinals; i += 1) {
    const count = seen.get(i) ?? 0;
    if (count === 0) missing += 1;
    else if (count > 1) duplicates += count - 1;
  }
  return { duplicates, missing, inversions };
}
