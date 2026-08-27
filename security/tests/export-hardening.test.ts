/**
 * `graphmind record --html` produces a file people are explicitly told to
 * share — attach it to an issue, drop it in Slack. Two things must hold for
 * that to be safe advice:
 *
 *  1. The recorded run is DATA, never code. A tool result containing
 *     `</script><img onerror=...>` must not become script in whoever opens the
 *     file. Prompts and tool outputs come from models and from the internet;
 *     treating them as trusted markup would turn every shared export into a
 *     stored-XSS delivery vehicle.
 *
 *  2. The command has to say, out loud, that the file contains prompts and
 *     tool payloads — because it does, and that is the whole point of the
 *     "recorded by design" half of this audit.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphmind } from '@graphmind-ai/anthropic';
import { cleanupAudit, runAudit } from '../src/harness.js';

const BREAKOUT = '</script><img src=x onerror="window.__GRAPHMIND_PWNED=1">';
const SVG_BREAKOUT = ']]><svg onload="window.__GRAPHMIND_PWNED=2">';
const SEPARATORS = 'line\u2028sep\u2029end';

describe('HTML export treats the run as data, not markup', () => {
  it('escapes a script-breakout payload that came out of a tool', async () => {
    const result = await runAudit({
      agent: async (ctx) => {
        const gm = graphmind({
          url: ctx.ingestUrl,
          enabled: true,
          app: 'export-hardening',
          waitForAttach: 3000,
          retryIntervalMs: 60_000,
          logger: () => {},
        });
        const tools = gm.wrapTools({
          hostileTool: async (input: unknown) => ({
            echoed: input,
            payload: BREAKOUT,
            svg: SVG_BREAKOUT,
            separators: SEPARATORS,
          }),
        });
        try {
          await gm.run('hostile', async () => {
            await tools.hostileTool({ note: BREAKOUT });
          });
        } finally {
          await gm.dispose();
        }
      },
    });

    try {
      expect(result.htmlPath).toBeDefined();
      if (result.htmlPath === undefined) return;
      const html = readFileSync(result.htmlPath, 'utf8');

      // The payload really is in the export (it is run data, recorded by
      // design) — but only in escaped form.
      expect(html).toContain('\\u003c/script\\u003e');
      expect(html).not.toContain(BREAKOUT);

      // The only literal `</script>` sequences are the page's own two tags.
      const literalCloses = html.split('</script>').length - 1;
      expect(literalCloses).toBe(2);

      // U+2028 / U+2029 terminate a JS line even inside a string literal.
      expect(html).not.toContain('\u2028');
      expect(html).not.toContain('\u2029');
      expect(html).toContain('\\u2028');
    } finally {
      cleanupAudit(result);
    }
  }, 90_000);
});

describe('`graphmind record --html` warns before you share', () => {
  it('prints that the file contains prompts and tool payloads', async () => {
    // Captured from the same CLI invocation the harness makes; re-run here so
    // the assertion is on stdout, not on a file.
    const { runCli, CLI_ENTRY } = await import('../src/harness.js');
    expect(CLI_ENTRY).toContain('cli.js');

    const result = await runAudit({
      agent: async (ctx) => {
        const gm = graphmind({
          url: ctx.ingestUrl,
          enabled: true,
          app: 'warn-check',
          waitForAttach: 3000,
          retryIntervalMs: 60_000,
          logger: () => {},
        });
        const tools = gm.wrapTools({ noop: async () => ({ ok: true }) });
        try {
          await gm.run('warn-check', async () => {
            await tools.noop();
          });
        } finally {
          await gm.dispose();
        }
      },
    });

    try {
      const runId = result.runIds[0];
      expect(runId).toBeDefined();
      if (runId === undefined) return;
      const stdout = await runCli(
        ['record', runId, '--db', `${result.dir}/graphmind.db`, '--html', '--out', `${result.dir}/warn.html`],
        `${result.dir}/gm-home`,
        'http://127.0.0.1:1/api/telemetry',
        false,
      );
      expect(stdout).toMatch(/prompts, tool inputs and outputs/i);
      expect(stdout).toMatch(/check before sharing/i);
    } finally {
      cleanupAudit(result);
    }
  }, 90_000);
});
