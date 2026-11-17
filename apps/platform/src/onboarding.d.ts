// The onboarding example's workflow module is plain JavaScript; the hosted
// site imports it so the workflows are bundled into the function.
declare module 'circuit-onboarding/workflows.mjs' {
  const definitions: Record<string, unknown>;
  export = definitions;
}
