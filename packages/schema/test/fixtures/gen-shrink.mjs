#!/usr/bin/env node
/**
 * Regenerates packages/schema/test/fixtures/shrink.json (version 2), the
 * conformance fixture every port of `serializePayload` (TypeScript, Python,
 * Ruby) reproduces byte for byte.
 *
 * Runs against the BUILT package:
 *
 *   pnpm --filter @graphmind-ai/schema build
 *   node packages/schema/test/fixtures/gen-shrink.mjs
 *
 * Every version-1 case is kept, under its v1 name and input. Each carries
 * `v1`: "unchanged" when its expected output is byte-identical to version 1
 * (checked here against the v1 SHA-256), otherwise the reason it changed —
 * the generator refuses to write a changed v1 case without one.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_PAYLOAD_BYTES,
  MAX_SHRINK_DEPTH,
  MAX_SHRINK_KEYS,
  MAX_TRIM_FIELDS,
  PREVIEW_CHARS,
  SKELETON_CHARS,
  SKELETON_MIN_CHARS,
  TRUNCATION_SUFFIX,
  serializePayload,
  skeletonPlan,
  utf8ByteLength,
} from '../../dist/shrink.js';
import { EVENT_TYPES } from '../../dist/index.js';

/** Largest expected JSON (UTF-8 bytes) stored verbatim; larger ones are stored as a digest. */
const EXACT_LIMIT = 16 * 1024;

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Expands the fixture notation (see GENERATOR below). Must match test/shrink.test.ts. */
export function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [only] = keys;
    const args = value[only];
    if (only === '$repeat') return args[0].repeat(args[1]);
    if (only === '$array') return Array.from({ length: args[1] }, () => expand(args[0]));
    if (only === '$concat') return args.map(expand).join('');
    if (only === '$keys') {
      const [prefix, count, item] = args;
      const out = {};
      for (let i = 0; i < count; i += 1) setOwn(out, `${prefix}${i}`, expand(item));
      return out;
    }
    if (only === '$merge') {
      const out = {};
      for (const part of args) {
        const expanded = expand(part);
        for (const key of Object.keys(expanded)) setOwn(out, key, expanded[key]);
      }
      return out;
    }
  }
  const out = {};
  for (const key of keys) setOwn(out, key, expand(value[key]));
  return out;
}

function mediumFields(count) {
  const out = {};
  for (let i = 0; i < count; i += 1) out[`f${String(i).padStart(3, '0')}`] = { $repeat: ['m', 3000] };
  return out;
}

const RESULTS = new Map();
function RESULT_OF(name) {
  return { $resultOf: name };
}

const V1_CASES = [
  { ...{"name":"under-budget-object","note":"An ordinary node.finished payload is returned untouched (truncated false, json is plain JSON.stringify).","type":"node.finished","v1Sha256":"cf058c7b18bfb8c707d35130958a1d90044f5750cae2b40e64d2ecaaa646701b","v1Truncated":false}, input: {"nodeId":"tool:search","instanceId":"i1","durationMs":4.25,"status":"ok","output":{"hits":3,"rows":[{"a":1},{"a":null}],"text":"é 中 😀 \"q\" \n\t\\","lone":"\ud800x"}} },
  { ...{"name":"under-budget-exactly-at-limit","note":"JSON text of exactly MAX_PAYLOAD_BYTES UTF-8 bytes is within budget (the check is bytes > maxBytes).","v1Sha256":"6d500de45e903f78f5e6fe33ed982dec2863733bc67f57d0f91921a850fa8168","v1Truncated":false}, input: {"s":{"$repeat":["x",524280]}} },
  { ...{"name":"one-byte-over-limit","note":"One byte over: the field is shrunk and the marker merged in.","v1Sha256":"b49c0404242ca6c19bcbe36bc45ea65be6de549eb4f794ba397fd6d32de98e25","v1Truncated":true}, input: {"s":{"$repeat":["x",524281]}} },
  { ...{"name":"multibyte-under-by-units-over-by-bytes","note":"The budget check is UTF-8 BYTES: \"é\" x 262,141 is 262,149 UTF-16 units of JSON (under 512 KB) but 524,290 bytes (2 over).","v1Sha256":"c0f61d02b20dd0728ac981d6045d59976d2ae2522a48adf69bccaef62b301ed3","v1Truncated":true}, input: {"s":{"$repeat":["é",262141]}} },
  { ...{"name":"huge-ascii-string-field","note":"node.finished with a 600 KB ASCII string output: output becomes a 2,000-unit prefix + suffix; structural fields kept; fields [\"output\"].","type":"node.finished","v1Sha256":"d4f7eba373753585ddc4e5d287ea496669ee5ec28f5ec9addcb87cf31a8b38f9","v1Truncated":true}, input: {"nodeId":"tool:scrape","instanceId":"s1","durationMs":12,"status":"ok","output":{"$repeat":["x",614400]}} },
  { ...{"name":"huge-cjk-string-field-mixed-units","note":"Field sizes are UTF-16 LENGTHS subtracted from a UTF-8 BYTE total: \"中\" x 200,000 is ~600 KB of bytes but only ~200 KB of units, so `remaining` stays above maxBytes/2 and EVERY field (even the small ones, unchanged) is listed in `fields`.","type":"node.finished","v1Sha256":"c6d2d17fb86484984533876a79b240c4e5eb2302d59f2050088daf8c09d17e9e","v1Truncated":true}, input: {"nodeId":"tool:t","durationMs":1,"status":"ok","output":{"$repeat":["中",200000]}} },
  { ...{"name":"astral-string-field-split-surrogate","note":"\"a😀\" (3 UTF-16 units) x 120,000: the 2,000-unit prefix ends in a lone high surrogate, which JSON.stringify writes as the escape \\ud83d.","type":"node.finished","v1Sha256":"63e5c3da0e51e20c17b2b5ab3008fd479e1eaa5b2d0d5e591fa65e8ddd6862e1","v1Truncated":true}, input: {"nodeId":"tool:t","durationMs":1,"status":"ok","output":{"$repeat":["a😀",120000]}} },
  { ...{"name":"astral-string-even-boundary","note":"\"😀\" x 150,000 with no offset: the prefix keeps exactly 1,000 whole emoji.","type":"node.finished","v1Sha256":"933f9e4c72990c0d4de7a7ca16584528e9aa8d24a7aad4f6e3321e1f71dd94f4","v1Truncated":true}, input: {"nodeId":"tool:t","durationMs":1,"status":"ok","output":{"$repeat":["😀",150000]}} },
  { ...{"name":"escapes-at-preview-boundary","note":"A string of 300,000 newlines serializes to 600,002 units (\"\\n\" is two): the preview (a slice of the JSON TEXT) can end on a lone backslash.","type":"node.finished","v1Sha256":"76652f2ef0a9d9de9bcdd1834f5917e2221af6d3e1caa4e7ae1692355c550a84","v1Truncated":true}, input: {"nodeId":"tool:tt","durationMs":1,"status":"ok","output":{"$repeat":["\n",300000]}} },
  { ...{"name":"huge-array-field","note":"An oversized array field becomes [] (type preserved).","type":"node.finished","v1Sha256":"ab23441e790667b38c88475ff401a581d088354d116eb7727e6e3e75951632ae","v1Truncated":true}, input: {"nodeId":"tool:list","durationMs":3,"status":"ok","output":{"$array":["abcdefghij",60000]}} },
  { ...{"name":"huge-nested-object-field","note":"An oversized object field keeps its keys; nested strings over 2,000 units are cut, nested arrays become [], small values stay; the marker (bytes = JSON LENGTH in units, preview) is merged into the field only at its top.","type":"node.finished","v1Sha256":"e57684b4cf63d38407b751e3019a174a88b8f04d54c926824af4bb6f91354f61","v1Truncated":true}, input: {"nodeId":"tool:fetch","durationMs":7,"status":"ok","output":{"meta":{"a":1,"ok":true,"n":null},"body":{"$repeat":["b",409600]},"list":[1,2,3],"deep":{"x":{"y":{"$repeat":["y",204800]},"z":"short"}}}} },
  { ...{"name":"huge-nested-object-multibyte","note":"A shrunk object field's own marker `bytes` is its JSON LENGTH in UTF-16 units (here far below its UTF-8 size), while the top-level marker `bytes` is UTF-8 bytes.","type":"node.finished","v1Sha256":"9e168dde7fcfaf3af4bfa2c4db2dfe8fed8088687ca6ff2d3ae9b1b9d1f6e85c","v1Truncated":true}, input: {"nodeId":"tool:fetch","durationMs":7,"status":"ok","output":{"body":{"$repeat":["é",307200]},"tag":"ü"}} },
  { ...{"name":"several-large-fields-biggest-first","note":"Fields are shrunk biggest first until the remaining total is <= maxBytes/2: b (300 KB) then c (200 KB); a (150 KB) is kept whole.","type":"node.finished","v1Sha256":"1c3965b722ec7abdf529dcf8131ecdc49a2d0a9ecc74200659ee69482c27f474","v1Truncated":true}, input: {"nodeId":"tool:t","durationMs":1,"status":"ok","a":{"$repeat":["a",153600]},"b":{"$repeat":["b",307200]},"c":{"$repeat":["c",204800]}} },
  { ...{"name":"equal-size-fields-keep-key-order","note":"Ties keep key order (stable sort): x then y are shrunk, z is kept.","v1Sha256":"af043daa014ea4aff4a02ee0174c7150456ee4c387915e0c40d9479dc053d588","v1Truncated":true}, input: {"x":{"$repeat":["x",204800]},"y":{"$repeat":["y",204800]},"z":{"$repeat":["z",204800]}} },
  { ...{"name":"node-error-required-string","note":"node.error with a huge message: error stays an object, message stays a STRING (prefix + suffix), name/stack kept, marker merged into error and into the payload.","type":"node.error","v1Sha256":"05ab3acbf70c20b75cb29717dd1ced694d04c9545e2da4b5e150150ab77a7be5","v1Truncated":true}, input: {"nodeId":"llm:step","instanceId":"l1","error":{"name":"APIError","message":{"$repeat":["provider said: e",40000]},"stack":"at call (x.ts:1:1)"}} },
  { ...{"name":"bare-huge-string-payload","note":"A payload that is not an object is replaced whole by the marker (bytes = UTF-8 bytes of the JSON, preview = first 2,000 units of the JSON text).","v1Sha256":"16fdc470ea02b68c2ae1231948559a4d9c37c179558e6c27e0cd59a39da402a3","v1Truncated":true}, input: {"$repeat":["s",614400]} },
  { ...{"name":"non-object-huge-array-payload","note":"An oversized array payload is replaced whole.","v1Sha256":"ce6423442c71b1bcbf8fdcf82ea2247177ef9d652660f796bb75aa41a647b63f","v1Truncated":true}, input: {"$array":["abcdefghij",60000]} },
  { ...{"name":"non-object-small-number","note":"A small non-object payload is untouched.","v1Sha256":"73475cb40a568e8da8a045ced110137e159f890ac4da883b6b17dc651b3a8049","v1Truncated":false}, input: 42 },
  { ...{"name":"null-payload","note":"null serializes to \"null\", untouched.","v1Sha256":"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b","v1Truncated":false}, input: null },
  { ...{"name":"depth-beyond-max-shrink-depth","note":"Inside a shrunk field, an object at depth >= 6 is replaced by {__graphmindTruncated:true, bytes:0, preview:\"[deeply nested]\"}.","type":"node.finished","v1Sha256":"9066bf7e234de4c53973925304f597e7970ef36f64346b033247e4077a50c914","v1Truncated":true}, input: {"nodeId":"tool:t","durationMs":1,"status":"ok","output":{"l1":{"l2":{"l3":{"l4":{"l5":{"l6":{"l7":{"leaf":"v"}},"s":"kept"},"big":{"$repeat":["q",614400]}}}}}}} },
  { ...{"name":"many-medium-fields-cannot-fit","note":"Shrinking fields cannot bring it under budget (the result is still > maxBytes), so the whole payload is replaced by the marker, structural fields and all.","v1Sha256":"7c855f532ff78d268cbefc7f8cbab6ed09ab095e16148248c91f3712ae01f6b1","v1Truncated":true}, input: mediumFields(300) },
  { ...{"name":"marker-key-collision","note":"User keys named like marker keys: existing keys keep their POSITION and take the marker value (object spread / dict update semantics).","type":"node.finished","v1Sha256":"8b878f4b62125ef75153864c0068cd52789eac34ea592ad0f712fc779d9414fa","v1Truncated":true}, input: {"preview":"mine","nodeId":"tool:t","fields":["user"],"durationMs":1,"status":"ok","output":{"bytes":5,"body":{"$repeat":["z",614400]},"__graphmindTruncated":false}} },
  { ...{"name":"small-max-bytes-falls-back","note":"With maxBytes 4096 the trimmed result (2,000-unit string + 2,000-unit preview) does not fit, so the whole-payload marker is used.","maxBytes":4096,"v1Sha256":"8fa5a85519728c821a83c14254cd3f3e9d73ce8591c4a1e7a04a06299121c38f","v1Truncated":true}, input: {"nodeId":"tool:t","output":{"$repeat":["x",5000]}} },
  { ...{"name":"small-max-bytes-fits","note":"With maxBytes 16384 the same payload is trimmed field-wise.","maxBytes":16384,"v1Sha256":"2c93241083f53fcf033dd07c96ef925c6d163ba62031ca2da47f85c95d7dcc94","v1Truncated":true}, input: {"nodeId":"tool:t","output":{"$repeat":["x",20000]}} },
  { ...{"name":"already-truncated-is-untouched","note":"Idempotent: the result of huge-ascii-string-field fed back in is within budget and unchanged (no double marking).","type":"node.finished","v1Sha256":"d4f7eba373753585ddc4e5d287ea496669ee5ec28f5ec9addcb87cf31a8b38f9","v1Truncated":false}, input: RESULT_OF("huge-ascii-string-field") },
];

/** Why a v1 case's output changed in v2 (required for every changed one). */
const V1_CHANGES = {};

const CONTROL = String.fromCharCode(1);
const record = { name: 'record', score: 0.5, desc: 'a short description of the record' };

const V2_CASES = [
  {
    name: 'keyed-records-node-finished',
    note: 'Defect 1: an output of 8,000 records keyed by id (~655 KB). The key cap keeps the first MAX_SHRINK_KEYS (256) records and adds __graphmindTruncated, bytes, preview and keysDropped (7,744), so the field trim fits and the event stays a valid node.finished.',
    type: 'node.finished',
    input: { nodeId: 'tool:list', instanceId: 'l1', durationMs: 3, status: 'ok', output: { $keys: ['id', 8000, record] } },
  },
  {
    name: 'many-medium-fields-node-finished',
    note: 'Defect 1: 300 top-level fields of 3,000 units before the required ones. The field trim is attempted (300 <= MAX_TRIM_FIELDS) but cannot fit: 300 fields cut to 2,000 units are still over budget. The skeleton keeps the required nodeId, durationMs and status verbatim and lists every other key in `fields`.',
    type: 'node.finished',
    input: { $merge: [{ $keys: ['f', 300, { $repeat: ['m', 3000] }] }, { nodeId: 'tool:t', durationMs: 1, status: 'ok' }] },
  },
  {
    name: 'typed-array-2m-keys-node-finished',
    note: 'Defect 2: a 2,000,000-element typed array serializes as an object with integer-like keys "0".."1999999" (expand {"$keys": ["", 2000000, 7]}). The shrink keeps keys 0..255 plus keysDropped 1,999,744, without shrinking the rest.',
    type: 'node.finished',
    input: { nodeId: 'tool:read', instanceId: 'r1', durationMs: 2, status: 'ok', output: { $keys: ['', 2000000, 7] } },
  },
  {
    name: 'node-error-1mb-message-10k-extra-keys',
    note: 'The required `error` object has 10,000 extra keys BEFORE name and message, and a ~1 MB message. The field trim caps `error` at its first 256 keys, which loses name and message: not a valid node.error, so the skeleton is used. error keeps name, message (cut to SKELETON_CHARS units + suffix) and the optional string stack; the optional string instanceId is kept too; error (not verbatim) is listed in `fields`.',
    type: 'node.error',
    input: {
      nodeId: 'llm:step',
      instanceId: 'l1',
      error: {
        $merge: [
          { $keys: ['k', 10000, 'filler'] },
          { name: 'APIError', message: { $repeat: ['provider said: e', 65536] }, stack: 'at call (x.ts:1:1)' },
        ],
      },
    },
  },
  {
    name: 'skeleton-result-is-untouched',
    note: 'Idempotent: the result of node-error-1mb-message-10k-extra-keys fed back in is within budget and returned unchanged.',
    type: 'node.error',
    input: RESULT_OF('node-error-1mb-message-10k-extra-keys'),
  },
  {
    name: 'run-started-huge-meta',
    note: 'run.started with a 50,000-key `meta`: the key cap makes the field trim fit.',
    type: 'run.started',
    input: { app: 'demo', sdk: { name: 'ai', version: '7.0.79' }, meta: { $keys: ['m', 50000, 'some metadata value'] } },
  },
  {
    name: 'run-started-huge-meta-small-budget',
    note: 'maxBytes 4096: the trimmed result (a 2,000-unit preview plus 256 meta keys) does not fit, so the skeleton keeps app and sdk {name, version}; sdk had an extra key, so it is not verbatim and is listed in `fields` with meta.',
    type: 'run.started',
    maxBytes: 4096,
    input: { app: 'demo', sdk: { name: 'ai', version: '7.0.79', build: 'abc' }, meta: { $keys: ['m', 3000, 'v'] } },
  },
  {
    name: 'huge-loose-field-before-required',
    note: 'A 700 KB loose field inserted before the required fields: the field trim cuts it and keeps everything else.',
    type: 'node.started',
    input: { blob: { $repeat: ['z', 700000] }, nodeId: 'tool:s', kind: 'tool', name: 'search', instanceId: 's1', input: { q: 1 } },
  },
  {
    name: 'huge-loose-field-before-required-small-budget',
    note: 'The same shape at maxBytes 4096: the trim does not fit (2,000-unit field + 2,000-unit preview); the skeleton keeps nodeId, kind, name, instanceId and lists blob and input.',
    type: 'node.started',
    maxBytes: 4096,
    input: { blob: { $repeat: ['z', 10000] }, nodeId: 'tool:s', kind: 'tool', name: 'search', instanceId: 's1', input: { q: 1 } },
  },
  {
    name: 'astral-at-256-cut-skeleton-no-preview',
    note: 'maxBytes 4096, message = 255 "a" then emoji: the skeleton cuts it at 256 units, splitting a surrogate pair (JSON writes the lone high half as \\ud83d). With the 2,000-unit preview the first attempt is over budget, so the second attempt (preview "", no fields) is used.',
    type: 'node.error',
    maxBytes: 4096,
    input: { nodeId: 'llm:step', error: { name: 'E', message: { $concat: [{ $repeat: ['a', 255] }, { $repeat: ['😀', 3000] }] } } },
  },
  {
    name: 'cjk-at-256-cut-skeleton-multibyte-preview',
    note: 'maxBytes 8192, a message of 5,000 "中": the trim does not fit (2,000 CJK units in the field and in the preview); the first skeleton attempt does — 256 CJK units plus a 2,000-unit preview.',
    type: 'node.error',
    maxBytes: 8192,
    input: { nodeId: 'llm:step', error: { name: 'E', message: { $repeat: ['中', 5000] } } },
  },
  {
    name: 'astral-at-2000-cut-field-trim',
    note: 'The field trim cuts the output at 2,000 units, between the halves of a surrogate pair.',
    type: 'node.finished',
    input: { nodeId: 'tool:t', durationMs: 1, status: 'ok', output: { $concat: [{ $repeat: ['a', 1999] }, { $repeat: ['😀', 300000] }] } },
  },
  {
    name: 'escape-heavy-skeleton-min-chars',
    note: 'maxBytes 4096, three required strings of 300 U+0001 (6 bytes of JSON each): 256-unit strings cannot fit even without the preview, so the third attempt cuts them at SKELETON_MIN_CHARS (32) units.',
    type: 'node.started',
    maxBytes: 4096,
    input: {
      nodeId: { $repeat: [CONTROL, 300] },
      kind: 'tool',
      name: { $repeat: [CONTROL, 300] },
      instanceId: { $repeat: [CONTROL, 300] },
      input: { $repeat: ['x', 5000] },
    },
  },
  {
    name: 'unknown-type-whole-marker',
    note: 'A type the schema does not know gets no skeleton: 300 fields fall back to the whole-payload marker, exactly as without a type.',
    type: 'node.custom',
    input: { $merge: [{ nodeId: 'n' }, { $keys: ['f', 300, { $repeat: ['m', 3000] }] }] },
  },
  {
    name: 'invalid-input-with-type-whole-marker',
    note: 'A node.finished without its required status is not a valid event to begin with: the skeleton cannot validate, so the whole-payload marker is returned.',
    type: 'node.finished',
    input: { $merge: [{ nodeId: 'n', durationMs: 1 }, { $keys: ['f', 300, { $repeat: ['m', 3000] }] }] },
  },
  {
    name: 'nested-key-cap-and-exact-256',
    note: 'Inside a shrunk field, an object of 300 keys (depth 1) keeps 256 and gets __graphmindTruncated + keysDropped 44 (no bytes/preview below the top); an object of exactly 256 keys is not capped.',
    type: 'node.finished',
    input: {
      nodeId: 'tool:t',
      durationMs: 1,
      status: 'ok',
      output: { table: { $keys: ['r', 300, 1] }, exact: { $keys: ['e', 256, 0] }, body: { $repeat: ['b', 600000] } },
    },
  },
  {
    name: 'top-level-field-cap',
    note: 'A capped object AT the top of a field: its kept keys, then __graphmindTruncated, bytes (JSON length in UTF-16 units) and preview, then keysDropped.',
    type: 'node.finished',
    input: { nodeId: 'tool:t', durationMs: 1, status: 'ok', output: { $keys: ['v', 100000, 1] } },
  },
  {
    name: 'proto-key-is-an-ordinary-key',
    note: 'A payload key named "__proto__" is an ordinary own key (as JSON.parse, Python and Ruby treat it) and is shrunk like any other.',
    type: 'node.finished',
    input: JSON.parse('{"__proto__":{"$repeat":["p",600000]},"nodeId":"tool:t","durationMs":1,"status":"ok"}'),
  },
  {
    name: 'graph-hint-skeleton-empty-array',
    note: 'The skeleton keeps a required array as [] (verbatim only if it was already empty, so `nodes` is listed).',
    type: 'graph.hint',
    input: { $merge: [{ $keys: ['x', 300, { $repeat: ['h', 2000] }] }, { nodes: [{ nodeId: 'a', kind: 'tool', name: 'a' }] }] },
  },
  {
    name: 'exec-paused-skeleton-drops-optional-object',
    note: 'maxBytes 4096: the skeleton keeps pauseId, nodeId, point and the optional string reason; the optional OBJECT loop is dropped and listed in `fields`.',
    type: 'exec.paused',
    maxBytes: 4096,
    input: {
      pauseId: 'p1',
      nodeId: 'tool:t',
      point: 'error',
      reason: 'error',
      loop: { repeats: 1, firstSeq: 1, lastSeq: 1, fingerprint: { $repeat: ['f', 6000] } },
    },
  },
  {
    name: 'exec-paused-skeleton-keeps-instance-id',
    note: 'maxBytes 4096 (0.6.0 fields): the skeleton keeps the optional boolean editable and the optional string instanceId — which execution is held survives a shrink — and drops the optional OBJECT smart.',
    type: 'exec.paused',
    maxBytes: 4096,
    input: {
      pauseId: 'p2',
      nodeId: 'tool:t',
      point: 'after',
      reason: 'breakpoint',
      smart: { rule: 'error-result', detail: { $repeat: ['d', 6000] } },
      editable: true,
      instanceId: 'call-7',
    },
  },
  {
    name: 'run-finished-400-small-fields-trimmed',
    note: 'run.finished with 400 small loose fields and a 700 KB error.message: 400 <= MAX_TRIM_FIELDS, so the field trim runs and keeps every small field; only error is shrunk (its message cut to PREVIEW_CHARS). With the old 256-field gate this went to the skeleton and lost them.',
    type: 'run.finished',
    input: { $merge: [{ $keys: ['x', 400, 'yyyyyyyyyy'] }, { status: 'error', error: { name: 'E', message: { $repeat: ['m', 700000] } } }] },
  },
  {
    name: 'many-small-fields-trim-keeps-them',
    note: 'MAX_TRIM_FIELDS (4,096), not MAX_SHRINK_KEYS, gates the field trim: 300 small top-level fields plus one huge output are trimmed field by field, so every small field survives.',
    type: 'node.finished',
    input: { $merge: [{ nodeId: 'tool:t', durationMs: 1, status: 'ok' }, { $keys: ['k', 300, 1] }, { output: { $repeat: ['o', 600000] } }] },
  },
  {
    name: 'over-max-trim-fields-goes-to-skeleton',
    note: 'More than MAX_TRIM_FIELDS (4,096) top-level fields: the field trim is not attempted and the skeleton is used.',
    type: 'node.finished',
    input: { $merge: [{ $keys: ['k', 4097, 'vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv'] }, { nodeId: 'tool:t', durationMs: 1, status: 'ok' }] },
  },
  {
    name: 'node-token-trim-keeps-deltas-array',
    note: 'An oversized delta batch: the field trim turns deltas into [] (still a valid node.token).',
    type: 'node.token',
    input: { nodeId: 'llm:step', deltas: [{ t: 'text', v: { $repeat: ['d', 600000] } }] },
  },
];

function planToJson(plan) {
  const out = {};
  for (const [key, sub] of plan.keys) out[key] = sub === null || sub === 'optional' ? sub : planToJson(sub);
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function expected(result) {
  const bytes = utf8ByteLength(result.json);
  if (bytes <= EXACT_LIMIT) return { truncated: result.truncated, json: result.json };
  return {
    truncated: result.truncated,
    jsonBytes: bytes,
    jsonSha256: sha256(result.json),
    jsonHead: result.json.slice(0, 160),
    jsonTail: result.json.slice(-160),
  };
}

function run(definition) {
  let input = definition.input;
  if (input !== null && typeof input === 'object' && Object.hasOwn(input, '$resultOf')) {
    input = JSON.parse(RESULTS.get(input.$resultOf).json);
  }
  const result = serializePayload(expand(input), definition.maxBytes ?? MAX_PAYLOAD_BYTES, definition.type);
  RESULTS.set(definition.name, result);
  return { input, result };
}

const cases = [];
for (const definition of V1_CASES) {
  const { input, result } = run(definition);
  const same = sha256(result.json) === definition.v1Sha256 && result.truncated === definition.v1Truncated;
  const reason = V1_CHANGES[definition.name];
  if (!same && reason === undefined) {
    throw new Error(`v1 case ${definition.name} changed; add the reason to V1_CHANGES`);
  }
  cases.push({
    name: definition.name,
    note: definition.note,
    since: 1,
    v1: same ? 'unchanged' : reason,
    ...(definition.type === undefined ? {} : { type: definition.type }),
    ...(definition.maxBytes === undefined ? {} : { maxBytes: definition.maxBytes }),
    input,
    expected: expected(result),
  });
}
for (const definition of V2_CASES) {
  const { input, result } = run(definition);
  cases.push({
    name: definition.name,
    note: definition.note,
    since: 2,
    type: definition.type,
    ...(definition.maxBytes === undefined ? {} : { maxBytes: definition.maxBytes }),
    input,
    expected: expected(result),
  });
}

const skeletonPlans = {};
for (const type of EVENT_TYPES) {
  const plan = skeletonPlan(type);
  if (plan !== undefined) skeletonPlans[type] = planToJson(plan);
}

const fixture = {
  version: 2,
  description:
    'Conformance fixture for serializePayload (packages/schema/src/shrink.ts), regenerated by gen-shrink.mjs. For each case: expand the input, call serializePayload(input, maxBytes ?? MAX_PAYLOAD_BYTES, type) (no "type" = called without one), and compare the JSON text byte for byte and the truncated flag. Version-1 cases keep their names and inputs ("since": 1); "v1" says whether the expected output changed from version 1 and why.',
  generator:
    'Expand recursively before calling serializePayload. An object whose ONLY key is one of these stands for: "$repeat": [unit, count] -> unit repeated count times; "$array": [item, count] -> an array of count expanded copies of item; "$concat": [part, ...] -> the expanded string parts joined; "$keys": [prefix, count, item] -> an object with keys prefix+"0" .. prefix+(count-1), in that order, each an expanded copy of item (prefix "" gives integer-like keys, ascending: the JSON of a typed array); "$merge": [object, ...] -> the expanded objects shallow-merged in order (no case repeats a key). Object key order is as written; "__proto__" is an ordinary own key. Expected results of up to 16 KB carry the exact "json" text; larger ones carry "jsonBytes" (UTF-8 length), "jsonSha256" (hex SHA-256 of the UTF-8 json text) and the first/last 160 UTF-16 units for diagnostics. No object mixes integer-like keys with other keys (JavaScript would enumerate the integer-like ones first).',
  skeleton:
    '"skeletonPlans" lists, per known event type, its schema keys in declaration order: null = a required field (kept, hard-shrunk); a nested object = a required loose-object field (kept as an object of its own planned keys, recursively); "optional" = an optional field, kept (hard-shrunk) only when its value is a string, number or boolean. Types not listed get no skeleton (whole-payload marker). Skeleton attempts, first that validates and fits wins: [SKELETON_CHARS, preview + fields], [SKELETON_CHARS, preview "" and no fields], [SKELETON_MIN_CHARS, preview "" and no fields]. See the TIERS comment in shrink.ts.',
  constants: {
    MAX_PAYLOAD_BYTES,
    PREVIEW_CHARS,
    MAX_SHRINK_DEPTH,
    TRUNCATION_SUFFIX,
    MAX_SHRINK_KEYS,
    MAX_TRIM_FIELDS,
    SKELETON_CHARS,
    SKELETON_MIN_CHARS,
  },
  skeletonPlans,
  cases,
};

const target = fileURLToPath(new URL('./shrink.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`[gen-shrink] wrote ${cases.length} cases to ${target}`);
