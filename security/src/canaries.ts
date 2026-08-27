/**
 * The canaries.
 *
 * Every string here is a unique, high-entropy token that cannot occur
 * naturally in a GraphMind artifact. Each one is planted in exactly one place
 * a secret realistically lives, and each one is classified:
 *
 *   'forbidden'  — a credential the user NEVER put in the data path (an API
 *                  key, an auth header, a client-config secret, a process
 *                  environment variable). If GraphMind records one of these
 *                  anywhere, that is a CRITICAL defect.
 *
 *   'by-design'  — data the user deliberately handed to the agent: prompts,
 *                  system prompts, tool arguments, tool results. GraphMind is
 *                  a debugger; recording these IS the product. They MUST be
 *                  present in the recorded artifacts, otherwise the debugger
 *                  is broken (or the test is vacuous). This is exactly why
 *                  `graphmind record --html` warns before you share the file.
 *
 * The nonce makes every process's canaries fresh, so a match can never come
 * from a stale row in a shared database or a leftover export file.
 */
import { randomBytes } from 'node:crypto';

export type CanaryClass = 'forbidden' | 'by-design';

export interface Canary {
  /** Stable key used in assertions and failure messages. */
  readonly id: string;
  /** The literal string that is planted and then hunted for. */
  readonly value: string;
  readonly kind: CanaryClass;
  /** Human description of where it was planted. */
  readonly where: string;
}

/** Per-process entropy: nothing older than this process can match. */
export const NONCE = randomBytes(10).toString('hex').toUpperCase();

function c(id: string, value: string, kind: CanaryClass, where: string): Canary {
  return { id, value, kind, where };
}

/**
 * Build a canary set. `scope` keeps adapters from matching each other's
 * tokens, so a failure names the adapter that leaked.
 */
export function makeCanaries(scope: string): CanarySet {
  const s = scope.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tag = (label: string): string => `CANARY${s}${label}${NONCE}`;

  const list: Canary[] = [
    // ---- forbidden: provider client credentials -------------------------
    c(
      'providerApiKey',
      `sk-ant-api03-${tag('APIKEY')}`,
      'forbidden',
      "the provider client's apiKey constructor option",
    ),
    c(
      'authHeader',
      `Bearer ${tag('AUTHHDR')}`,
      'forbidden',
      "an Authorization header set via the client's defaultHeaders",
    ),
    c(
      'orgHeader',
      tag('ORGHDR'),
      'forbidden',
      'a custom x-org-secret default header on the provider client',
    ),
    c(
      'baseUrlToken',
      tag('URLTOKEN'),
      'forbidden',
      'an access_token in the query string of every provider request (defaultQuery)',
    ),
    c(
      'baseUrlPathToken',
      tag('URLPATH'),
      'forbidden',
      'a token embedded in the path of a custom gateway baseURL',
    ),
    c(
      'perRequestHeader',
      tag('REQHDR'),
      'forbidden',
      "a per-request header passed in the SDK call's request-options argument",
    ),

    // ---- forbidden: process environment ---------------------------------
    c('envAwsAccessKeyId', `AKIA${s}${NONCE}`.slice(0, 20), 'forbidden', 'process.env.AWS_ACCESS_KEY_ID'),
    c(
      'envAwsSecret',
      `${tag('AWSSECRET')}wJalrXUtnFEMI`,
      'forbidden',
      'process.env.AWS_SECRET_ACCESS_KEY',
    ),
    c('envDbPassword', tag('DBPASS'), 'forbidden', 'process.env.DATABASE_PASSWORD'),
    c('envSessionToken', tag('SESSION'), 'forbidden', 'process.env.APP_SESSION_TOKEN'),
    c(
      'envPii',
      `ada.lovelace.${NONCE.toLowerCase()}@example.invalid`,
      'forbidden',
      'process.env.SUPPORT_CONTACT_EMAIL (PII that is only ever in the environment)',
    ),

    // ---- by-design: the data the user handed the agent ------------------
    c(
      'promptSecret',
      `sk-live-${tag('INPROMPT')}`,
      'by-design',
      'a credential the user pasted into the user message',
    ),
    c(
      'systemPromptText',
      tag('INSYSTEM'),
      'by-design',
      'text in the system prompt / instructions',
    ),
    c('toolArg', tag('TOOLARG'), 'by-design', "an argument the model passed to a wrapped tool"),
    c(
      'toolResultSecret',
      `sk-live-${tag('TOOLRESULT')}`,
      'by-design',
      'a credential a wrapped tool fetched and returned',
    ),
    c(
      'promptPii',
      `grace.hopper.${NONCE.toLowerCase()}@example.invalid`,
      'by-design',
      'PII the user typed into the prompt',
    ),
  ];

  return new CanarySet(scope, list);
}

export class CanarySet {
  private readonly byId: Map<string, Canary>;

  constructor(
    readonly scope: string,
    readonly all: readonly Canary[],
  ) {
    this.byId = new Map(all.map((canary) => [canary.id, canary]));
  }

  get(id: string): Canary {
    const found = this.byId.get(id);
    if (found === undefined) throw new Error(`unknown canary "${id}"`);
    return found;
  }

  /** The literal string of a canary, by id. */
  value(id: string): string {
    return this.get(id).value;
  }

  forbidden(): readonly Canary[] {
    return this.all.filter((canary) => canary.kind === 'forbidden');
  }

  byDesign(): readonly Canary[] {
    return this.all.filter((canary) => canary.kind === 'by-design');
  }

  /** Environment variables to set on the instrumented app's process. */
  envVars(): Record<string, string> {
    return {
      AWS_ACCESS_KEY_ID: this.value('envAwsAccessKeyId'),
      AWS_SECRET_ACCESS_KEY: this.value('envAwsSecret'),
      DATABASE_PASSWORD: this.value('envDbPassword'),
      APP_SESSION_TOKEN: this.value('envSessionToken'),
      SUPPORT_CONTACT_EMAIL: this.value('envPii'),
    };
  }
}
