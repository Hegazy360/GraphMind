/**
 * Who may drive a paused agent, and with what (Phase 7, contract C3).
 *
 * The origin guard (origin-guard.ts) keeps *web pages* out. It cannot keep out
 * another process on this machine: a request with no `Origin` is how every
 * non-browser client connects, so any local process — another OS user, a
 * container on `--network host`, a coding agent following a prompt injection —
 * could send `exec.resume`. For continue/inject that was the 0.5 posture. Input
 * edits change the stakes (an edited `shell`/`sql` call runs as the victim),
 * so from 0.6 control carries a credential:
 *
 *  - At start the server mints two 128-bit tokens. The **viewer** token has
 *    full control; it reaches the browser only through the URL fragment. The
 *    **agent** token is for the CLI (`graphmind resume`) and is limited by
 *    `serve --allow-control=off|resume|inject|edit` (default `off`).
 *  - HTTP presents a token as `Authorization: Bearer <token>`; a browser
 *    WebSocket (which cannot set headers) as the subprotocol
 *    `gm.auth.<token>` next to `graphmind.v1`, which is the only protocol the
 *    server ever selects. `?token=` and cookies are never read: both leak (logs,
 *    history, Referer; cookies are not port-isolated).
 *  - Comparison is constant-time over SHA-256 digests, so neither the length
 *    nor a prefix of a token is observable through timing.
 *
 * A UI socket with no credential keeps only the part of the 0.5 behaviour that
 * chooses nothing — continue, retry, abort (deprecated) — so it never has more
 * rights than the agent token at level `resume` (which may also change
 * breakpoints and step mode), though more than at `off`, which may release
 * nothing. It cannot edit an input, and it
 * cannot reach the same power another way: an injected result replaces what
 * the model or the tool returned (an injected LLM completion picks the next
 * tool call AND its arguments), and breakpoints / step mode decide which calls
 * hold at all. Both need a credential.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { proposedValueRefusal } from '@graphmind-ai/client';
import type { ResumeAction } from '@graphmind-ai/schema';
import { REDACTED } from './redact-secrets.js';

/** Who a control request came from. Stamped on the stored `exec.resumed`. */
export type Principal = 'viewer' | 'agent' | 'anonymous';

/** `serve --allow-control` levels for the agent token, weakest first. */
export const CONTROL_LEVELS = ['off', 'resume', 'inject', 'edit'] as const;
export type ControlLevel = (typeof CONTROL_LEVELS)[number];

export const DEFAULT_CONTROL_LEVEL: ControlLevel = 'off';

/** The only subprotocol `/ws/ui` selects. */
export const UI_SUBPROTOCOL = 'graphmind.v1';
/** Prefix of the subprotocol entry that carries a token on `/ws/ui`. */
export const AUTH_SUBPROTOCOL_PREFIX = 'gm.auth.';

/** What this hub implements, announced in `hello.ack.hubCapabilities`. */
export const HUB_CAPABILITY_PAUSE_REGISTRY = 'pause-registry';
export const HUB_CAPABILITY_EDIT_INPUT = 'edit-input';


/** Longest operator label kept, in code points. */
export const MAX_OPERATOR_CHARS = 64;

export interface ControlTokens {
  readonly viewer: string;
  readonly agent: string;
}

export interface ControlPolicy {
  /** What the agent token may do. */
  readonly agentLevel: ControlLevel;
  /** False under `serve --no-edit-input`: every input edit is refused. */
  readonly editInput: boolean;
}

/** A refusal the hub or the HTTP layer answers with. `message` never quotes values. */
export interface Refusal {
  code: string;
  message: string;
}

/** Two fresh 128-bit tokens. The prefixes say which is which (and help secret scanners). */
export function generateTokens(): ControlTokens {
  return {
    viewer: `gmv_${randomBytes(16).toString('hex')}`,
    agent: `gma_${randomBytes(16).toString('hex')}`,
  };
}

export function parseControlLevel(raw: string | undefined): ControlLevel | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  return (CONTROL_LEVELS as readonly string[]).includes(value) ? (value as ControlLevel) : undefined;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Identifies a presented token. Both digests are always compared, so the time
 * taken does not depend on which token (if any) matched.
 */
export class CredentialVerifier {
  private readonly viewerDigest: Buffer;
  private readonly agentDigest: Buffer;

  constructor(tokens: ControlTokens) {
    this.viewerDigest = sha256(tokens.viewer);
    this.agentDigest = sha256(tokens.agent);
  }

  identify(presented: string): 'viewer' | 'agent' | undefined {
    const digest = sha256(presented);
    const viewer = timingSafeEqual(digest, this.viewerDigest);
    const agent = timingSafeEqual(digest, this.agentDigest);
    if (viewer) return 'viewer';
    if (agent) return 'agent';
    return undefined;
  }
}

export type CredentialResult =
  | { kind: 'none' }
  | { kind: 'ok'; principal: 'viewer' | 'agent' }
  | { kind: 'invalid'; message: string };

/**
 * `Authorization` header -> token. `undefined` when absent; `null` when
 * present but not a well-formed `Bearer <token>` (which is refused, not
 * treated as "no credential").
 */
export function bearerToken(header: string | undefined | null): string | undefined | null {
  if (header === undefined || header === null || header.trim() === '') return undefined;
  const match = /^Bearer[ \t]+([!-~]+)[ \t]*$/i.exec(header);
  return match === null ? null : (match[1] as string);
}

/** Every `gm.auth.<token>` entry of a `Sec-WebSocket-Protocol` header. */
export function subprotocolTokens(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const values = Array.isArray(header) ? header : [header];
  const tokens: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const entry = part.trim();
      if (entry.startsWith(AUTH_SUBPROTOCOL_PREFIX)) {
        tokens.push(entry.slice(AUTH_SUBPROTOCOL_PREFIX.length));
      }
    }
  }
  return tokens;
}

/**
 * Resolve the presented credentials (`null` = a malformed one) to a principal.
 * Several presentations must agree; any unknown token is refused outright
 * rather than downgraded to anonymous, so a stale or guessed token fails
 * loudly instead of silently losing its rights.
 */
export function resolveCredential(
  presented: readonly (string | null)[],
  verifier: CredentialVerifier,
): CredentialResult {
  if (presented.length === 0) return { kind: 'none' };
  if (presented.some((token) => token === null || token === '')) {
    return { kind: 'invalid', message: 'malformed credential (expected "Authorization: Bearer <token>")' };
  }
  const distinct = new Set(presented as string[]);
  if (distinct.size > 1) return { kind: 'invalid', message: 'conflicting credentials' };
  const principal = verifier.identify(presented[0] as string);
  if (principal === undefined) return { kind: 'invalid', message: 'unknown or expired token' };
  return { kind: 'ok', principal };
}

function levelAtLeast(level: ControlLevel, need: ControlLevel): boolean {
  return CONTROL_LEVELS.indexOf(level) >= CONTROL_LEVELS.indexOf(need);
}

function agentNeeds(need: ControlLevel, current: ControlLevel, what: string): Refusal {
  return {
    code: 'forbidden',
    message:
      current === 'off'
        ? `agent control is off on this server; restart it with --allow-control=${need} to allow ${what}`
        : `agent control level "${current}" does not allow ${what}; that needs --allow-control=${need}`,
  };
}

/**
 * May `principal` release a gate this way? Covers the credential and level
 * only — the owner's `edit-input`, `--no-edit-input`, `editable` and content
 * checks are the hub's (they need the run's state).
 */
export function authorizeResume(
  principal: Principal,
  policy: ControlPolicy,
  action: ResumeAction,
  hasInput: boolean,
): Refusal | undefined {
  if (principal === 'viewer') return undefined;
  if (principal === 'anonymous') {
    if (hasInput) {
      return {
        code: 'edit-refused',
        message:
          'input edits need a credential: open the viewer from the link `graphmind serve` prints ' +
          '(or its redirect file), or use `graphmind resume` with --allow-control=edit',
      };
    }
    if (action === 'inject') {
      // An injected LLM completion chooses the next tool call and its
      // arguments — the power an input edit has — so it needs a credential too.
      return {
        code: 'forbidden',
        message:
          'injecting a result needs a credential: open the viewer from the link `graphmind serve` prints ' +
          '(or its redirect file), or use `graphmind resume` with --allow-control=inject',
      };
    }
    return undefined; // continue / retry / abort: 0.5 behaviour, deprecated
  }
  const level = policy.agentLevel;
  if (hasInput) {
    return levelAtLeast(level, 'edit') ? undefined : agentNeeds('edit', level, 'input edits');
  }
  if (action === 'inject') {
    return levelAtLeast(level, 'inject') ? undefined : agentNeeds('inject', level, 'injecting results');
  }
  return levelAtLeast(level, 'resume') ? undefined : agentNeeds('resume', level, 'resuming pauses');
}

/**
 * Breakpoints and step mode decide which calls hold: the viewer token, or the
 * agent token at level `resume`. A tokenless socket never: it may release a
 * held call (continue, retry, abort) but not decide which calls hold.
 */
export function authorizeDebugState(principal: Principal, policy: ControlPolicy): Refusal | undefined {
  if (principal === 'viewer') return undefined;
  if (principal === 'anonymous') {
    return {
      code: 'forbidden',
      message:
        'changing breakpoints or step mode needs a credential: open the viewer from the link ' +
        '`graphmind serve` prints (or its redirect file)',
    };
  }
  return levelAtLeast(policy.agentLevel, 'resume')
    ? undefined
    : agentNeeds('resume', policy.agentLevel, 'changing breakpoints or step mode');
}

/**
 * Starting the bundled demo writes a run: the viewer token, or the agent token
 * at level `resume` — at `off` the agent token can do nothing at all.
 */
export function authorizeDemoStart(principal: Principal, policy: ControlPolicy): Refusal | undefined {
  if (principal === 'viewer') return undefined;
  if (principal === 'agent') {
    return levelAtLeast(policy.agentLevel, 'resume')
      ? undefined
      : agentNeeds('resume', policy.agentLevel, 'starting the demo');
  }
  return { code: 'forbidden', message: 'starting the demo needs a credential' };
}

/**
 * A value that still carries a redaction placeholder or a truncation marker
 * is a hidden or shrunk RECORDING pre-filled into an editor, not something
 * anyone meant to run. Refused for edited inputs and injected outputs alike —
 * in the hub, as defence in depth behind the viewer and the client.
 *
 * The markers are the client's own list (`proposedValueRefusal` in
 * @graphmind-ai/client), so a marker added there — a new SDK's preview form —
 * is refused here too, with no second list to keep in step. Only the wording
 * is the hub's.
 */
export function contentRefusal(value: unknown, what: 'input' | 'output'): Refusal | undefined {
  const refusal = proposedValueRefusal(value);
  if (refusal === undefined) return undefined;
  const verb = what === 'input' ? 'edit refused' : 'inject refused';
  switch (refusal.code) {
    case 'placeholder':
      // The inject wording predates 0.6 and is pinned by redact-inject.test.ts.
      return {
        code: 'placeholder',
        message:
          what === 'input'
            ? `${verb}: this input contains redacted content ("${REDACTED}"); edit it before running`
            : `${verb}: this value contains redacted content ("${REDACTED}"); edit it before injecting`,
      };
    case 'truncated':
      return {
        code: 'truncated',
        message: `${verb}: this value contains a truncated preview of a recorded value; send the full value`,
      };
    default:
      return { code: refusal.code, message: `${verb}: ${refusal.message ?? 'the value cannot be checked'}` };
  }
}

/**
 * The optional free-text `operator` label a resumer may attach. It is
 * untrusted: never used for authorization, only rendered as text. Kept to
 * letters, marks, numbers, punctuation, symbols and plain spaces — so no
 * control characters, no bidi overrides or isolates, no zero-width or line
 * separators — collapsed and cut to 64 code points. Nothing left: undefined.
 */
export function sanitizeOperator(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const ch of value) {
    if (/^\p{Zs}$/u.test(ch)) {
      pendingSpace = out !== '';
      continue;
    }
    if (!/^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u.test(ch)) continue;
    if (pendingSpace) {
      if (count + 1 >= MAX_OPERATOR_CHARS) break;
      out += ' ';
      count += 1;
      pendingSpace = false;
    }
    if (count >= MAX_OPERATOR_CHARS) break;
    out += ch;
    count += 1;
  }
  return out === '' ? undefined : out;
}

/** A resumer-supplied `requestId` is kept only when it is short and plain. */
export function acceptableRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
