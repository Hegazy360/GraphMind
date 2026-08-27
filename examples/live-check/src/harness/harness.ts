/**
 * One scenario = one fresh server + one fresh headless debugger. Isolation
 * matters here: several scenarios kill the server on purpose.
 */
import { HeadlessDebugger } from './debugger.js';
import { startLiveServer, type LiveServer } from './server.js';

export interface Harness {
  server: LiveServer;
  dbg: HeadlessDebugger;
  /** The ws:// URL an instrumented app should be pointed at. */
  url: string;
}

export async function withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const server = await startLiveServer();
  const dbg = await HeadlessDebugger.connect(server.uiUrl);
  try {
    return await fn({ server, dbg, url: server.ingestUrl });
  } finally {
    dbg.close();
    await server.stop();
  }
}
