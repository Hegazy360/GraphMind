# frozen_string_literal: true

require "set"
require_relative "loop_guard"

module Graphmind
  # The payload budget of the GraphMind protocol, and the one algorithm that
  # enforces it: a port of packages/schema/src/shrink.ts (SHRINK-V2), pinned
  # byte for byte by packages/schema/test/fixtures/shrink.json.
  #
  # A single embedding array or scraped page can be enormous. Anything whose
  # payload JSON is over MAX_PAYLOAD_BYTES of UTF-8 is degraded to a
  # type-preserving preview so one event cannot blow the server's frame cap,
  # evict the replay buffer, or vanish. With the event type, a VALID event of a
  # known type always shrinks to a valid event within budget (for any
  # max_bytes >= 4096), so its node finishes in the viewer instead of hanging
  # "running".
  #
  # UNITS — they must match the TypeScript reference exactly:
  #   * the budget check and every top-level `bytes` are UTF-8 BYTES of the
  #     payload's JSON;
  #   * field sizes, a shrunk field's own `bytes`, every preview and every cut
  #     string count UTF-16 CODE UNITS (an astral character is 2). A cut can
  #     split a surrogate pair; Ruby cannot hold a lone surrogate in a valid
  #     UTF-8 String, so the half is kept as its 3-byte generalised-UTF-8 form
  #     ("WTF-8", e.g. "\xED\xA0\xBD") in a UTF-8 String whose
  #     `valid_encoding?` is false, and #stringify writes it as the escape
  #     JavaScript writes (\ud83d). `bytesize` of that form is 3, exactly
  #     what JavaScript counts for a lone surrogate.
  #   * key caps keep the first keys in Hash (insertion) order. JavaScript
  #     enumerates integer-like keys first; the fixture never mixes the two in
  #     one object, and a real payload that does may keep different keys per
  #     language (the result is valid and bounded either way).
  #
  # JSON text is byte-identical to JavaScript's JSON.stringify for JSON-shaped
  # values: Hash (String or Symbol keys), Array, String, Symbol (its name),
  # Integer, Float (ECMAScript number formatting; non-finite -> null; integers
  # beyond 2**53 as the double JavaScript would parse), true, false, nil.
  # Anything else — another object, a String whose bytes are not UTF-8, a
  # cycle, nesting deeper than MAX_JSON_DEPTH — is "unserializable" and takes
  # the same path JSON.stringify throwing takes in TypeScript.
  #
  # TIERS of serialize_payload(payload, max_bytes, type):
  #   1. JSON within max_bytes -> returned unchanged (same object).
  #   2. A Hash with at most MAX_TRIM_FIELDS top-level fields -> the field
  #      trim; with a known type the result must also validate.
  #   3. A known type and a Hash -> the skeleton (schema fields only).
  #   4. Otherwise -> the whole-payload marker {__graphmindTruncated, bytes, preview}.
  #
  # Pure functions: never mutates its input, keeps no state, thread-safe.
  module Shrink
    # Largest payload, as UTF-8 bytes of its JSON, stored or sent unchanged.
    MAX_PAYLOAD_BYTES = 512 * 1024
    # Length, in UTF-16 code units, of every preview and shortened string.
    PREVIEW_CHARS = 2000
    # Appended to a string that had to be cut short.
    TRUNCATION_SUFFIX = "\xE2\x80\xA6[graphmind: truncated]".dup.force_encoding(Encoding::UTF_8).freeze
    # How deep the field shrink recurses before it marks the subtree.
    MAX_SHRINK_DEPTH = 6
    # Most keys the field shrink keeps from any one object.
    MAX_SHRINK_KEYS = 256
    # Most top-level fields a payload may have for the field trim (tier 2).
    MAX_TRIM_FIELDS = 4096
    # Longest string, in UTF-16 units, the skeleton keeps; then its last attempt.
    SKELETON_CHARS = 256
    SKELETON_MIN_CHARS = 32
    # Nesting the serializer walks before calling a value unserializable
    # (JavaScript's limit is its stack; Ruby's must not be a SystemStackError).
    MAX_JSON_DEPTH = 1000

    MAX_SAFE_INTEGER = (2**53) - 1

    # The skeleton plan of every known event type: its schema keys in
    # declaration order. nil = required; a Hash = a required loose object with
    # its own plan; :optional = kept only when a string, number or boolean.
    # Asserted equal to the fixture's `skeletonPlans` by test/test_shrink.rb.
    PLANS = {
      "run.started" => { "app" => nil, "sdk" => { "name" => nil, "version" => nil }.freeze, "meta" => :optional },
      "run.finished" => { "status" => nil, "error" => :optional },
      "graph.hint" => { "nodes" => nil },
      "node.started" => {
        "nodeId" => nil, "parentId" => :optional, "kind" => nil, "name" => nil, "instanceId" => nil,
        "input" => :optional, "collapsed" => :optional, "redaction" => :optional
      },
      "node.token" => { "nodeId" => nil, "deltas" => nil, "redaction" => :optional },
      "node.finished" => {
        "nodeId" => nil, "instanceId" => :optional, "output" => :optional, "usage" => :optional,
        "durationMs" => nil, "heldMs" => :optional, "status" => nil, "redaction" => :optional
      },
      "node.error" => {
        "nodeId" => nil, "instanceId" => :optional,
        "error" => { "name" => nil, "message" => nil, "stack" => :optional }.freeze, "heldMs" => :optional
      },
      "exec.paused" => {
        "pauseId" => nil, "nodeId" => nil, "point" => nil, "reason" => :optional, "loop" => :optional,
        "smart" => :optional, "editable" => :optional
      },
      "exec.refused" => { "pauseId" => nil, "code" => nil, "message" => :optional, "requestId" => :optional },
      "exec.resumed" => {
        "pauseId" => nil, "action" => nil, "edited" => :optional, "requestId" => :optional, "principal" => :optional
      }
    }.transform_values(&:freeze).freeze

    # Raised internally when a value has no JSON text (see the module comment).
    class Unserializable < StandardError; end

    module_function

    # -- public API ------------------------------------------------------------

    # Serialize a payload, shrinking it when its JSON exceeds `max_bytes` UTF-8
    # bytes. Returns [json_text, payload, truncated]: the JSON to send or store,
    # the effective payload it is the text of, and whether anything was cut.
    #
    # Pass the event `type` whenever you have it: for a known type the result
    # is then a valid payload of that type within max_bytes (max_bytes >= 4096)
    # whenever the input was a valid event. Idempotent: a result fed back in
    # comes back unchanged (truncated false, the same object).
    def serialize_payload(payload, max_bytes = MAX_PAYLOAD_BYTES, type = nil)
      type = type.name if type.is_a?(Symbol)
      type = nil unless type.is_a?(String)
      plan = type.nil? ? nil : PLANS[type]
      begin
        json, spans = stringify_with_spans(payload, payload.is_a?(Hash) && payload.size <= MAX_TRIM_FIELDS)
      rescue Unserializable
        return unserializable_payload(payload, max_bytes, type, plan)
      end
      bytes = json.bytesize
      return [json, payload, false] if bytes <= max_bytes

      if payload.is_a?(Hash)
        if payload.size <= MAX_TRIM_FIELDS
          trimmed = truncate_fields(payload, max_bytes, bytes, json, spans)
          return [trimmed[0], trimmed[1], true] if trimmed && valid_for?(type, trimmed[1])
        end
        if plan
          skeleton = skeleton_payload(payload, type, plan, max_bytes, bytes, prefix(json, PREVIEW_CHARS))
          return [skeleton[0], skeleton[1], true] if skeleton
        end
      end

      marker = { "__graphmindTruncated" => true, "bytes" => bytes, "preview" => prefix(json, PREVIEW_CHARS) }
      [stringify(marker), marker, true]
    end

    # Whether `payload` is a valid payload of `type` (the zod schema in
    # packages/schema/src/events.ts). Unknown types are valid (their payload is
    # opaque), as in the TypeScript reference.
    def valid_for?(type, payload)
      type = type.name if type.is_a?(Symbol)
      return true unless type.is_a?(String) && PLANS.key?(type)

      Schema.valid?(type, payload)
    rescue StandardError
      false
    end

    # JSON.stringify's text of a JSON-shaped value. Raises Unserializable.
    def stringify(value)
      writer = Writer.new
      writer.value(value, 0)
      writer.out
    end

    # JSON text, or nil when the value has none.
    def safe_stringify(value)
      stringify(value)
    rescue Unserializable
      nil
    end

    # Length of a string in UTF-16 code units (JavaScript's `.length`).
    def utf16_length(text)
      return text.bytesize if text.ascii_only?

      raw = text.b
      # One unit per character start (every byte that is not a continuation
      # byte), plus one more for each 4-byte (astral) character. A kept lone
      # surrogate (3 bytes, one start) counts 1, as in JavaScript.
      raw.bytesize - raw.count("\x80-\xBF".b) + raw.count("\xF0-\xF7".b)
    end

    # The first `count` UTF-16 code units of `text` (JavaScript's
    # `text.slice(0, count)`); the text itself when it is not longer.
    def prefix(text, count)
      if text.ascii_only?
        return text if text.bytesize <= count

        return text.byteslice(0, count)
      end
      return text if utf16_length(text) <= count

      window = text.byteslice(0, (count * 3) + 4).b
      bytes = window.unpack("C*")
      index = 0
      units = 0
      length = bytes.length
      while units < count && index < length
        lead = bytes[index]
        step = if lead < 0x80 then 1
               elsif lead < 0xE0 then 2
               elsif lead < 0xF0 then 3
               else 4
               end
        if step == 4
          if units + 2 > count
            # The cut falls between the halves of a surrogate pair: keep the
            # lone high half, as JavaScript's slice does.
            code = ((lead & 0x07) << 18) | (((bytes[index + 1] || 0x80) & 0x3F) << 12) |
                   (((bytes[index + 2] || 0x80) & 0x3F) << 6) | ((bytes[index + 3] || 0x80) & 0x3F)
            high = 0xD800 + ((code - 0x10000) >> 10)
            half = [0xE0 | (high >> 12), 0x80 | ((high >> 6) & 0x3F), 0x80 | (high & 0x3F)].pack("C*")
            return (window.byteslice(0, index) + half).force_encoding(Encoding::UTF_8)
          end
          units += 2
        else
          units += 1
        end
        index += step
      end
      window.byteslice(0, index).force_encoding(Encoding::UTF_8)
    end

    # -- JSON writer -----------------------------------------------------------

    ESCAPES = (0x00..0x1F).to_h { |code| [code.chr, format("\\u%04x", code)] }
                          .merge("\b" => "\\b", "\t" => "\\t", "\n" => "\\n", "\f" => "\\f", "\r" => "\\r",
                                 '"' => '\\"', "\\" => "\\\\").freeze
    ESCAPE_RE = /["\\\x00-\x1F]/
    SURROGATE_PAIR_RE = /\xED([\xA0-\xAF])([\x80-\xBF])\xED([\xB0-\xBF])([\x80-\xBF])/n
    LONE_SURROGATE_RE = /(\xED[\xA0-\xBF][\x80-\xBF])/n

    # Appends JSON text to one buffer. Top-level Hash field value spans are
    # recorded (byte offsets) so the field trim never serializes a field twice.
    class Writer
      attr_reader :out

      def initialize
        @out = +""
        @path = {}.compare_by_identity
      end

      def value(value, depth, spans = nil)
        case value
        when String then string(value)
        when Symbol then string(value.name)
        when Integer then @out << Shrink.integer_text(value)
        when Float then @out << Shrink.float_text(value)
        when true then @out << "true"
        when false then @out << "false"
        when nil then @out << "null"
        when Hash then object(value, depth, spans)
        when Array then array(value, depth)
        else raise Unserializable, "not a JSON value"
        end
      end

      def string(text)
        @out << Shrink.quote(text)
      end

      private

      def enter(container, depth)
        raise Unserializable, "nested too deeply" if depth >= MAX_JSON_DEPTH
        raise Unserializable, "cyclic" if @path.key?(container)

        @path[container] = true
      end

      def object(hash, depth, spans)
        enter(hash, depth)
        @out << "{"
        first = true
        hash.each_pair do |key, item|
          @out << "," unless first
          first = false
          string(Shrink.key_string(key))
          @out << ":"
          start = @out.bytesize
          value(item, depth + 1)
          spans << [start, @out.bytesize] if spans
        end
        @out << "}"
        @path.delete(hash)
      end

      def array(list, depth)
        enter(list, depth)
        @out << "["
        list.each_with_index do |item, i|
          @out << "," unless i.zero?
          value(item, depth + 1)
        end
        @out << "]"
        @path.delete(list)
      end
    end

    # [json, spans]: spans (for a Hash) lists each field value's byte range,
    # in field order.
    def stringify_with_spans(value, want_spans = true)
      writer = Writer.new
      spans = want_spans && value.is_a?(Hash) ? [] : nil
      writer.value(value, 0, spans)
      [writer.out, spans]
    end

    def key_string(key)
      case key
      when String then key
      when Symbol then key.name
      else
        begin
          text = key.to_s
        rescue StandardError
          raise Unserializable, "a key has no string form"
        end
        raise Unserializable, "a key has no string form" unless text.is_a?(String)

        text
      end
    end

    # A JSON string literal, escaped exactly like JSON.stringify.
    def quote(text)
      text = utf8(text)
      if text.valid_encoding?
        body = text.match?(ESCAPE_RE) ? text.gsub(ESCAPE_RE, ESCAPES) : text
        return "\"#{body}\""
      end
      # Kept surrogate halves (see the module comment). A high half directly
      # followed by a low half is one character, as in JavaScript.
      raw = text.b.gsub(SURROGATE_PAIR_RE) do
        high = 0xD000 | ((Regexp.last_match(1).ord & 0x3F) << 6) | (Regexp.last_match(2).ord & 0x3F)
        low = 0xD000 | ((Regexp.last_match(3).ord & 0x3F) << 6) | (Regexp.last_match(4).ord & 0x3F)
        [0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)].pack("U").b
      end
      body = +""
      raw.split(LONE_SURROGATE_RE).each do |part|
        if part.bytesize == 3 && LONE_SURROGATE_RE.match?(part)
          bytes = part.unpack("C*")
          code = ((bytes[0] & 0x0F) << 12) | ((bytes[1] & 0x3F) << 6) | (bytes[2] & 0x3F)
          body << format("\\u%04x", code)
        else
          piece = part.force_encoding(Encoding::UTF_8)
          raise Unserializable, "string is not UTF-8" unless piece.valid_encoding?

          body << (piece.match?(ESCAPE_RE) ? piece.gsub(ESCAPE_RE, ESCAPES) : piece)
        end
      end
      "\"#{body}\""
    end

    def utf8(text)
      encoding = text.encoding
      return text if encoding == Encoding::UTF_8
      return text.dup.force_encoding(Encoding::UTF_8) if encoding == Encoding::BINARY || encoding == Encoding::US_ASCII

      text.encode(Encoding::UTF_8)
    rescue EncodingError
      raise Unserializable, "string cannot be converted to UTF-8"
    end

    TWO_53 = 2**53

    # JSON.stringify of a Float. Ruby's Float#to_s is the shortest round-trip
    # spelling, as JavaScript's is; the two differ only in form: Ruby writes
    # "5.0" for 5 and an exponent outside 1e-4 <= |x| < 1e16. The positional
    # form is taken as is (minus a ".0"); only an exponent form pays for the
    # general conversion. (Measurably 10x faster on a 2,000,000-float array.)
    def float_text(value)
      return "null" unless value.finite?
      return "0" if value.zero?

      text = value.to_s
      return LoopGuard.js_number(value) if text.include?("e")

      text.end_with?(".0") ? text.byteslice(0, text.bytesize - 2) : text
    end

    # JSON.stringify of an integer JavaScript would hold as a double.
    def integer_text(value)
      return value.to_s if value.abs <= TWO_53

      double = integer_double(value)
      double.finite? ? LoopGuard.js_number(double) : "null"
    end

    # The double JavaScript's JSON.parse makes of an integer's digits.
    def integer_double(value)
      return value.to_f if value.abs <= TWO_53

      value.bit_length > 1100 ? Float::INFINITY : Float(value.to_s)
    end

    # -- tier 2: the field trim ------------------------------------------------

    # Shrink one oversized field, PRESERVING ITS JSON TYPE (a required string
    # stays a string, an object an object), so the event still validates.
    def shrink_value(value, depth = 0, encoded = nil)
      case value
      when String, Symbol
        text = value.is_a?(Symbol) ? value.name : value
        return text if utf16_length(text) <= PREVIEW_CHARS

        prefix(text, PREVIEW_CHARS) + TRUNCATION_SUFFIX
      when Array then []
      when Hash
        if depth >= MAX_SHRINK_DEPTH
          return { "__graphmindTruncated" => true, "bytes" => 0, "preview" => "[deeply nested]" }
        end

        shrunk = {}
        kept = 0
        value.each_pair do |key, item|
          break if kept == MAX_SHRINK_KEYS

          shrunk[key_string(key)] = shrink_value(item, depth + 1)
          kept += 1
        end
        dropped = value.size - kept
        if depth.positive?
          if dropped.positive?
            shrunk["__graphmindTruncated"] = true
            shrunk["keysDropped"] = dropped
          end
          return shrunk
        end
        text = encoded || safe_stringify(value)
        shrunk["__graphmindTruncated"] = true
        shrunk["bytes"] = text.nil? ? 0 : utf16_length(text)
        shrunk["preview"] = text.nil? ? "[unserializable field]" : prefix(text, PREVIEW_CHARS)
        shrunk["keysDropped"] = dropped if dropped.positive?
        shrunk
      else
        value
      end
    end

    # Trim the biggest fields of an oversized Hash payload until the rest is at
    # most half the budget; nil when the result still does not fit.
    def truncate_fields(payload, max_bytes, total_bytes, json, spans)
      sizes = []
      payload.each_pair.with_index do |(key, item), index|
        span = spans && spans[index]
        encoded = span ? json.byteslice(span[0], span[1] - span[0]) : safe_stringify(item)
        size = encoded.nil? ? MAX_SAFE_INTEGER : utf16_length(encoded)
        sizes << [key_string(key), size, encoded, item, index]
      end
      # Biggest first; equal sizes keep key order (a stable sort).
      sizes.sort_by! { |entry| [-entry[1], entry[4]] }

      trimmed = {}
      payload.each_pair { |key, item| trimmed[key_string(key)] = item }
      dropped = []
      remaining = total_bytes
      sizes.each do |key, size, encoded, item, _index|
        break if remaining * 2 <= max_bytes # leave room for the marker itself

        trimmed[key] = shrink_value(item, 0, encoded)
        dropped << key
        remaining -= size
      end
      return nil if dropped.empty?

      trimmed["__graphmindTruncated"] = true
      trimmed["bytes"] = total_bytes
      trimmed["preview"] = prefix(json, PREVIEW_CHARS)
      trimmed["fields"] = dropped
      encoded = safe_stringify(trimmed)
      return nil if encoded.nil? || encoded.bytesize > max_bytes

      [encoded, trimmed]
    end

    # -- unserializable payloads -----------------------------------------------

    def unserializable_payload(payload, max_bytes, type, plan)
      begin
        if payload.is_a?(Hash)
          trimmed = truncate_unserializable_fields(payload)
          return [trimmed[0], trimmed[1], true] if trimmed && plan.nil?

          if trimmed
            bytes = trimmed[0].bytesize
            return [trimmed[0], trimmed[1], true] if bytes <= max_bytes && valid_for?(type, trimmed[1])

            if bytes > max_bytes && trimmed[1].size <= MAX_TRIM_FIELDS
              fitted = truncate_fields(trimmed[1], max_bytes, bytes, trimmed[0], trimmed[2])
              return [fitted[0], fitted[1], true] if fitted && valid_for?(type, fitted[1])
            end
          end
          if plan
            skeleton = skeleton_payload(payload, type, plan, max_bytes, 0, "[unserializable payload]")
            return [skeleton[0], skeleton[1], true] if skeleton
          end
        end
      rescue Unserializable
        nil # a key with no JSON text: fall through to the whole-payload marker
      end
      marker = { "__graphmindTruncated" => true, "bytes" => 0, "preview" => "[unserializable payload]" }
      [stringify(marker), marker, true]
    end

    # Keep every field that serializes; replace the others with a marker
    # (arrays with []). [json, payload, spans], or nil when nothing was to blame.
    def truncate_unserializable_fields(payload)
      trimmed = {}
      dropped = []
      payload.each_pair do |key, item|
        name = key_string(key)
        unless safe_stringify(item).nil?
          trimmed[name] = item
          next
        end
        dropped << name
        trimmed[name] =
          if item.is_a?(Array)
            []
          else
            { "__graphmindTruncated" => true, "bytes" => 0, "preview" => "[unserializable value]" }
          end
      end
      return nil if dropped.empty?

      trimmed["__graphmindTruncated"] = true
      trimmed["fields"] = dropped
      json, spans = stringify_with_spans(trimmed)
      [json, trimmed, spans]
    rescue Unserializable
      nil
    end

    # -- tier 3: the skeleton --------------------------------------------------

    SKELETON_ATTEMPTS = [[SKELETON_CHARS, true], [SKELETON_CHARS, false], [SKELETON_MIN_CHARS, false]].freeze

    def omitted_marker = { "__graphmindTruncated" => true, "bytes" => 0, "preview" => "[omitted]" }

    # [found, value] for a planned key (a Symbol key counts as its name).
    def lookup(hash, key)
      return [true, hash[key]] if hash.key?(key)

      symbol = key.to_sym
      return [true, hash[symbol]] if hash.key?(symbol)

      [false, nil]
    end

    def scalar?(value)
      value.is_a?(String) || value.is_a?(Symbol) || value.is_a?(Integer) || value.is_a?(Float) ||
        true.equal?(value) || false.equal?(value)
    end

    # [out, verbatim_keys, kept]: the planned keys of `value`, hard-shrunk.
    def keep_planned(value, plan, chars)
      out = {}
      verbatim = Set.new
      kept = 0
      plan.each do |key, sub|
        found, child = lookup(value, key)
        next unless found
        next if sub == :optional && !scalar?(child)

        shrunk, same = hard_shrink(child, sub == :optional ? nil : sub, chars)
        out[key] = shrunk
        kept += 1
        verbatim << key if same
      end
      [out, verbatim, kept]
    end

    # [value, verbatim] for one kept skeleton value.
    def hard_shrink(value, plan, chars)
      case value
      when String, Symbol
        text = value.is_a?(Symbol) ? value.name : value
        return [text, true] if utf16_length(text) <= chars

        [prefix(text, chars) + TRUNCATION_SUFFIX, false]
      when Integer, Float, true, false, nil then [value, true]
      when Array then [[], value.empty?]
      else
        if value.is_a?(Hash) && plan.is_a?(Hash)
          out, verbatim, kept = keep_planned(value, plan, chars)
          [out, verbatim.size == kept && value.size <= kept]
        else
          [omitted_marker, false]
        end
      end
    end

    def skeleton_payload(payload, type, plan, max_bytes, bytes, preview)
      SKELETON_ATTEMPTS.each do |chars, full|
        out, verbatim, = keep_planned(payload, plan, chars)
        out["__graphmindTruncated"] = true
        out["bytes"] = bytes
        out["preview"] = full ? preview : ""
        if full
          fields = []
          units = 0
          payload.each_key do |key|
            name = key_string(key)
            next if verbatim.include?(name)

            fields << name
            units += utf16_length(name)
            # Every name costs at least its length in bytes: once the names
            # alone exceed the budget this attempt cannot fit.
            break if units > max_bytes
          end
          next if units > max_bytes

          out["fields"] = fields
        end
        json = safe_stringify(out)
        next if json.nil? || json.bytesize > max_bytes
        next unless valid_for?(type, out)

        return [json, out]
      end
      nil
    end

    # The event payload schemas (packages/schema/src/events.ts and
    # primitives.ts), as zod v4 applies them: loose objects (extra keys kept),
    # an optional key may be absent but not null, numbers are finite,
    # `.int()` means a safe integer.
    module Schema
      NODE_KINDS = %w[agent llm tool chain retriever server resource prompt custom].freeze
      RUN_STATUSES = %w[ok error aborted].freeze
      PAUSE_POINTS = %w[before after error].freeze
      PAUSE_REASONS = %w[breakpoint error step loop].freeze
      RESUME_ACTIONS = %w[continue retry inject abort].freeze
      TOKEN_CHANNELS = %w[text reasoning tool-args].freeze
      LOOP_KINDS = %w[repeat cycle error-repeat].freeze
      SMART_RULES = %w[error-result truncated-tool-call].freeze
      REFUSAL_CODES = %w[schema shape placeholder truncated disabled unsupported].freeze

      module_function

      def valid?(type, payload)
        return false unless payload.is_a?(Hash)

        case type
        when "run.started"
          required(payload, "app") { |v| str?(v) } &&
            required(payload, "sdk") { |v| sdk?(v) } &&
            optional(payload, "meta") { |v| v.is_a?(Hash) }
        when "run.finished"
          required(payload, "status") { |v| enum?(v, RUN_STATUSES) } &&
            optional(payload, "error") { |v| error_info?(v) }
        when "graph.hint"
          required(payload, "nodes") { |v| v.is_a?(Array) && v.all? { |n| node_hint?(n) } }
        when "node.started"
          required(payload, "nodeId") { |v| str?(v) } &&
            optional(payload, "parentId") { |v| str?(v) } &&
            required(payload, "kind") { |v| enum?(v, NODE_KINDS) } &&
            required(payload, "name") { |v| str?(v) } &&
            required(payload, "instanceId") { |v| str?(v) } &&
            optional(payload, "collapsed") { |v| true.equal?(v) || false.equal?(v) } &&
            optional(payload, "redaction") { |v| redaction?(v) }
        when "node.token"
          required(payload, "nodeId") { |v| str?(v) } &&
            required(payload, "deltas") { |v| v.is_a?(Array) && v.all? { |d| delta?(d) } } &&
            optional(payload, "redaction") { |v| redaction?(v) }
        when "node.finished"
          required(payload, "nodeId") { |v| str?(v) } &&
            optional(payload, "instanceId") { |v| str?(v) } &&
            optional(payload, "usage") { |v| usage?(v) } &&
            required(payload, "durationMs") { |v| nonnegative?(v) } &&
            optional(payload, "heldMs") { |v| nonnegative?(v) } &&
            required(payload, "status") { |v| enum?(v, RUN_STATUSES) } &&
            optional(payload, "redaction") { |v| redaction?(v) }
        when "node.error"
          required(payload, "nodeId") { |v| str?(v) } &&
            optional(payload, "instanceId") { |v| str?(v) } &&
            required(payload, "error") { |v| error_info?(v) } &&
            optional(payload, "heldMs") { |v| nonnegative?(v) }
        when "exec.paused"
          required(payload, "pauseId") { |v| str?(v) } &&
            required(payload, "nodeId") { |v| str?(v) } &&
            required(payload, "point") { |v| enum?(v, PAUSE_POINTS) } &&
            optional(payload, "reason") { |v| enum?(v, PAUSE_REASONS) } &&
            optional(payload, "loop") { |v| loop_info?(v) } &&
            optional(payload, "smart") { |v| smart_info?(v) } &&
            optional(payload, "editable") { |v| bool?(v) }
        when "exec.refused"
          required(payload, "pauseId") { |v| str?(v) } &&
            required(payload, "code") { |v| enum?(v, REFUSAL_CODES) } &&
            optional(payload, "message") { |v| str?(v) } &&
            optional(payload, "requestId") { |v| str?(v) }
        when "exec.resumed"
          required(payload, "pauseId") { |v| str?(v) } &&
            required(payload, "action") { |v| enum?(v, RESUME_ACTIONS) } &&
            # z.looseObject({after: z.unknown()}): zod v4 requires the key.
            optional(payload, "edited") { |v| v.is_a?(Hash) && Shrink.lookup(v, "after")[0] } &&
            optional(payload, "requestId") { |v| str?(v) } &&
            optional(payload, "principal") { |v| str?(v) }
        else
          true
        end
      end

      def required(hash, key)
        found, value = Shrink.lookup(hash, key)
        found && yield(value)
      end

      def optional(hash, key)
        found, value = Shrink.lookup(hash, key)
        !found || yield(value)
      end

      def str?(value) = value.is_a?(String) || value.is_a?(Symbol)

      def enum?(value, list) = str?(value) && list.include?(value.is_a?(Symbol) ? value.name : value)

      def number?(value)
        case value
        when Float then value.finite?
        when Integer then Shrink.integer_double(value).finite?
        else false
        end
      end

      def nonnegative?(value) = number?(value) && value >= 0

      def safe_integer?(value)
        number?(value) && value.abs <= MAX_SAFE_INTEGER && (value.is_a?(Integer) || value == value.truncate)
      end

      def sdk?(value) = value.is_a?(Hash) && required(value, "name") { |v| str?(v) } &&
                        required(value, "version") { |v| str?(v) }

      def error_info?(value)
        value.is_a?(Hash) && required(value, "name") { |v| str?(v) } &&
          required(value, "message") { |v| str?(v) } && optional(value, "stack") { |v| str?(v) }
      end

      def node_hint?(value)
        value.is_a?(Hash) && required(value, "nodeId") { |v| str?(v) } &&
          required(value, "kind") { |v| enum?(v, NODE_KINDS) } && required(value, "name") { |v| str?(v) } &&
          optional(value, "parentId") { |v| str?(v) }
      end

      def delta?(value)
        value.is_a?(Hash) && required(value, "t") { |v| enum?(v, TOKEN_CHANNELS) } &&
          required(value, "v") { |v| str?(v) }
      end

      def usage?(value)
        value.is_a?(Hash) && required(value, "inputTokens") { |v| count?(v) } &&
          required(value, "outputTokens") { |v| count?(v) } &&
          optional(value, "inclusive") { |v| bool?(v) } &&
          optional(value, "cacheReadTokens") { |v| count?(v) } &&
          optional(value, "cacheWriteTokens") { |v| count?(v) } &&
          optional(value, "reasoningTokens") { |v| count?(v) }
      end

      def bool?(value) = true.equal?(value) || false.equal?(value)

      def smart_info?(value)
        value.is_a?(Hash) && required(value, "rule") { |v| enum?(v, SMART_RULES) } &&
          optional(value, "detail") { |v| str?(v) }
      end

      def redaction?(value)
        value.is_a?(Hash) && required(value, "count") { |v| count?(v) } &&
          required(value, "keys") { |v| v.is_a?(Array) && v.all? { |k| str?(k) } }
      end

      def loop_info?(value)
        value.is_a?(Hash) && required(value, "repeats") { |v| count?(v) } &&
          required(value, "firstSeq") { |v| count?(v) } && required(value, "lastSeq") { |v| count?(v) } &&
          required(value, "fingerprint") { |v| str?(v) } &&
          optional(value, "kind") { |v| enum?(v, LOOP_KINDS) } &&
          optional(value, "period") { |v| count?(v) && v.positive? } &&
          optional(value, "laps") { |v| count?(v) && v.positive? }
      end

      def count?(value) = safe_integer?(value) && value >= 0
    end
  end
end
