/**
 * `graphmind mcp` stays read-only in 0.6 (Phase 7, contract C3;
 * refute-security.md S7, S12).
 *
 *   S7   prompt injection through a recorded payload (`get_node` output) must
 *        not become a way to resume, inject or edit — so the MCP server has no
 *        control tool at all (control is the CLI, bounded by
 *        `serve --allow-control`), and it tells the model recorded payloads
 *        are untrusted data
 *   S12  an existing `mcp__graphmind__*` allowlist must not start
 *        auto-approving new, mutating tools: the tool list is exactly the four
 *        read-only tools, each annotated `readOnlyHint: true`
 *
 * Driven through the shipped binary (`dist/cli.js mcp`) over stdio.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../src/harness.js';

let dir: string;
let client: Client;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'graphmind-mcp-control-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env['GRAPHMIND_TELEMETRY'] = '0';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, 'mcp', '--db', join(dir, 'graphmind.db')],
    env,
    stderr: 'ignore',
  });
  client = new Client({ name: 'security-audit', version: '0.0.0' });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('S12: no new tools for an old allowlist to auto-approve', () => {
  it('lists exactly the four read-only tools, each annotated readOnlyHint', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['find_errors', 'get_node', 'get_run', 'list_runs']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).not.toBe(true);
      expect(tool.name).not.toMatch(/resume|inject|edit|continue|abort|retry|control|pause/i);
    }
  });

  it('a call to a control-sounding tool is an unknown tool, not an action', async () => {
    await expect(client.callTool({ name: 'resume_pause', arguments: { runId: 'r', pauseId: 'p' } })).rejects.toThrow(/unknown tool/i);
  });
});

describe('S7: the instructions are still true and frame recorded payloads as untrusted', () => {
  it('says read-only, points control at the CLI and its --allow-control levels, and warns about prompt injection', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('All tools are read-only');
    expect(instructions).toContain('cannot resume, inject into or edit a paused run');
    expect(instructions).toContain('--allow-control=off|resume|inject|edit');
    expect(instructions).toContain('default off');
    expect(instructions).toMatch(/untrusted/i);
    expect(instructions).toMatch(/prompt injection/i);
  });
});
