/**
 * Control payloads: messages the viewer sends to the instrumented app,
 * plus the bidirectional `hello`/`hello.ack` handshake.
 *
 * Handshake flow (the app is the WebSocket client and dials the viewer):
 *   1. app  -> viewer : `hello`      (protocol + client versions, capabilities)
 *   2. viewer -> app  : `hello.ack`  (viewer version, accepted capabilities,
 *                                     current breakpoints + mode)
 * The ack carries the viewer's full desired debug state so a client that
 * reconnects (or attaches mid-run) is re-armed in one message.
 */
import { z } from 'zod';
import {
  BreakpointMatcherSchema,
  ResumeActionSchema,
  RunModeSchema,
  SdkInfoSchema,
} from './primitives.js';

export const ControlPayloadSchemas = {
  /**
   * Release a held gate.
   * `output` is only meaningful for action `inject` (the value to substitute
   * for the node's result); it is ignored for other actions.
   */
  'exec.resume': z.looseObject({
    pauseId: z.string(),
    action: ResumeActionSchema,
    output: z.unknown().optional(),
  }),

  /** Add a breakpoint. Matchers are deduplicated by exact field equality. */
  'breakpoint.set': z.looseObject({
    matcher: BreakpointMatcherSchema,
  }),

  /** Remove a breakpoint previously set with an identical matcher. */
  'breakpoint.clear': z.looseObject({
    matcher: BreakpointMatcherSchema,
  }),

  /** Switch between free-running and single-step execution. */
  'mode.set': z.looseObject({
    mode: RunModeSchema,
  }),
} as const;

export type ControlType = keyof typeof ControlPayloadSchemas;

export const HandshakePayloadSchemas = {
  /** First message sent by the app after the socket opens. */
  hello: z.looseObject({
    versions: z.looseObject({
      /** Must equal the envelope `gm`; duplicated here for log friendliness. */
      protocol: z.number().int(),
      /** Version of the @graphmind-ai/client package (or compatible impl). */
      client: z.string(),
    }),
    capabilities: z.array(z.string()),
    app: z.string().optional(),
    sdk: SdkInfoSchema.optional(),
  }),

  /** Viewer's reply. Until received, the app must consider itself detached. */
  'hello.ack': z.looseObject({
    versions: z.looseObject({
      protocol: z.number().int(),
      viewer: z.string(),
    }),
    /** Capabilities the viewer will actually use (subset of hello's, usually). */
    capabilities: z.array(z.string()),
    /** Current breakpoints to arm immediately. */
    breakpoints: z.array(BreakpointMatcherSchema),
    /** Current execution mode to adopt immediately. */
    mode: RunModeSchema,
  }),
} as const;

export type HandshakeType = keyof typeof HandshakePayloadSchemas;

export const CONTROL_TYPES = Object.keys(ControlPayloadSchemas) as readonly ControlType[];
export const HANDSHAKE_TYPES = Object.keys(HandshakePayloadSchemas) as readonly HandshakeType[];

export function isControlType(type: string): type is ControlType {
  return Object.hasOwn(ControlPayloadSchemas, type);
}

export function isHandshakeType(type: string): type is HandshakeType {
  return Object.hasOwn(HandshakePayloadSchemas, type);
}
