/**
 * The wire envelope. Every message on the socket is one JSON text frame:
 *
 *   { gm: 1, seq, ts, runId, type, payload }
 *
 *  - `gm`    protocol major version (see constants.ts)
 *  - `seq`   per-sender monotonically increasing counter. Receivers use it to
 *            deduplicate replays after a reconnect (buffered events may be
 *            re-sent) and to detect gaps.
 *  - `ts`    sender wall clock, epoch milliseconds.
 *  - `runId` the run this message belongs to, or `*` for messages not bound
 *            to a run (handshake, breakpoints, mode).
 *  - `type`  message type, e.g. `node.started`.
 *  - `payload` type-specific payload.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';
import { EventPayloadSchemas, type EventType } from './events.js';
import {
  ControlPayloadSchemas,
  HandshakePayloadSchemas,
  type ControlType,
  type HandshakeType,
} from './control.js';

/** Payload schema for every known message type. */
export const MessagePayloadSchemas = {
  ...EventPayloadSchemas,
  ...ControlPayloadSchemas,
  ...HandshakePayloadSchemas,
} as const;

export type MessageType = keyof typeof MessagePayloadSchemas;

export type MessagePayloadMap = {
  [K in MessageType]: z.infer<(typeof MessagePayloadSchemas)[K]>;
};

export const MESSAGE_TYPES = Object.keys(MessagePayloadSchemas) as readonly MessageType[];

export function isMessageType(type: string): type is MessageType {
  return Object.hasOwn(MessagePayloadSchemas, type);
}

/** A fully-typed envelope for one specific message type. */
export interface Envelope<TType extends MessageType = MessageType> {
  gm: typeof PROTOCOL_VERSION;
  seq: number;
  ts: number;
  runId: string;
  type: TType;
  payload: MessagePayloadMap[TType];
}

/** Discriminated union of every known envelope (discriminant: `type`). */
export type KnownEnvelope = { [K in MessageType]: Envelope<K> }[MessageType];
/** Envelopes the app sends (events). */
export type EventEnvelope = { [K in EventType]: Envelope<K> }[EventType];
/** Envelopes the viewer sends (controls). */
export type ControlEnvelope = { [K in ControlType]: Envelope<K> }[ControlType];
/** Handshake envelopes (either direction). */
export type HandshakeEnvelope = { [K in HandshakeType]: Envelope<K> }[HandshakeType];

function envelopeOf(type: string, payload: z.ZodType): z.ZodType {
  return z
    .looseObject({
      gm: z.literal(PROTOCOL_VERSION),
      seq: z.number().int().nonnegative(),
      ts: z.number(),
      runId: z.string(),
      type: z.literal(type),
      payload,
    })
    .meta({ id: `envelope.${type}` });
}

/** Full envelope schema for every known message type. */
export const EnvelopeSchemas: Readonly<Record<MessageType, z.ZodType>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MessagePayloadSchemas).map(([type, payload]) => [
      type,
      envelopeOf(type, payload),
    ]),
  ) as Record<MessageType, z.ZodType>,
);

/**
 * Union schema over all known envelopes. Used for JSON-schema export and for
 * whole-message validation; `parseEnvelope` uses the per-type map instead
 * (better errors, no linear scan).
 */
export const KnownEnvelopeSchema: z.ZodType = z
  .union(MESSAGE_TYPES.map((t) => EnvelopeSchemas[t]))
  .meta({ id: 'GraphMindEnvelope' });

export interface CreateEnvelopeInput<TType extends MessageType> {
  type: TType;
  payload: MessagePayloadMap[TType];
  /** Per-sender monotonically increasing sequence number. */
  seq: number;
  /** Run id, or WILDCARD_RUN_ID for run-independent messages. */
  runId: string;
  /** Defaults to Date.now(). */
  ts?: number;
}

/** Build a well-formed envelope (does not validate the payload at runtime). */
export function createEnvelope<TType extends MessageType>(
  input: CreateEnvelopeInput<TType>,
): Envelope<TType> {
  return {
    gm: PROTOCOL_VERSION,
    seq: input.seq,
    ts: input.ts ?? Date.now(),
    runId: input.runId,
    type: input.type,
    payload: input.payload,
  };
}

/** Serialize an envelope to a single JSON text frame. */
export function serializeEnvelope(envelope: Envelope<MessageType>): string {
  return JSON.stringify(envelope);
}
