/**
 * This package's version, reported to the debugger in `hello.versions.client`
 * (until 0.6 it was a hard-coded `0.1.0`, so a debugger could not tell a 0.5
 * client from a 0.1 one).
 *
 * A constant rather than a runtime read of package.json: the client is
 * bundled into host apps (Next.js, esbuild, serverless), where a
 * `createRequire('../package.json')` resolves against the bundle's location
 * and throws at import. `scripts/set-version.mjs` rewrites it with every
 * package version; test/version.test.ts fails when it drifts from
 * package.json.
 */
export const CLIENT_VERSION = '0.6.0';
