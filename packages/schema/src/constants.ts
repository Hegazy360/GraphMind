/**
 * Protocol-wide constants.
 *
 * `PROTOCOL_VERSION` is the `gm` field of every envelope. It is a single
 * integer acting as the MAJOR version of the wire contract: any incompatible
 * change bumps it, and peers MUST reject envelopes whose `gm` differs from
 * their own (see `parseEnvelope`). Backwards-compatible additions (new event
 * types, new payload fields) do NOT bump it — receivers are required to
 * tolerate unknown types and unknown fields instead.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Envelope `runId` used for messages that are not bound to a specific run
 * (handshake, breakpoint management, mode changes).
 */
export const WILDCARD_RUN_ID = '*';

/**
 * Capabilities a client (instrumented app) may announce in `hello`.
 * The set is open-ended on the wire (plain strings) so future clients can
 * announce capabilities this package does not know about yet.
 */
export const KNOWN_CAPABILITIES = [
  /** The client can hold execution at gates and honour `exec.resume`. */
  'pause',
  /** The client honours `mode.set` with mode `step`. */
  'step',
  /** The client honours `exec.resume` with action `inject` + `output`. */
  'inject',
  /** The client honours `exec.resume` with action `retry`. */
  'retry',
  /** The client honours `exec.resume` with action `abort`. */
  'abort',
  /**
   * The client stores the `sessionToken` from `hello.ack` and echoes it as
   * `hello.resumeToken` on reconnect. A debugger may therefore refuse writes
   * to this client's runs from any other connection — including across a
   * disconnect, which is otherwise the one window a claim cannot be proven in.
   */
  'run-claim',
] as const;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/** A capability string: one of the known ones, or a future/unknown one. */
export type Capability = KnownCapability | (string & {});
