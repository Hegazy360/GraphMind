# frozen_string_literal: true

require_relative "test_helper"
require "digest"
require "open3"
require "tmpdir"
require "timeout"

# SHRINK-V2 port: Graphmind::Shrink against packages/schema/test/fixtures/shrink.json
# byte for byte, plus the invariant "a valid event, shrunk, is a valid event
# within budget", the UTF-16 unit helpers, and (when node and the built schema
# package are present) a differential run against the TypeScript reference.
class TestShrink < Minitest::Test
  S = Graphmind::Shrink
  FIXTURE = File.join(GraphmindTest::REPO_ROOT, "packages", "schema", "test", "fixtures", "shrink.json")
  SCHEMA_DIST = File.join(GraphmindTest::REPO_ROOT, "packages", "schema", "dist", "shrink.js")

  # Ruby's JSON parser refuses an unpaired \uD800-\uDFFF escape, so the file
  # cannot be parsed as is. An escape preceded by an odd run of backslashes
  # that is not the first half of a pair is replaced by this sentinel; a case
  # whose INPUT then contains it is skipped by name (its output depends on a
  # string Ruby cannot represent). Escapes inside expected JSON texts are
  # preceded by an even run and are left alone.
  LONE = "__graphmind_test_lone_surrogate__"
  LONE_ESCAPE_RE = /(?<!\\)((?:\\\\)*)\\u([dD][89a-fA-F][0-9a-fA-F]{2})(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/
  # Cases skipped in Ruby because their input needs a lone surrogate.
  NEEDS_LONE_SURROGATE = ["under-budget-object"].freeze

  class << self
    def fixture
      @fixture ||= begin
        raw = File.read(FIXTURE, encoding: "UTF-8")
        cleaned = raw.gsub(LONE_ESCAPE_RE) do
          match = Regexp.last_match
          # A low half that follows a high half was consumed with it.
          prefix = match.pre_match
          if match[2].match?(/\A[dD][c-fC-F]/) && prefix.match?(/\\u[dD][89abAB][0-9a-fA-F]{2}\z/)
            match[0]
          else
            "#{match[1]}#{LONE}"
          end
        end
        JSON.parse(cleaned, max_nesting: false)
      end
    end
  end

  def fixture = self.class.fixture

  # -- fixture notation ---------------------------------------------------------

  def expand(value)
    case value
    when Array then value.map { |item| expand(item) }
    when Hash
      if value.size == 1
        key, args = value.first
        case key
        when "$repeat" then return args[0] * args[1]
        when "$array" then return Array.new(args[1]) { expand(args[0]) }
        when "$concat" then return args.map { |part| expand(part) }.join
        when "$keys"
          prefix, count, item = args
          out = {}
          count.times { |i| out["#{prefix}#{i}"] = expand(item) }
          return out
        when "$merge"
          out = {}
          args.each { |part| expand(part).each { |k, v| out[k] = v } }
          return out
        end
      end
      value.to_h { |k, v| [k, expand(v)] }
    else value
    end
  end

  def contains_lone?(value)
    case value
    when String then value.include?(LONE)
    when Array then value.any? { |v| contains_lone?(v) }
    when Hash then value.any? { |k, v| k.include?(LONE) || contains_lone?(v) }
    else false
    end
  end

  def plan_to_json(plan)
    plan.to_h { |k, sub| [k, sub.is_a?(Hash) ? plan_to_json(sub) : (sub == :optional ? "optional" : sub)] }
  end

  # -- fixture ------------------------------------------------------------------

  def test_fixture_is_version_2_with_the_constants_this_port_uses
    assert_equal 2, fixture["version"]
    constants = fixture["constants"]
    assert_equal S::MAX_PAYLOAD_BYTES, constants["MAX_PAYLOAD_BYTES"]
    assert_equal S::PREVIEW_CHARS, constants["PREVIEW_CHARS"]
    assert_equal S::MAX_SHRINK_DEPTH, constants["MAX_SHRINK_DEPTH"]
    assert_equal S::TRUNCATION_SUFFIX, constants["TRUNCATION_SUFFIX"]
    assert_equal S::MAX_SHRINK_KEYS, constants["MAX_SHRINK_KEYS"]
    assert_equal S::MAX_TRIM_FIELDS, constants["MAX_TRIM_FIELDS"]
    assert_equal S::SKELETON_CHARS, constants["SKELETON_CHARS"]
    assert_equal S::SKELETON_MIN_CHARS, constants["SKELETON_MIN_CHARS"]
    assert_equal 49, fixture["cases"].length
  end

  def test_skeleton_plans_equal_the_fixture_in_declaration_order
    expected = fixture["skeletonPlans"]
    actual = S::PLANS.to_h { |type, plan| [type, plan_to_json(plan)] }
    assert_equal expected.keys, actual.keys
    expected.each do |type, plan|
      assert_equal JSON.generate(plan), JSON.generate(actual[type]), "plan for #{type} (keys in order)"
    end
    assert_equal Graphmind::Protocol::EVENT_TYPES.sort, S::PLANS.keys.sort
  end

  def test_only_the_named_cases_need_a_lone_surrogate
    needing = fixture["cases"].select { |c| contains_lone?(c["input"]) }.map { |c| c["name"] }
    assert_equal NEEDS_LONE_SURROGATE, needing
  end

  def check_case(testcase)
    input = expand(testcase["input"])
    max_bytes = testcase["maxBytes"] || S::MAX_PAYLOAD_BYTES
    json, payload, truncated = S.serialize_payload(input, max_bytes, testcase["type"])
    expected = testcase["expected"]
    name = testcase["name"]
    assert_equal expected["truncated"], truncated, "#{name}: truncated"
    assert_equal json, S.stringify(payload), "#{name}: json is the text of the returned payload"
    if expected.key?("json")
      unless json == expected["json"]
        at = 0
        at += 1 while at < json.bytesize && json.getbyte(at) == expected["json"].getbyte(at)
        flunk("#{name}: json differs at byte #{at}: got #{json.byteslice(at, 80).inspect}, " \
              "want #{expected['json'].byteslice(at, 80).inspect}")
      end
    else
      assert_equal expected["jsonBytes"], json.bytesize, "#{name}: jsonBytes " \
                                                         "(head #{S.prefix(json, 160).inspect})"
      assert_equal expected["jsonHead"], S.prefix(json, 160), "#{name}: jsonHead"
      assert_equal expected["jsonSha256"], Digest::SHA256.hexdigest(json), "#{name}: jsonSha256"
    end
    if truncated
      assert_equal true, payload["__graphmindTruncated"], "#{name}: marked"
    else
      assert_same input, payload, "#{name}: untouched means the same object back"
    end
  end

  fixture["cases"].each do |testcase|
    define_method("test_fixture_case_#{testcase['name'].tr('-', '_')}") do
      skip("needs a lone UTF-16 surrogate in its input, which a Ruby String cannot hold") if
        NEEDS_LONE_SURROGATE.include?(testcase["name"])
      check_case(testcase)
    end
  end

  # -- units ----------------------------------------------------------------------

  EMOJI = [0x1F600].pack("U")
  CJK = [0x4E2D].pack("U")

  def test_utf16_length_counts_astral_characters_as_two
    assert_equal 0, S.utf16_length("")
    assert_equal 1, S.utf16_length("a")
    assert_equal 1, S.utf16_length([0xE9].pack("U"))
    assert_equal 1, S.utf16_length(CJK)
    assert_equal 2, S.utf16_length(EMOJI)
    assert_equal 1 + 1 + 2 + 1, S.utf16_length("a#{CJK}#{EMOJI}b")
  end

  def test_prefix_splits_a_surrogate_pair_like_javascript
    text = "a#{EMOJI}b"
    assert_equal "a", S.prefix(text, 1)
    half = S.prefix(text, 2)
    refute half.valid_encoding?, "a lone high surrogate is not valid UTF-8"
    assert_equal 2, S.utf16_length(half)
    assert_equal 4, half.bytesize, "a lone surrogate counts 3 UTF-8 bytes, as JavaScript counts it"
    assert_equal "\"a\\ud83d\"", S.stringify(half)
    assert_equal "a#{EMOJI}", S.prefix(text, 3)
    assert_same text, S.prefix(text, 4)
    # The suffix after a kept half still serializes.
    assert_equal "\"a\\ud83d#{S::TRUNCATION_SUFFIX}\"", S.stringify(half + S::TRUNCATION_SUFFIX)
  end

  def test_a_kept_high_half_followed_by_a_low_half_is_one_character
    high = S.prefix(EMOJI, 1)
    low = [0xED, 0xB8, 0x80].pack("C*").force_encoding(Encoding::UTF_8)
    assert_equal "\"#{EMOJI}\"", S.stringify(high + low)
    assert_equal "\"\\ude00\"", S.stringify(low)
  end

  def test_stringify_matches_json_stringify_for_escapes_numbers_and_symbols
    controls = (0..0x1F).map(&:chr).join
    assert_equal '"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f' \
                 '\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d' \
                 '\\u001e\\u001f"', S.stringify(controls)
    line_sep = [0x2028].pack("U")
    assert_equal "\"\\\"\\\\/\x7F#{line_sep}\"", S.stringify("\"\\/\x7F#{line_sep}")
    assert_equal "[1,1.5,100000000000000000000,1e+21,1e-7,0,0,null,null,9007199254740992,12345678901234567000]",
                 S.stringify([1.0, 1.5, 1e20, 1e21, 1e-7, 0.0, -0.0, Float::NAN, Float::INFINITY, 2**53,
                              12_345_678_901_234_567_890])
    assert_equal '{"a":"b","__proto__":null,"1":true,"x":false}', S.stringify({ a: :b, "__proto__" => nil, 1 => true, "x" => false })
  end

  def test_unserializable_values_take_the_unserializable_path_and_never_raise
    cyclic = { "nodeId" => "n", "durationMs" => 1, "status" => "ok" }
    cyclic["output"] = cyclic
    json, payload, truncated = S.serialize_payload(cyclic, S::MAX_PAYLOAD_BYTES, "node.finished")
    assert truncated
    assert S.valid_for?("node.finished", payload)
    assert_equal ["output"], payload["fields"]
    assert_equal json, S.stringify(payload)

    [Object.new, "\xFF".b.force_encoding(Encoding::UTF_8)].each do |bad|
      json, payload, truncated = S.serialize_payload({ "nodeId" => "n", "kind" => "tool", "name" => "t",
                                                       "instanceId" => "i", "input" => bad }, 4096, "node.started")
      assert truncated
      assert S.valid_for?("node.started", payload), json
    end

    deep = []
    (S::MAX_JSON_DEPTH - 1).times { deep = [deep] }
    assert_equal S::MAX_JSON_DEPTH, S.stringify(deep).count("[")
    json, payload, truncated = S.serialize_payload([deep])
    assert truncated
    assert_equal '{"__graphmindTruncated":true,"bytes":0,"preview":"[unserializable payload]"}', json
    assert_equal "[unserializable payload]", payload["preview"]
  end

  # -- invariant: a valid event, shrunk, is a valid event within budget ----------

  BIG = "x" * 700_000

  def hostile_events
    wide = (0...5000).to_h { |i| ["k#{i}", "filler"] }
    medium = (0...300).to_h { |i| ["f#{i}", "m" * 3000] }
    {
      "run.started" => { "app" => BIG, "sdk" => wide.merge("name" => BIG, "version" => "1"), "meta" => wide },
      "run.finished" => medium.merge("status" => "error", "error" => wide.merge("name" => "E", "message" => BIG)),
      "graph.hint" => medium.merge("nodes" => Array.new(3000) { |i| { "nodeId" => "n#{i}", "kind" => "tool", "name" => BIG[0, 300] } }),
      "node.started" => medium.merge("nodeId" => BIG, "kind" => "tool", "name" => EMOJI * 200_000,
                                     "instanceId" => "\x01" * 100_000, "input" => wide),
      "node.token" => { "nodeId" => "n", "deltas" => Array.new(10) { { "t" => "text", "v" => BIG } } },
      "node.finished" => medium.merge("nodeId" => "n", "instanceId" => CJK * 300_000, "durationMs" => 1.5,
                                      "status" => "ok", "output" => wide, "usage" => { "inputTokens" => 1, "outputTokens" => 2 }),
      "node.error" => { "nodeId" => "n", "error" => wide.merge("name" => "E", "message" => BIG, "stack" => BIG) },
      "exec.paused" => medium.merge("pauseId" => "p", "nodeId" => BIG, "point" => "error", "reason" => "loop",
                                    "loop" => { "repeats" => 3, "firstSeq" => 1, "lastSeq" => 5, "fingerprint" => BIG }),
      "exec.resumed" => medium.merge("pauseId" => BIG, "action" => "inject")
    }
  end

  def test_every_valid_event_type_shrinks_to_a_valid_event_within_every_budget
    hostile_events.each do |type, payload|
      assert S.valid_for?(type, payload), "#{type}: the input must be a valid event"
      before = Marshal.dump(payload)
      [4096, 65_536, S::MAX_PAYLOAD_BYTES].each do |max_bytes|
        json, shrunk, truncated = S.serialize_payload(payload, max_bytes, type)
        assert truncated, "#{type} @#{max_bytes}"
        assert_operator json.bytesize, :<=, max_bytes, "#{type} @#{max_bytes}: within budget"
        assert S.valid_for?(type, shrunk), "#{type} @#{max_bytes}: still a valid event (#{json[0, 200]})"
        assert S.valid_for?(type, JSON.parse(json)), "#{type} @#{max_bytes}: the text is a valid event too"
        again, again_payload, again_truncated = S.serialize_payload(shrunk, max_bytes, type)
        refute again_truncated, "#{type} @#{max_bytes}: idempotent"
        assert_same shrunk, again_payload
        assert_equal json, again
      end
      assert_equal before, Marshal.dump(payload), "#{type}: the input is not mutated"
    end
  end

  def test_an_invalid_event_is_the_only_one_that_becomes_the_whole_payload_marker
    payload = { "nodeId" => "n", "durationMs" => 1, "output" => BIG } # no status
    refute S.valid_for?("node.finished", payload)
    _json, shrunk, truncated = S.serialize_payload(payload, S::MAX_PAYLOAD_BYTES, "node.finished")
    assert truncated
    assert_equal %w[__graphmindTruncated bytes preview], shrunk.keys
  end

  def test_symbol_keys_and_values_serialize_as_their_names
    payload = { nodeId: :n, durationMs: 1, status: :ok, output: BIG }
    json, shrunk, truncated = S.serialize_payload(payload, S::MAX_PAYLOAD_BYTES, :"node.finished")
    assert truncated
    assert S.valid_for?("node.finished", JSON.parse(json))
    assert_equal ["output"], shrunk["fields"]
  end

  # -- the schema mirror ---------------------------------------------------------

  def test_the_schema_mirror_follows_zod_on_the_edges
    base = { "nodeId" => "n", "durationMs" => 1, "status" => "ok" }
    assert S.valid_for?("node.finished", base)
    refute S.valid_for?("node.finished", base.merge("instanceId" => nil)), "optional is not nullable"
    assert S.valid_for?("node.finished", base.merge("output" => nil)), "unknown accepts null"
    refute S.valid_for?("node.finished", base.merge("durationMs" => Float::INFINITY))
    refute S.valid_for?("node.finished", base.merge("durationMs" => -1))
    assert S.valid_for?("node.finished", base.merge("durationMs" => -0.0))
    assert S.valid_for?("node.finished", base.merge("usage" => { "inputTokens" => 3.0, "outputTokens" => (2**53) - 1 }))
    refute S.valid_for?("node.finished", base.merge("usage" => { "inputTokens" => 2**53, "outputTokens" => 1 }))
    refute S.valid_for?("node.finished", base.merge("status" => "done"))
    refute S.valid_for?("node.finished", [base])
    refute S.valid_for?("run.started", { "app" => "a", "sdk" => { "name" => "a", "version" => "b" }, "meta" => [] })
    assert S.valid_for?("custom.type", "anything"), "unknown types are opaque"
  end

  # -- differential: the TypeScript reference itself -----------------------------

  NODE_SCRIPT = <<~JS
    import { readFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const dist = process.argv[2];
    const { serializePayload } = await import(pathToFileURL(dist + '/shrink.js').href);
    const { EventPayloadSchemas } = await import(pathToFileURL(dist + '/index.js').href);
    const cases = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const out = cases.map(({ payload, maxBytes, type }) => {
      const input = JSON.parse(payload);
      const r = serializePayload(input, maxBytes, type ?? undefined);
      const schema = type == null ? undefined : EventPayloadSchemas[type];
      return {
        json: r.json,
        truncated: r.truncated,
        valid: schema === undefined ? true : schema.safeParse(JSON.parse(r.json)).success,
        inputValid: schema === undefined ? true : schema.safeParse(input).success,
      };
    });
    process.stdout.write(JSON.stringify(out));
  JS

  # Random JSON-shaped values with no integer-like keys (JavaScript would
  # reorder them) and no lone surrogates. `small` keeps wide objects' members
  # small, so a case stays a few megabytes at most.
  def random_value(rng, depth, small = false)
    case rng.rand(depth > 3 ? 6 : 9)
    when 0 then nil
    when 1 then rng.rand < 0.5
    when 2 then [rng.rand(-1000..1000), rng.rand * 1e6, 1e20, 1e-7, 0.1, 2**40][rng.rand(6)]
    when 3, 4, 5 then random_string(rng, small ? 2 : 4, small)
    when 6 then Array.new(rng.rand(small ? 3 : 6)) { random_value(rng, depth + 1, small) }
    else
      count = small ? rng.rand(4) : [0, 3, 8, 300, 1200][rng.rand(5)]
      wide = count > 8
      (0...count).to_h { |i| ["k#{i}#{random_key_suffix(rng)}", random_value(rng, depth + 1, small || wide)] }
    end
  end

  UNITS = ["a", "\u00e9".encode("UTF-8"), CJK, EMOJI, "\x01", "\"", "\\", "\n", [0x2028].pack("U"), "/", " "].freeze
  REPEATS = [1, 2, 7, 255, 256, 1999, 2000, 2001, 40_000, 300_000].freeze

  # Keys carry no JSON escapes: Node 24.19's JSON.parse returns a wrong key
  # for "p\\n" (and \", \t, \u0001) once it has parsed the key "p\\\\" — the
  # reference itself would disagree with its own input. Values keep them.
  KEY_UNITS = ["a", "\u00e9".encode("UTF-8"), CJK, EMOJI, "/", " ", [0x2028].pack("U")].freeze

  def random_key_suffix(rng)
    Array.new(rng.rand(3)) { KEY_UNITS[rng.rand(KEY_UNITS.size)] * [1, 3, 32][rng.rand(3)] }.join
  end

  def random_string(rng, max_parts = 4, small = false)
    Array.new(rng.rand(max_parts + 1)) do
      count = small ? [1, 3, 31, 32, 33][rng.rand(5)] : REPEATS[rng.rand(REPEATS.size)]
      UNITS[rng.rand(UNITS.size)] * count
    end.join
  end

  def random_event(rng, type)
    bulk = -> { random_value(rng, 0) }
    str = -> { rng.rand < 0.3 ? random_string(rng) : "id-#{rng.rand(100)}" }
    base =
      case type
      when "run.started" then { "app" => str.call, "sdk" => { "name" => str.call, "version" => str.call }, "meta" => { "m" => bulk.call } }
      when "run.finished" then { "status" => "error", "error" => { "name" => str.call, "message" => str.call, "x" => bulk.call } }
      when "graph.hint" then { "nodes" => Array.new(rng.rand(4)) { { "nodeId" => str.call, "kind" => "llm", "name" => str.call } } }
      when "node.started" then { "nodeId" => str.call, "kind" => "tool", "name" => str.call, "instanceId" => str.call, "input" => bulk.call }
      when "node.token" then { "nodeId" => str.call, "deltas" => Array.new(rng.rand(4)) { { "t" => "text", "v" => str.call } } }
      when "node.finished" then { "nodeId" => str.call, "durationMs" => rng.rand * 100, "status" => "ok", "output" => bulk.call }
      when "node.error" then { "nodeId" => str.call, "error" => { "name" => str.call, "message" => str.call, "stack" => str.call } }
      when "exec.paused" then { "pauseId" => str.call, "nodeId" => str.call, "point" => "after", "reason" => "step" }
      when "exec.resumed" then { "pauseId" => str.call, "action" => "retry" }
      else { "v" => bulk.call }
      end
    extras = rng.rand(3).zero? ? (0...rng.rand(1..400)).to_h { |i| ["x#{i}", random_value(rng, 1, true)] } : {}
    if rng.rand < 0.15 && !base.empty?
      # Not a valid event: a required field missing or of the wrong type.
      key = base.keys[rng.rand(base.size)]
      rng.rand < 0.5 ? base.delete(key) : base[key] = [nil, 1, [], {}][rng.rand(4)]
    end
    rng.rand < 0.5 ? extras.merge(base) : base.merge(extras)
  end

  def test_differential_against_the_typescript_reference
    node = ENV.fetch("GRAPHMIND_NODE", "node")
    _out, status = Open3.capture2e(node, "--version")
    skip("node is not available") unless status.success?
    skip("packages/schema is not built (pnpm --filter @graphmind-ai/schema build)") unless File.exist?(SCHEMA_DIST)
  rescue Errno::ENOENT
    skip("node is not available")
  else
    seed = Integer(ENV.fetch("GRAPHMIND_SHRINK_SEED", "20260914"))
    rng = Random.new(seed)
    types = S::PLANS.keys + ["custom.type", nil]
    cases = Array.new(Integer(ENV.fetch("GRAPHMIND_SHRINK_CASES", "150"))) do
      type = types[rng.rand(types.size)]
      payload = type.nil? && rng.rand < 0.2 ? random_value(rng, 0) : random_event(rng, type)
      { "payload" => S.stringify(payload), "maxBytes" => [4096, 16_384, 65_536, S::MAX_PAYLOAD_BYTES][rng.rand(4)], "type" => type, "value" => payload }
    end
    Dir.mktmpdir("gm-shrink") do |dir|
      input_path = File.join(dir, "cases.json")
      script_path = File.join(dir, "reference.mjs")
      File.write(input_path, JSON.generate(cases.map { |c| c.reject { |k, _| k == "value" } }))
      File.write(script_path, NODE_SCRIPT)
      stdout, stderr, status = Timeout.timeout(120) do
        Open3.capture3(node, script_path, File.dirname(SCHEMA_DIST), input_path)
      end
      assert status.success?, "node reference failed: #{stderr[0, 2000]}"
      reference = JSON.parse(stdout.force_encoding(Encoding::UTF_8), max_nesting: false)
      mismatches = []
      truncated_count = 0
      tiers = Hash.new(0)
      cases.each_with_index do |c, i|
        want = reference[i]
        json, payload, truncated = S.serialize_payload(c["value"], c["maxBytes"], c["type"])
        truncated_count += 1 if truncated
        tier = if !truncated then :unchanged
               elsif !payload.is_a?(Hash) || payload.keys == %w[__graphmindTruncated bytes preview] then :marker
               elsif S::PLANS.key?(c["type"].to_s) && payload.keys.all? { |k| S::PLANS[c["type"]].key?(k) || %w[__graphmindTruncated bytes preview fields].include?(k) } then :skeleton_or_small
               else :trim
               end
        tiers[tier] += 1
        label = "case #{i} (seed #{seed}, #{c['type'].inspect}, maxBytes #{c['maxBytes']})"
        mismatches << "#{label}: truncated #{truncated} want #{want['truncated']}" if truncated != want["truncated"]
        if json != want["json"]
          at = 0
          at += 1 while at < json.bytesize && json.getbyte(at) == want["json"].getbyte(at)
          mismatches << "#{label}: json differs at byte #{at}: #{json.byteslice(at, 60).inspect} vs " \
                        "#{want['json'].byteslice(at, 60).inspect}"
        end
        mismatches << "#{label}: input valid? ruby #{S.valid_for?(c['type'], c['value'])} ts #{want['inputValid']}" if
          S.valid_for?(c["type"], c["value"]) != want["inputValid"]
        mismatches << "#{label}: output valid? ruby #{S.valid_for?(c['type'], payload)} ts #{want['valid']}" if
          S.valid_for?(c["type"], payload) != want["valid"]
      end
      assert_empty mismatches.first(10), "#{mismatches.size} of #{cases.size} cases differ from the TypeScript reference"
      assert_operator truncated_count, :>=, cases.size / 4, "the corpus must actually exercise the shrink"
      warn "[differential] seed #{seed}: #{cases.size} cases, #{truncated_count} truncated, tiers #{tiers.inspect}" if
        ENV["GRAPHMIND_SHRINK_REPORT"]
    end
  end
end
