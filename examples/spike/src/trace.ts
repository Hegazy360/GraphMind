/** Monotonic clock + in-memory trace recorder used by all assertions. */

export const now = (): number => performance.now();

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface TraceEvent {
  name: string;
  at: number;
  data: Record<string, unknown>;
}

export class Trace {
  readonly events: TraceEvent[] = [];

  mark(name: string, data: Record<string, unknown> = {}): TraceEvent {
    const event: TraceEvent = { name, at: now(), data };
    this.events.push(event);
    return event;
  }

  find(
    name: string,
    pred?: (e: TraceEvent) => boolean,
  ): TraceEvent | undefined {
    return this.events.find(e => e.name === name && (pred ? pred(e) : true));
  }

  findAll(name: string, pred?: (e: TraceEvent) => boolean): TraceEvent[] {
    return this.events.filter(e => e.name === name && (pred ? pred(e) : true));
  }
}
