# frozen_string_literal: true

require "digest"
require "set"

module Graphmind
  # Loop guard: hold an agent that makes the same tool call again, back-to-back,
  # with the same arguments.
  #
  # Port of packages/client/src/loop-guard.ts (read that file's header for the
  # rationale), held to the conformance fixture
  # packages/client/test/fixtures/loop-guard.json (version 3).
  #
  # The session fingerprints (nodeId, input) where node.started is emitted and
  # CONSULTS the streak at the next `before` gate of that node:
  #
  #   * mode pause + debugger attached: the Nth identical back-to-back call is
  #     HELD through the normal gate path (pause_timeout and fail-open release
  #     apply) with `reason: "loop"` and `loop: {repeats, firstSeq, lastSeq,
  #     fingerprint}` on exec.paused;
  #   * mode pause + detached, or mode warn: ONE warning per streak, execution
  #     continues (the count keeps running, so a debugger that attaches later
  #     holds the next identical call);
  #   * mode off or threshold 0: nothing at all.
  #
  # Counting, rule v3 (internal/decisions.md "Loop hold v3: a loop is the same
  # call BACK-TO-BACK" — identical in TypeScript and Python):
  #
  #   1. Per run, per node KIND, ONE streak {nodeId, fingerprint, count,
  #      firstSeq, lastSeq}.
  #   2. A WATCHED start (guard enabled, kind in `kinds`, neither nodeId nor
  #      name in `allow_nodes`) with a readable input: same (nodeId,
  #      fingerprint) as its kind's streak -> count += 1; otherwise the streak
  #      is REPLACED by a fresh one with count 1.
  #   3. A watched start whose input cannot be read (or whose nodeId is not a
  #      String/Symbol) CLEARS its kind's streak.
  #   4. Unwatched starts (other kinds, allow-listed nodes) touch no streak, so
  #      an LLM step between two identical tool calls does not break the tool
  #      streak.
  #   5. The before-gate holds when its kind's streak belongs to this nodeId
  #      and count >= threshold, once per count: a `retry` (no new node.started)
  #      runs on; the next identical back-to-back call holds again.
  #   6. Memory: one streak per (run, kind); runs LRU-bounded.
  #
  # Why: under `graphmind mcp-proxy` a whole host session is one run, so a
  # per-node rule held `list_issues({})` called at minute 1, 20 and 45 with
  # dozens of other tools between. Accepted consequence: a model ALTERNATING
  # between tools (search, read, search, read) is not held.
  #
  # Fingerprint = first 32 hex chars of SHA-256 over the canonical JSON of
  # [nodeId, input]: keys sorted by UTF-16 code unit, no whitespace, numbers in
  # JavaScript's shortest round-trip form (1.0 -> 1, 1.0e-07 -> 1e-7,
  # non-finite -> null), strings escaped like JSON.stringify, keys in
  # ignore_keys (default: MCP's `_meta`) removed at every level, cycles and
  # depth > 64 replaced by markers. Ruby values JSON cannot express are
  # canonicalised like the session's sanitizer degrades them: Symbols as
  # strings, Hash keys via #to_s, Sets as sorted arrays, objects with #to_h via
  # it, anything else via #inspect; Procs and Methods are dropped from objects
  # (null in arrays) as JSON.stringify drops functions. An input that raises
  # while being read clears its kind's streak instead of looking identical.
  #
  # Bookkeeping only: never raises into the host, keeps no reference to a host
  # object, thread-safe.
  module LoopGuard
    DEFAULT_THRESHOLD = 3
    DEFAULT_MODE = "pause"
    DEFAULT_KINDS = ["tool"].freeze
    # Keys that change on every request without changing the request: only
    # MCP's reserved `_meta`. Pagination keys are deliberately NOT here.
    DEFAULT_IGNORE_KEYS = ["_meta"].freeze
    MODES = %w[pause warn off].freeze

    MAX_RUNS = 64
    MAX_DEPTH = 64
    FINGERPRINT_HEX_CHARS = 32

    DECIMAL_RE = /\A[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\z/
    RADIX_RE = /\A0([xXoObB])([0-9a-fA-F]+)\z/

    # Raised internally when a value cannot be read faithfully.
    class Lossy < StandardError; end

    Config = Struct.new(:threshold, :mode, :ignore_keys, :allow_nodes, :kinds, keyword_init: true)

    # What exec.paused.loop carries when reason is "loop".
    Info = Struct.new(:repeats, :first_seq, :last_seq, :fingerprint, keyword_init: true) do
      def to_wire
        { "repeats" => repeats, "firstSeq" => first_seq, "lastSeq" => last_seq,
          "fingerprint" => fingerprint }
      end
    end

    Record = Struct.new(:repeats, :first_seq, :last_seq, :fingerprint, :at_threshold,
                        keyword_init: true)

    # Returned by #fingerprint for an input that could not be read; pass it as
    # the input when reading the input itself raised (rule 3: it clears the
    # kind's streak).
    UNREADABLE = Object.new.freeze

    module_function

    # -- configuration -------------------------------------------------------

    # JavaScript's Number(text) for the spellings that matter; nil where NaN.
    def js_number_from(text)
      return Float(text) if DECIMAL_RE.match?(text)

      radix = RADIX_RE.match(text)
      if radix
        base = { "x" => 16, "o" => 8, "b" => 2 }[radix[1].downcase]
        return Integer(radix[2], base).to_f
      end
      return Float::INFINITY if ["Infinity", "+Infinity", "-Infinity"].include?(text)

      nil
    rescue ArgumentError, FloatDomainError
      nil
    end

    # GRAPHMIND_LOOP_THRESHOLD: a non-negative integer; anything else -> fallback.
    def parse_threshold(raw, fallback = DEFAULT_THRESHOLD)
      return fallback unless raw.is_a?(String)

      text = raw.strip
      return fallback if text.empty?

      value = js_number_from(text)
      return fallback if value.nil? || !value.finite? || value != value.floor || value.negative?

      value.to_i
    rescue StandardError
      fallback
    end

    # GRAPHMIND_ON_LOOP: pause | warn | off (case-insensitive; 0/false/none -> off).
    def parse_mode(raw, fallback = DEFAULT_MODE)
      return fallback unless raw.is_a?(String)

      text = raw.strip.downcase
      return text if MODES.include?(text)
      return "off" if %w[0 false none].include?(text)

      fallback
    rescue StandardError
      fallback
    end

    # GRAPHMIND_LOOP_ALLOW: comma-separated node ids or names; whitespace
    # around entries ignored, empty entries dropped.
    def parse_allow(raw)
      return [] unless raw.is_a?(String)

      raw.split(",").map(&:strip).reject(&:empty?)
    rescue StandardError
      []
    end

    def valid_threshold(value)
      return nil unless value.is_a?(Integer) || value.is_a?(Float)
      return nil if value.is_a?(Float) && (!value.finite? || value != value.floor)
      return nil if value.negative?

      value.to_i
    end

    def option(options, name)
      [name, name.to_s, camel(name), camel(name).to_sym].each do |key|
        return options[key] if options.key?(key)
      end
      nil
    end

    def camel(name)
      head, *rest = name.to_s.split("_")
      head + rest.map(&:capitalize).join
    end

    # An option list (Symbols count as their names), else the default list.
    def string_set(value, default)
      list =
        if value.is_a?(Array) || value.is_a?(Set)
          value.map { |v| v.is_a?(Symbol) ? v.to_s : v }.select { |v| v.is_a?(String) }
        else
          default
        end
      Set.new(list).freeze
    end

    def resolve_strict(options, env)
      opts =
        if options == false then { mode: "off" }
        elsif options.is_a?(Hash) then options
        else {}
        end
      env ||= {}
      threshold = valid_threshold(option(opts, :threshold)) || parse_threshold(env["GRAPHMIND_LOOP_THRESHOLD"])
      mode = option(opts, :mode)
      mode = mode.to_s if mode.is_a?(Symbol)
      mode = parse_mode(env["GRAPHMIND_ON_LOOP"]) unless mode.is_a?(String) && MODES.include?(mode)
      Config.new(
        threshold: threshold,
        mode: mode,
        ignore_keys: string_set(option(opts, :ignore_keys), DEFAULT_IGNORE_KEYS),
        allow_nodes: string_set(option(opts, :allow_nodes), parse_allow(env["GRAPHMIND_LOOP_ALLOW"])),
        kinds: string_set(option(opts, :kinds), DEFAULT_KINDS)
      )
    end

    # Precedence per field: option > environment > default. `options` is
    # `false` (shorthand for mode off), nil, or a Hash with threshold, mode,
    # ignore_keys, allow_nodes, kinds (Symbol or String keys, camelCase
    # accepted). Never raises: unreadable options are ignored as a whole, an
    # unreadable environment falls back to the defaults.
    def resolve(options, env)
      resolve_strict(options, env)
    rescue StandardError
      begin
        resolve_strict(nil, env)
      rescue StandardError
        resolve_strict(nil, {})
      end
    end

    # -- canonical JSON + fingerprint ----------------------------------------

    ESCAPES = {
      '"' => '\\"', "\\" => "\\\\", "\b" => "\\b", "\f" => "\\f", "\n" => "\\n", "\r" => "\\r",
      "\t" => "\\t"
    }.freeze
    ESCAPE_RE = /["\\\u0000-\u001f]/

    def utf8(text)
      str =
        if text.encoding == Encoding::UTF_8 then text
        elsif text.encoding == Encoding::BINARY then text.dup.force_encoding(Encoding::UTF_8)
        else text.encode(Encoding::UTF_8)
        end
      raise Lossy unless str.valid_encoding?

      str
    rescue Lossy
      raise
    rescue StandardError
      raise Lossy
    end

    # A JSON string literal escaped exactly like JSON.stringify.
    def quote(text)
      body = utf8(text).gsub(ESCAPE_RE) { |c| ESCAPES[c] || format("\\u%04x", c.ord) }
      "\"#{body}\""
    end

    # JSON.stringify of a finite double: ECMAScript Number::toString.
    def js_number(value)
      return "0" if value.zero?

      sign = value.negative? ? "-" : ""
      match = /\A(\d+)\.(\d+)(?:e([+-]\d+))?\z/.match(value.abs.to_s)
      raise Lossy if match.nil?

      digits = match[1] + match[2]
      point = match[1].length + match[3].to_i
      stripped = digits.sub(/\A0+/, "")
      point -= digits.length - stripped.length
      digits = stripped.sub(/0+\z/, "")
      k = digits.length
      n = point
      body =
        if k <= n && n <= 21 then digits + ("0" * (n - k))
        elsif n.positive? && n <= 21 then "#{digits[0, n]}.#{digits[n..]}"
        elsif n > -6 && n <= 0 then "0.#{'0' * -n}#{digits}"
        else
          e = n - 1
          mantissa = k == 1 ? digits : "#{digits[0]}.#{digits[1..]}"
          "#{mantissa}e#{e.negative? ? '-' : '+'}#{e.abs}"
        end
      sign + body
    end

    def dropped?(value) = value.is_a?(Proc) || value.is_a?(Method) || value.is_a?(UnboundMethod)

    # UTF-16 code units compared big-endian byte by byte give JS's default sort.
    def utf16_sort_key(key) = key.encode(Encoding::UTF_16BE).b

    def canon(value, ignore, depth, seen)
      case value
      when nil then return "null"
      when true then return "true"
      when false then return "false"
      when String then return quote(value)
      when Symbol then return quote(value.to_s)
      when Integer then return value.to_s
      when Float then return value.finite? ? js_number(value) : "null"
      end
      return "null" if dropped?(value)
      return '"[depth]"' if depth > MAX_DEPTH
      return '"[circular]"' if seen.key?(value)

      seen[value] = true
      begin
        case value
        when Hash
          entries = []
          value.each_pair do |raw_key, item|
            key = utf8(raw_key.is_a?(String) ? raw_key : raw_key.to_s)
            next if ignore.include?(key) || dropped?(item)

            entries << [key, item]
          end
          # All-ASCII keys (the common case) sort the same by bytes; any other
          # key forces UTF-16 order for all of them (U+E000..U+FFFF sort after
          # astral characters in UTF-16, before them in UTF-8).
          if entries.all? { |(key, _)| key.ascii_only? }
            entries.sort_by!(&:first)
          else
            entries.sort_by! { |(key, _)| utf16_sort_key(key) }
          end
          "{#{entries.map { |(k, v)| "#{quote(k)}:#{canon(v, ignore, depth + 1, seen)}" }.join(',')}}"
        when Array
          "[#{value.map { |item| canon(item, ignore, depth + 1, seen) }.join(',')}]"
        when Set
          # A Set has no JSON order: make one, so equal sets fingerprint equally.
          "[#{value.map { |item| canon(item, ignore, depth + 1, seen) }.sort.join(',')}]"
        else
          if value.respond_to?(:to_h)
            replaced = value.to_h
            raise Lossy if replaced.equal?(value) || !replaced.is_a?(Hash)

            canon(replaced, ignore, depth + 1, seen)
          else
            quote(value.inspect)
          end
        end
      ensure
        seen.delete(value)
      end
    end

    def new_seen = {}.compare_by_identity

    # Canonical JSON of one value; an unreadable value becomes "[unserializable]".
    def canonicalize(value, ignore_keys = [])
      canon(value, Set.new(ignore_keys), 0, new_seen)
    rescue StandardError
      '"[unserializable]"'
    end

    # The canonical string a fingerprint hashes: [nodeId, input].
    def canonical_call(node_id, input, ignore_keys = [])
      "[#{quote(node_id.to_s)},#{canonicalize(input, ignore_keys)}]"
    end

    def digest(canonical)
      Digest::SHA256.hexdigest(canonical)[0, FINGERPRINT_HEX_CHARS]
    end

    # SHA-256 (first 32 hex chars) of canonical_call.
    def fingerprint_call(node_id, input, ignore_keys = [])
      digest(canonical_call(node_id, input, ignore_keys))
    end

    # The fingerprint the guard compares, or nil when the input could not be
    # read faithfully, was passed as UNREADABLE, or the nodeId is neither a
    # String nor a Symbol (JSON writes a Symbol as its name): such a call is
    # not known to equal anything, so it clears its kind's streak (rule 3).
    def comparable_fingerprint(node_id, input, ignore_keys)
      node_id = node_id.to_s if Symbol === node_id
      return nil unless String === node_id && !input.equal?(UNREADABLE)

      digest("[#{quote(node_id)},#{canon(input, ignore_keys, 0, new_seen)}]")
    rescue StandardError, SystemStackError
      nil
    end

    # The per-session counter (rule v3: one back-to-back streak per run per kind).
    class Guard
      # Rule 1. `tripped`: this count already held; `warned`: this streak
      # already produced its one warning.
      Streak = Struct.new(:node_id, :fingerprint, :repeats, :first_seq, :last_seq, :tripped, :warned)

      attr_reader :config

      def initialize(config)
        @config = config
        @mutex = Mutex.new
        # run -> kind -> streak; Hashes keep insertion order (LRU by re-insertion)
        @runs = {}
      end

      def enabled? = @config.mode != "off" && @config.threshold.positive?
      def mode = @config.mode
      def threshold = @config.threshold
      def tracked_runs = @mutex.synchronize { @runs.size }
      # Streaks kept across runs: at most runs x watched kinds.
      def tracked_streaks = @mutex.synchronize { @runs.each_value.sum(&:size) }

      # Is a start of this kind WATCHED (rules 2-4)? The nodeId may be anything
      # here — a watched start whose nodeId is not a String clears its kind's
      # streak rather than being ignored. A Symbol kind, name or nodeId (`kind:
      # :tool`) is written to the wire as its name, so it counts as that String.
      def watched?(kind, node_id, name)
        return false unless enabled?

        kind = kind.to_s if Symbol === kind
        return false unless String === kind && @config.kinds.include?(kind)

        allow = @config.allow_nodes
        return true if allow.empty?

        node_id = node_id.to_s if Symbol === node_id
        name = name.to_s if Symbol === name
        !((String === node_id && allow.include?(node_id)) || (String === name && allow.include?(name)))
      end

      # Watched, with a nodeId a gate can name.
      def applies_to?(kind, node_id, name)
        (String === node_id || Symbol === node_id) && watched?(kind, node_id, name)
      end

      # The comparable fingerprint, or UNREADABLE (input unreadable or passed as
      # UNREADABLE, nodeId not a String/Symbol). Pure: call it outside any lock.
      def fingerprint(node_id, input)
        LoopGuard.comparable_fingerprint(node_id, input, @config.ignore_keys) || UNREADABLE
      end

      # node.started (rules 2-4): extend or replace the kind's streak. `seq` is
      # that node.started's envelope seq; `fingerprint` comes from #fingerprint.
      # nil when the start is not watched, or when it was unreadable — the
      # latter clears the kind's streak.
      def record(run_id, kind, node_id, name, fingerprint, seq)
        return nil unless watched?(kind, node_id, name)

        kind = kind.to_s if Symbol === kind
        node_id = node_id.to_s if Symbol === node_id
        @mutex.synchronize do
          unless String === fingerprint && String === node_id
            # Rule 3: the call DID happen, with arguments nobody can compare, so
            # the previous call is no longer "the call right before" the next.
            @runs[run_id]&.delete(kind)
            return nil
          end
          streaks = streaks_for(run_id)
          streak = streaks[kind]
          if streak && streak.node_id == node_id && streak.fingerprint == fingerprint
            streak.repeats += 1
            streak.last_seq = seq
            streak.tripped = false
          else
            streak = Streak.new(node_id, fingerprint, 1, seq, seq, false, false)
            streaks[kind] = streak
          end
          Record.new(repeats: streak.repeats, first_seq: streak.first_seq, last_seq: streak.last_seq,
                     fingerprint: fingerprint, at_threshold: streak.repeats >= @config.threshold)
        end
      end

      # At `before` (rule 5): is this node's latest start the Nth identical
      # back-to-back call of its kind? Trips at most once per count.
      def consult(run_id, kind, node_id, name)
        return nil unless applies_to?(kind, node_id, name)

        kind = kind.to_s if Symbol === kind
        node_id = node_id.to_s if Symbol === node_id
        @mutex.synchronize do
          streak = @runs[run_id]&.[](kind)
          return nil if streak.nil? || streak.node_id != node_id || streak.tripped ||
                        streak.repeats < @config.threshold

          streak.tripped = true
          Info.new(repeats: streak.repeats, first_seq: streak.first_seq, last_seq: streak.last_seq,
                   fingerprint: streak.fingerprint)
        end
      end

      # The single warning for the current streak of this node — of `kind`, or
      # of whichever kind's streak belongs to `node_id`: true the first time only.
      def claim_warning(run_id, node_id, kind = nil)
        kind = kind.to_s if Symbol === kind
        node_id = node_id.to_s if Symbol === node_id
        @mutex.synchronize do
          streaks = @runs[run_id]
          return false if streaks.nil?

          candidates = kind.nil? ? streaks.values : [streaks[kind]]
          candidates.each do |streak|
            next if streak.nil? || streak.node_id != node_id
            return false if streak.warned

            streak.warned = true
            return true
          end
          false
        end
      end

      def forget(run_id)
        @mutex.synchronize { @runs.delete(run_id) }
      end

      private

      # Least-recently-used, not oldest-created: a long run still calling tools
      # must not lose its streak because MAX_RUNS short runs came and went.
      def streaks_for(run_id)
        streaks = @runs.delete(run_id)
        if streaks.nil?
          @runs.delete(@runs.first[0]) if @runs.size >= MAX_RUNS
          streaks = {}
        end
        @runs[run_id] = streaks # re-insert: least recently used is first
        streaks
      end
    end
  end
end
