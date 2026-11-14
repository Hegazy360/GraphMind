/**
 * @graphmind-ai/jack-schema — the data contract of GraphMind Jack.
 *
 * Jack turns an existing HTTP API into a hosted MCP server. Everything it
 * stores or serves is described here with Zod: the tool manifest a
 * deployment consists of, the project and deployment records of the control
 * plane, and the four ways a project's users can sign in.
 */
export { PROTOCOL_VERSION, SERVICE } from './protocol.js';
export { canonicalJson, jsonValue, sha256Hex, sortKeys, type JsonValue } from './json.js';
export {
  MANIFEST_VERSION,
  ManifestError,
  diffManifests,
  httpMethod,
  manifest,
  manifestHash,
  paramLocation,
  paramMapping,
  parseManifest,
  responseShaping,
  toolAnnotations,
  toolDefinition,
  toolHash,
  toolName,
  toolset,
  type HttpMethod,
  type Manifest,
  type ManifestDiff,
  type ParamLocation,
  type ParamMapping,
  type ToolAnnotations,
  type ToolDefinition,
} from './manifest.js';
export {
  authConfig,
  authMode,
  createDeploymentBody,
  createProjectBody,
  deployment,
  project,
  projectSlug,
  type AuthConfig,
  type AuthMode,
  type CreateProjectBody,
  type Deployment,
  type Project,
} from './project.js';
export { jackConfig, toolOverride, type JackConfig, type ToolOverride } from './config.js';
