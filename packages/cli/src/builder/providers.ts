/**
 * The model providers a generated project can call.
 *
 * Two SDK families speak to all of them. The Anthropic SDK speaks to
 * Anthropic. The OpenAI SDK speaks to OpenAI and to every provider that
 * exposes an OpenAI-compatible endpoint (Mistral, xAI, Groq, DeepSeek,
 * OpenRouter, a local Ollama), given a base URL. The Vercel AI SDK has a
 * first-party package for most and `@ai-sdk/openai-compatible` for the rest.
 *
 * A provider row therefore says: what its key is called and whether one is
 * needed at all (Ollama runs on your own machine), which AI SDK package and
 * factory build it, and the base URL the OpenAI SDK should point at. The
 * target table (spec.ts) derives which providers each target can call from
 * the `family` column, so adding a provider is adding one row here.
 *
 * Nothing in this file is a secret: `envKey` is the NAME of the variable the
 * generated code reads.
 */

export const PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'xai', 'groq', 'deepseek', 'openrouter', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Which raw SDK can talk to a provider. */
export type ProviderFamily = 'anthropic' | 'openai';

export interface AiSdkPackage {
  /** `@ai-sdk/google` */
  pkg: string;
  /** Version floor the generated manifest pins. */
  version: string;
  /** `createGoogleGenerativeAI` */
  factory: string;
}

export interface ProviderMeta {
  id: Provider;
  label: string;
  /** The environment variable the SDKs read the key from. */
  envKey: string;
  /** False for a provider that runs locally and needs no key (Ollama). */
  keyRequired: boolean;
  defaultModel: string;
  family: ProviderFamily;
  /** For the OpenAI SDK targets: where to point `baseURL`. Absent = the SDK's default. */
  baseURL?: string;
  /**
   * For the Vercel AI SDK target: the first-party package, or absent to go
   * through `@ai-sdk/openai-compatible` with `baseURL`.
   */
  aiSdk?: AiSdkPackage;
  docs: string;
}

/** The shim AI SDK uses for a provider without a first-party package. */
export const AI_SDK_COMPATIBLE: AiSdkPackage = {
  pkg: '@ai-sdk/openai-compatible',
  version: '^3.0.82',
  factory: 'createOpenAICompatible',
};

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    keyRequired: true,
    defaultModel: 'claude-sonnet-4-5',
    family: 'anthropic',
    aiSdk: { pkg: '@ai-sdk/anthropic', version: '^4.0.42', factory: 'createAnthropic' },
    docs: 'https://docs.anthropic.com/',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    keyRequired: true,
    defaultModel: 'gpt-5.1',
    family: 'openai',
    aiSdk: { pkg: '@ai-sdk/openai', version: '^4.0.47', factory: 'createOpenAI' },
    docs: 'https://platform.openai.com/docs',
  },
  google: {
    id: 'google',
    label: 'Google (Gemini)',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    keyRequired: true,
    defaultModel: 'gemini-2.5-flash',
    family: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    aiSdk: { pkg: '@ai-sdk/google', version: '^4.0.109', factory: 'createGoogleGenerativeAI' },
    docs: 'https://ai.google.dev/gemini-api/docs',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    keyRequired: true,
    defaultModel: 'mistral-large-latest',
    family: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    aiSdk: { pkg: '@ai-sdk/mistral', version: '^4.0.77', factory: 'createMistral' },
    docs: 'https://docs.mistral.ai/',
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    keyRequired: true,
    defaultModel: 'grok-4',
    family: 'openai',
    baseURL: 'https://api.x.ai/v1',
    aiSdk: { pkg: '@ai-sdk/xai', version: '^5.0.35', factory: 'createXai' },
    docs: 'https://docs.x.ai/',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    keyRequired: true,
    defaultModel: 'llama-3.3-70b-versatile',
    family: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    aiSdk: { pkg: '@ai-sdk/groq', version: '^4.0.74', factory: 'createGroq' },
    docs: 'https://console.groq.com/docs',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    keyRequired: true,
    defaultModel: 'deepseek-chat',
    family: 'openai',
    baseURL: 'https://api.deepseek.com',
    aiSdk: { pkg: '@ai-sdk/deepseek', version: '^3.0.77', factory: 'createDeepSeek' },
    docs: 'https://api-docs.deepseek.com/',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    keyRequired: true,
    defaultModel: 'anthropic/claude-sonnet-4.5',
    family: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    docs: 'https://openrouter.ai/docs',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    envKey: 'OLLAMA_API_KEY',
    keyRequired: false,
    defaultModel: 'llama3.2',
    family: 'openai',
    baseURL: 'http://127.0.0.1:11434/v1',
    docs: 'https://docs.ollama.com/',
  },
};

export function providerMeta(id: Provider): ProviderMeta {
  return PROVIDER_META[id];
}

/** The providers a raw SDK of `family` can call, in table order. */
export function providersOfFamily(family: ProviderFamily): Provider[] {
  return PROVIDERS.filter((id) => PROVIDER_META[id].family === family);
}

/** The AI SDK package a provider goes through. */
export function aiSdkPackageFor(id: Provider): AiSdkPackage {
  return PROVIDER_META[id].aiSdk ?? AI_SDK_COMPATIBLE;
}

/** Derived records, kept for the places that index by provider. */
export const PROVIDER_ENV_KEY: Record<Provider, string> = Object.fromEntries(
  PROVIDERS.map((id) => [id, PROVIDER_META[id].envKey]),
) as Record<Provider, string>;

export const DEFAULT_MODEL: Record<Provider, string> = Object.fromEntries(
  PROVIDERS.map((id) => [id, PROVIDER_META[id].defaultModel]),
) as Record<Provider, string>;
