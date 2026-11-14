/**
 * Cross-language interop: tokens Jack (Node) signs must verify in the Python
 * and Ruby ports, and their responses must verify here. Runs the real
 * interpreters when they are on PATH, otherwise skips (CI has both).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createJackVerifier, signHs256, TYP, verifyHs256 } from '../src/index.js';

const SECRET = 'a-shared-secret-of-at-least-32-characters-long';
const ISSUER = 'https://acme.mcp.graphmind.ai';
const AUD = 'https://api.acme.com';
const now = Math.floor(Date.now() / 1000);
const root = fileURLToPath(new URL('../../../', import.meta.url));

const have = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
const request = signHs256({ typ: TYP.request, iss: ISSUER, aud: AUD, jti: 'jar_x', return: `${ISSUER}/oauth/link/callback`, scope: 'notes:read', iat: now, exp: now + 300 }, SECRET);
const assertion = signHs256({ typ: TYP.assertion, iss: ISSUER, aud: AUD, sub: 'usr_9', grant_id: 'grt_9', scope: 'notes:read', jti: 'inter-1', iat: now, exp: now + 60 }, SECRET);

/** Each script prints JSON: {request: {...}, assertion: {...}, response: "<token>", replay: "<error>"} */
const PY = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("jack", sys.argv[1]); m = importlib.util.module_from_spec(spec); sys.modules["jack"] = m; spec.loader.exec_module(m)
j = m.JackVerifier(secret=sys.argv[2], issuer=sys.argv[3], audience=sys.argv[4])
req = j.verify_link_request(sys.argv[5]); a = j.verify_assertion(sys.argv[6])
try:
    j.verify_assertion(sys.argv[6]); replay = None
except m.JackLinkError as e:
    replay = str(e)
print(json.dumps({"request": {"requestId": req.request_id, "returnUrl": req.return_url, "scopes": req.scopes},
                  "assertion": {"userId": a.user_id, "grantId": a.grant_id, "scopes": a.scopes},
                  "response": j.link_response(sys.argv[5], user_id="usr_py", name="Py User"), "replay": replay}))
`;
const RB = `
require "json"; require sys = ARGV[0]
j = Graphmind::Jack::Verifier.new(secret: ARGV[1], issuer: ARGV[2], audience: ARGV[3])
req = j.verify_link_request(ARGV[4]); a = j.verify_assertion(ARGV[5])
replay = begin; j.verify_assertion(ARGV[5]); nil; rescue Graphmind::Jack::LinkError => e; e.message; end
puts JSON.generate({ request: { requestId: req.request_id, returnUrl: req.return_url, scopes: req.scopes },
                     assertion: { userId: a.user_id, grantId: a.grant_id, scopes: a.scopes },
                     response: j.link_response(ARGV[4], user_id: "usr_rb", name: "Rb User"), replay: replay })
`.replace('require sys = ARGV[0]', 'require ARGV[0]');

function check(out: string, lang: string) {
  const r = JSON.parse(out) as { request: unknown; assertion: unknown; response: string; replay: string | null };
  expect(r.request).toEqual({ requestId: 'jar_x', returnUrl: `${ISSUER}/oauth/link/callback`, scopes: ['notes:read'] });
  expect(r.assertion).toEqual({ userId: 'usr_9', grantId: 'grt_9', scopes: ['notes:read'] });
  expect(r.replay).toMatch(/replayed/);
  // Their response verifies here, exactly as Jack's server would verify it.
  const p = verifyHs256(r.response, SECRET, { typ: TYP.response, issuer: AUD, audience: ISSUER });
  expect(p).toMatchObject({ jti: 'jar_x', sub: `usr_${lang}` });
  // And our verifier accepts it as a full round trip through linkResponseUrl semantics.
  const jack = createJackVerifier({ secret: SECRET, issuer: ISSUER, audience: AUD });
  expect(jack.verifyLinkRequest(request).requestId).toBe('jar_x');
}

describe('interop with the Python and Ruby verifiers', () => {
  const python = ['python3', 'python3.12', 'python3.11', 'python3.10', 'python'].find((c) => have(c, ['--version']));
  it.skipIf(!python)('Python verifies Node tokens and Node verifies its response', () => {
    const r = spawnSync(python!, ['-I', '-c', PY, `${root}python/graphmind/jack.py`, SECRET, ISSUER, AUD, request, assertion], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    check(r.stdout, 'py');
  });

  const ruby = have('ruby', ['--version']);
  it.skipIf(!ruby)('Ruby verifies Node tokens and Node verifies its response', () => {
    const r = spawnSync('ruby', ['-e', RB, `${root}ruby/lib/graphmind/jack.rb`, SECRET, ISSUER, AUD, request, assertion], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    check(r.stdout, 'rb');
  });
});
