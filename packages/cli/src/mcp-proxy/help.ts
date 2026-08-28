/**
 * What `graphmind mcp-proxy` says when it is run with no command — which is
 * exactly what happens the first time somebody tries it. Zero-config
 * discovery means this text has to be a working recipe, not a synopsis.
 */
import { DEFAULT_PORT } from '../paths.js';

export const MCP_PROXY_SUMMARY =
  'Debug any MCP server, in any language, with no code changes';

export function mcpProxyHelp(port: number = DEFAULT_PORT): string[] {
  return [
    'graphmind mcp-proxy — debug any MCP server, in any language, no code changes',
    '',
    'Usage: graphmind mcp-proxy [options] -- <command> [args...]',
    '',
    'Spawns <command> as a child, speaks stdio JSON-RPC to your MCP client on',
    'one side and to the server on the other, and relays every frame verbatim',
    'while reporting the conversation to GraphMind as a live run. Because it',
    'sits at the protocol boundary it works for a server written in ANY',
    'language, and it does nothing at all if GraphMind is not running.',
    '',
    'Examples:',
    '  graphmind mcp-proxy -- node my-server.js',
    '  graphmind mcp-proxy -- python -m my_server',
    '  graphmind mcp-proxy -- ./target/debug/my-rust-server --flag',
    '  graphmind mcp-proxy --trace -- npx -y @modelcontextprotocol/server-everything',
    '',
    'Point Claude Code at it (wrap an existing server by name):',
    '  claude mcp add my-server-debug -- npx -y graphmind-ai mcp-proxy -- node my-server.js',
    '',
    'Or wrap a server already in .mcp.json / claude_desktop_config.json by',
    'moving its command into the proxy:',
    '  before: { "command": "node",      "args": ["my-server.js"] }',
    '  after:  { "command": "npx",       "args": ["-y", "graphmind-ai", "mcp-proxy",',
    '                                              "--", "node", "my-server.js"] }',
    '',
    `Then run \`graphmind\` in another terminal (viewer on http://127.0.0.1:${port})`,
    'and restart the client. Gates are armed from the viewer: hold a request',
    'before the server sees it, hold a response before the client sees it,',
    'and inject a different result to see how the client copes. Errors —',
    'JSON-RPC errors and MCP tool results with isError — pause by default.',
    '',
    'Options:',
    '  --trace              Log one line per frame to stderr (works with no',
    '                       GraphMind running at all)',
    '  --wait-for-attach    Hold the first frame until the debugger attaches',
    '                       (up to 3s), so `initialize` can be gated too',
    '  --inherit-stderr     Give the server the real stderr fd instead of',
    '                       piping it (keeps isatty(2) true; the server log',
    '                       then does NOT appear on the session node)',
    '  --max-frame-bytes <n>  Frame-assembly ceiling (default 64 MiB). Above',
    '                       it the proxy stops parsing and becomes a raw pipe',
    `  --port <n>           GraphMind port to report to (default ${port})`,
    '',
    'Nothing is ever written to stdout except the protocol itself.',
  ];
}
