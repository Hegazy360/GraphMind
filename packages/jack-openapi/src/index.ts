/**
 * @graphmind-ai/jack-openapi — compiles an OpenAPI document (Swagger 2.0,
 * OpenAPI 3.0, OpenAPI 3.1) plus a reviewed jack.yaml into a Jack Manifest,
 * with lint findings (codes J001–J013, see diagnostics.ts).
 */
export {
  compile,
  CompileError,
  generatedName,
  inferAnnotations,
  kindOf,
  resolveUpstream,
  type CompileOptions,
  type CompileResult,
  type ToolKind,
  type ToolRow,
} from './compile.js';
export { Diagnostics, type Diagnostic, type Severity } from './diagnostics.js';
export { generateConfig, type InitOptions, type InitResult } from './init.js';
export {
  compileProject,
  isUrl,
  loadConfig,
  interpolate,
  LoadError,
  loadSource,
  type Env,
  MAX_DOCUMENT_BYTES,
  parseConfigText,
  parseDocumentText,
  type LoadedSource,
} from './load.js';
export { normalize, detectDialect, UnsupportedDocumentError, type Dialect, type NormalizedDocument } from './normalize.js';
export { looksLikeInstructions, sanitizeText } from './sanitize.js';
export { nameFromPath, snake, toArgName, toToolName } from './names.js';

/** Source document versions the compiler accepts. */
export const SUPPORTED_SOURCE_VERSIONS = ['swagger-2.0', 'openapi-3.0', 'openapi-3.1'] as const;
