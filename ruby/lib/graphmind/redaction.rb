# frozen_string_literal: true

require_relative "env"
require_relative "protocol"

module Graphmind
  # Coarse redaction: four kill switches, applied at the one emit choke point.
  #
  # Port of packages/client/src/redaction.ts (read that file's header for the
  # rationale). Whole-field replacement of `node.started.input` and
  # `node.finished.output` (and the text of `node.token` deltas) with the
  # placeholder "__REDACTED__", chosen by node kind. No deny lists, no regexes,
  # no callbacks.
  #
  #   GRAPHMIND_HIDE_INPUTS        (hide_inputs:)        node.started.input, every kind;
  #                                                      streamed `tool-args` deltas; the
  #                                                      arguments of output.toolCalls[]
  #   GRAPHMIND_HIDE_OUTPUTS       (hide_outputs:)       node.finished.output, every kind;
  #                                                      every streamed delta
  #   GRAPHMIND_HIDE_TOOL_ARGS     (hide_tool_args:)     node.started.input when kind is
  #                                                      tool; streamed `tool-args` deltas;
  #                                                      the arguments of output.toolCalls[]
  #                                                      (input / inputText, and the older
  #                                                      arguments / args) — the calls a
  #                                                      model requested carry the tool
  #                                                      node's own input
  #   GRAPHMIND_HIDE_TOOL_RESULTS  (hide_tool_results:)  node.finished.output when the
  #                                                      instance's kind is tool; deltas a
  #                                                      tool node streams
  #
  # Env values `1` / `true` (case-insensitive, surrounding whitespace ignored)
  # turn a switch on; each is also a Session option. Either source turning a
  # switch on turns it on: an environment switch is a floor code cannot lower.
  #
  # Every affected event carries `redaction: {count, keys}`. `node.error` is
  # deliberately NOT redacted (error messages may echo data). A field that is
  # absent, or already the placeholder, is left alone and not counted; an
  # existing `redaction` summary is merged. A key present with `nil` is JSON
  # null, which counts as a value. Symbol keys (`input:`) are honoured too:
  # JSON.generate would write them as "input".
  #
  # What the TOOL-only switches do not cover: in an agent loop the same tool
  # arguments and results also travel through the LLM node (the model's tool
  # calls are its output, the results are the next request's input), and those
  # are recorded unless hide_inputs / hide_outputs are on as well.
  #
  # The session applies this inside emit_internal BEFORE the ring buffer, so
  # replay-on-attach, the socket and everything downstream see only the
  # redacted event. Never raises, never mutates the caller's Hash, zero cost
  # when every switch is off. Thread-safe.
  #
  # FAILS CLOSED (internal/decisions.md "Redaction fails closed on internal
  # error", binding for every port). With any switch on, node.started,
  # node.finished and node.token are redacted from a one-read SNAPSHOT: a plain
  # Hash built from the payload's real storage (Hash#each_pair, bound, so an
  # overridden #[] / #key? / #each_pair / #to_json cannot show the redactor one
  # thing and JSON.generate another), with every key under the name JSON.generate
  # writes for it (#to_s, read once), so what was inspected is exactly what is
  # sent. When that cannot be done — the payload is not a Hash, a key's #to_s or
  # #hash raises, token `deltas` a hiding switch could cover is missing or not
  # an Array, a covered delta is neither nil nor a Hash or has a `v` that is
  # present and not a String, an identity field a switch decides by
  # (nodeId/instanceId/kind of a start, nodeId/instanceId of a result, nodeId of
  # a token, t of each delta of a batch a switch could cover) is present, not nil
  # and neither a String nor a Symbol (JSON.generate writes any other object as
  # its #to_s), or any internal error — the event is replaced by
  # its FAILED FORM, built without reading input/output/deltas:
  #
  #   node.started   {nodeId, parentId?, kind, name, instanceId, input: "__REDACTED__"}
  #   node.finished  {nodeId, instanceId?, durationMs, heldMs?, status, usage?, output: "__REDACTED__"}
  #   node.token     {nodeId, instanceId?, deltas: []}
  #
  # each with `redaction: {count: 0, keys: ["input","output","deltas"], failed:
  # true}`. An optional field that cannot be read or is not schema-valid is
  # omitted; when a required one cannot be (nodeId/name/instanceId Strings, kind
  # a node kind, durationMs a finite number >= 0, status ok|error|aborted),
  # #apply returns DROP and the session does not emit the event. Both outcomes
  # are reported through the `warn:` callback without quoting the payload or
  # the error.
  module Redaction
    REDACTED = "__REDACTED__"

    # Returned by Redactor#apply when the event must NOT be emitted.
    DROP = Object.new.tap { |o| o.define_singleton_method(:inspect) { "Graphmind::Redaction::DROP" } }.freeze

    # `redaction.keys` of a failed form: nothing counted, every hideable field named.
    FAILED_KEYS = %w[input output deltas].freeze

    # Event types the redactor inspects; every other type passes through.
    REDACTED_TYPES = %w[node.started node.finished node.token].freeze

    # The debugger's answers to a pause (0.6.0, contract C2), covered exactly
    # when the paused node's input is — hide_inputs, or hide_tool_args when the
    # paused node is a tool (an unknown kind counts as a tool):
    #   exec.resumed.edited   -> {"after" => "__REDACTED__"}, counted as "edited"
    #   exec.refused.message  -> omitted, counted as "message"
    # Their failed forms keep pauseId, action / code and requestId, hide
    # `edited` and drop `message`, with redaction.failed. This gem never edits
    # an input (it does not announce edit-input), but its refusals and the
    # shared fixture follow the same rule as every other port.
    PAUSE_ANSWER_TYPES = %w[exec.resumed exec.refused].freeze

    # `RefusalCode` (schema events.ts).
    REFUSAL_CODES = %w[schema shape placeholder truncated disabled unsupported].freeze

    # Payload fields the failed form may copy (identity and timing only).
    IDENTITY_FIELDS = %w[nodeId parentId kind name instanceId durationMs heldMs status usage].freeze

    # Fields whose String value decides what is hidden: copied as plain Strings
    # into the snapshot, so a String subclass cannot compare as one value and
    # serialise (#to_json) as another.
    DECIDING_FIELDS = %w[nodeId instanceId kind t].freeze

    # Hash's and Array's own readers, bound per call: they read the real storage
    # (what JSON.generate walks), whatever a subclass or singleton overrides.
    HASH_EACH_PAIR = Hash.instance_method(:each_pair)
    ARRAY_TO_A = Array.instance_method(:to_a)
    STRING_BYTESIZE = String.instance_method(:bytesize)

    # Raised (and caught) inside #apply when a payload cannot be inspected safely.
    class Uninspectable < StandardError; end

    SWITCH_ENV = {
      hide_inputs: "GRAPHMIND_HIDE_INPUTS",
      hide_outputs: "GRAPHMIND_HIDE_OUTPUTS",
      hide_tool_args: "GRAPHMIND_HIDE_TOOL_ARGS",
      hide_tool_results: "GRAPHMIND_HIDE_TOOL_RESULTS"
    }.freeze

    # Open instances tracked at once, across all runs; oldest evicted past this.
    DEFAULT_MAX_TRACKED_INSTANCES = 10_000
    MAX_TRACKED_NODES = 10_000
    MAX_SAFE_INTEGER = (2**53) - 1

    Switches = Struct.new(:hide_inputs, :hide_outputs, :hide_tool_args, :hide_tool_results,
                          keyword_init: true) do
      def any? = hide_inputs || hide_outputs || hide_tool_args || hide_tool_results ? true : false
    end

    module_function

    # A GRAPHMIND_HIDE_* value that turns its switch ON: anything but unset,
    # empty, `0`, `false`, `off` and `no` (Graphmind::Env.kill_switch_on?).
    def env_flag_on?(value)
      Graphmind::Env.kill_switch_on?(value)
    rescue StandardError
      false
    end

    # An option value that turns a switch ON: true, 1, or an env spelling.
    def option_flag_on?(value)
      return true if value == true
      return true if value.is_a?(Numeric) && !value.is_a?(Complex) && value == 1

      env_flag_on?(value)
    rescue StandardError
      false
    end

    # Either the option or the environment turning a switch on turns it on.
    # Never raises: an unreadable source counts as "not on" for that source.
    def resolve(options, env)
      values = SWITCH_ENV.to_h do |name, env_name|
        on = begin
          options.is_a?(Hash) && (option_flag_on?(options[name]) || option_flag_on?(options[name.to_s]))
        rescue StandardError
          false
        end
        unless on
          on = begin
            env_flag_on?(env && env[env_name])
          rescue StandardError
            false
          end
        end
        [name, on ? true : false]
      end
      Switches.new(**values)
    end

    # JavaScript `string.length`: UTF-16 code units, so an emoji counts 2.
    def utf16_length(text)
      text.encode(Encoding::UTF_16LE).bytesize / 2
    rescue StandardError
      text.length
    end

    # A JS number that is a non-negative safe integer (1.0 counts, like JS).
    def safe_count(raw)
      return nil unless Integer === raw || Float === raw
      return nil if Float === raw && (!raw.finite? || raw != raw.floor)
      return nil if raw.negative? || raw > MAX_SAFE_INTEGER

      raw.to_i
    rescue StandardError
      nil
    end

    # Merge a fresh summary into whatever `redaction` the payload already had.
    def merge_summary(existing, count, key)
      if existing.is_a?(Hash)
        raw_count = fetch(existing, "count")
        raw_keys = fetch(existing, "keys")
        if raw_count.is_a?(Numeric) && !raw_count.is_a?(Complex) && raw_keys.is_a?(Array)
          prior = raw_keys.select { |k| k.is_a?(String) }
          keys = prior.include?(key) ? prior : prior + [key]
          total = (safe_count(raw_count) || 0) + count
          return { "count" => total <= MAX_SAFE_INTEGER ? total : count, "keys" => keys }
        end
      end
      { "count" => count, "keys" => [key] }
    end

    # Every key under which `name` reaches the JSON text, in insertion order:
    # the String and/or the Symbol. JSON.generate writes BOTH when both are
    # present, and a JSON parser (the hub's included) keeps the LAST, so a
    # switch must hide every one of them, and a read must take the last.
    def keys_of(hash, name)
      sym = name.to_sym
      has_string = hash.key?(name)
      has_symbol = hash.key?(sym)
      return [] unless has_string || has_symbol
      return [has_string ? name : sym] unless has_string && has_symbol

      hash.keys.select { |k| k.equal?(sym) || (k.is_a?(String) && k == name) }
    end

    # The key whose value the JSON reader will see for `name`, or nil.
    def key_of(hash, name) = keys_of(hash, name).last

    def fetch(hash, name)
      key = key_of(hash, name)
      key.nil? ? nil : hash[key]
    end

    # A kind (or delta channel) as it reaches the wire: a Symbol (`kind: :tool`,
    # `:"tool-args"`) is written as its name, so it IS that value for every switch.
    def wire_kind(kind) = Symbol === kind ? kind.name : kind

    # `String ===` and `REDACTED ==` run String's own code, never a method the
    # value defines (a lying #is_a? or #== must not make a secret "already hidden").
    def placeholder?(value) = String === value && REDACTED == value

    # A value equal to `literal` as JSON writes it (a Symbol as its name).
    def wire_eq?(value, literal)
      value = value.name if Symbol === value
      String === value && literal == value
    end

    # The name JSON.generate writes for a Hash key: it calls #to_s on EVERY key
    # (a String's own singleton #to_s included), so that is the name to inspect.
    # A Symbol stays a Symbol (its name cannot be overridden per object).
    def json_key(key)
      return key if Symbol === key

      text = key.to_s
      raise Uninspectable, "a key's #to_s is not a String" unless String === text

      String.new(text).freeze
    end

    # A plain String copy of a String value (a subclass's #to_json dropped).
    def plain_string(value) = String === value ? String.new(value).freeze : value

    # An identity field a switch decides by (a start's kind, the nodeId /
    # instanceId a result's kind is looked up by, a delta's t), read from a
    # SNAPSHOT: absent or nil -> nil, a String -> itself (the snapshot already
    # made it plain), a Symbol -> its name (JSON writes it so). Anything else is
    # compared as one value but serialised as another — JSON.generate writes an
    # object as its #to_s — so a kind whose #to_s is "tool" would keep a tool's
    # arguments visible under `"kind":"tool"`. Such a payload cannot be
    # inspected: raise, and the caller fails closed (TS parity).
    def identity(snap, name)
      value = fetch(snap, name)
      return nil if value.nil?
      return value if String === value
      return value.name if Symbol === value

      raise Uninspectable, "#{name} is not a String"
    end

    # One read of a Hash's real storage into a plain Hash under the key names
    # JSON.generate writes (see the module comment). Raises when a key cannot
    # be named or hashed; the caller fails closed.
    def snapshot(hash)
      copy = {}
      HASH_EACH_PAIR.bind_call(hash) do |key, value|
        name = json_key(key)
        field = Symbol === name ? name.name : name
        copy[name] = DECIDING_FIELDS.include?(field) ? plain_string(value) : value
      end
      copy
    end

    # The identity/timing fields of a payload for the failed form, read
    # best-effort: a key that cannot be named is skipped; the last spelling of a
    # field wins, as it does for the JSON reader.
    def identity_fields(hash, wanted = IDENTITY_FIELDS)
      fields = {}
      HASH_EACH_PAIR.bind_call(hash) do |key, value|
        begin
          name = json_key(key)
        rescue StandardError
          next
        end
        name = name.name if Symbol === name
        fields[name] = plain_string(value) if wanted.include?(name)
      end
      fields
    end

    def string_field(value)
      return value.name.dup.freeze if Symbol === value

      String === value ? value : nil
    end

    def duration_field(value)
      ok = Integer === value || (Float === value && value.finite?)
      ok && value >= 0 ? value : nil
    end

    # The optional usage counts the failed form keeps (with `inclusive`), in wire order.
    OPTIONAL_USAGE_COUNTS = %w[cacheReadTokens cacheWriteTokens reasoningTokens].freeze
    USAGE_FIELDS = (%w[inputTokens outputTokens inclusive] + OPTIONAL_USAGE_COUNTS).freeze

    # The fields of an output.toolCalls[] entry that carry the model's tool
    # arguments: input / inputText (0.6.0+) and the spellings older senders used
    # (arguments — the 0.5 OpenAI adapters; args — LangChain's own).
    TOOL_CALL_ARG_KEYS = %w[input inputText arguments args].freeze

    # {inputTokens, outputTokens} (both safe integers >= 0, else nil), plus
    # `inclusive` when it is a boolean and cacheReadTokens / cacheWriteTokens /
    # reasoningTokens when each is a safe integer >= 0 (0.6.0+). Nothing else.
    def usage_field(value)
      return nil unless Hash === value

      counts = identity_fields(value, USAGE_FIELDS)
      input = safe_count(counts["inputTokens"])
      output = safe_count(counts["outputTokens"])
      return nil unless input && output

      out = { "inputTokens" => input, "outputTokens" => output }
      inclusive = counts["inclusive"]
      out["inclusive"] = inclusive if TrueClass === inclusive || FalseClass === inclusive
      OPTIONAL_USAGE_COUNTS.each do |name|
        count = safe_count(counts[name])
        out[name] = count unless count.nil?
      end
      out
    end

    # Applies the switches to one event at a time. One per session.
    class Redactor
      attr_reader :switches

      # `warn:` receives the fail-closed reports as (key, message); keys
      # "redaction:failed" and "redaction:dropped". A raising sink is swallowed.
      def initialize(switches, max_instances: DEFAULT_MAX_TRACKED_INSTANCES, warn: nil)
        @switches = switches
        @max_instances = [max_instances.to_i, 1].max
        @warn = warn
        @mutex = Mutex.new
        # Hashes keep insertion order -> oldest-first eviction
        @instances = {}
        @nodes = {}
      end

      def active? = @switches.any?

      def tracked_instances = @mutex.synchronize { @instances.size }

      # Does a switch hide the input of a paused node of this kind? hide_inputs,
      # or hide_tool_args on a tool — an unknown kind (nil, or anything that is
      # neither a String nor a Symbol) counts as a tool.
      def covers_pause_input?(node_kind)
        return true if @switches.hide_inputs
        return false unless @switches.hide_tool_args

        kind = Symbol === node_kind ? node_kind.name : node_kind
        # The literal's own String#==, never a #== the kind object defines.
        !(String === kind) || "tool" == kind
      end

      # Redact one event. Every switch off, or a type other than node.started /
      # node.finished / node.token / exec.resumed / exec.refused: the very same
      # object. Otherwise a plain Hash (see the module comment) — redacted,
      # unchanged, or the failed form — or DROP, meaning the event must NOT be
      # emitted. `node_kind` is the paused node's kind, for exec.resumed /
      # exec.refused (which do not name their node). Never raises.
      def apply(type, payload, run_id, node_kind = nil)
        return payload unless @switches.any?

        type = type.name if Symbol === type # JSON writes :"node.started" as "node.started"
        return on_pause_answer(type, payload, node_kind) if String === type && PAUSE_ANSWER_TYPES.include?(type)
        return payload unless String === type && REDACTED_TYPES.include?(type)

        begin
          raise Uninspectable, "payload is not a Hash" unless Hash === payload

          snap = Redaction.snapshot(payload)
          case type
          when "node.started" then on_started(snap, run_id)
          when "node.finished" then on_finished(snap, run_id)
          else on_token(snap, run_id)
          end
        rescue StandardError, SystemStackError
          fail_closed(type, payload, run_id)
        end
      rescue StandardError, SystemStackError
        DROP
      end

      private

      # -- exec.resumed / exec.refused ------------------------------------------

      # The input-shaped parts of a pause's answer, hidden exactly when the
      # paused node's input is. Not covered: the very same object. Covered: a
      # snapshot copy, or the failed form.
      def on_pause_answer(type, payload, node_kind)
        return payload unless covers_pause_input?(node_kind)

        begin
          raise Uninspectable, "payload is not a Hash" unless Hash === payload

          snap = Redaction.snapshot(payload)
          Redaction.identity(snap, "pauseId")
          if type == "exec.resumed"
            keys = Redaction.keys_of(snap, "edited")
            return snap if keys.empty?
            # Already the placeholder: left alone, not counted.
            return snap if keys.length == 1 && hidden_edit?(snap[keys.first])

            keys.each { |key| snap[key] = { "after" => REDACTED } }
            with_summary(snap, 1, "edited")
          else
            keys = Redaction.keys_of(snap, "message")
            return snap if keys.empty?

            keys.each { |key| snap.delete(key) }
            with_summary(snap, 1, "message")
          end
        rescue StandardError, SystemStackError
          fail_closed_answer(type, payload)
        end
      end

      # `edited` is exactly {after: placeholder}.
      def hidden_edit?(edited)
        return false unless Hash === edited

        copy = Redaction.snapshot(edited)
        copy.size == 1 && Redaction.placeholder?(Redaction.fetch(copy, "after"))
      end

      def fail_closed_answer(type, payload)
        out = begin
          failed_answer_form(type, payload)
        rescue StandardError, SystemStackError
          nil
        end
        if out.nil?
          report("redaction:dropped",
                 "a #{type} event could not be redacted and its identity fields could not be read; " \
                 "dropped it rather than send data a GRAPHMIND_HIDE_* switch hides")
          return DROP
        end
        report("redaction:failed",
               "redaction failed on a #{type} event (unreadable or malformed payload); " \
               "sent it with the edited input / refusal message hidden and redaction.failed set")
        out
      end

      ANSWER_FIELDS = %w[pauseId action code requestId].freeze

      # The failed form of a pause answer, or nil when pauseId and action / code
      # cannot be read as valid values (the event is then dropped).
      def failed_answer_form(type, payload)
        return nil unless Hash === payload

        fields = Redaction.identity_fields(payload, ANSWER_FIELDS)
        pause_id = Redaction.string_field(fields["pauseId"])
        return nil if pause_id.nil?

        request_id = Redaction.string_field(fields["requestId"])
        echo = request_id.nil? ? {} : { "requestId" => request_id }
        if type == "exec.resumed"
          action = Redaction.string_field(fields["action"])
          return nil unless action && Protocol::RESUME_ACTIONS.include?(action)

          out = { "pauseId" => pause_id, "action" => action }
          # Unreadable counts as present: an edit the record cannot rule out.
          out["edited"] = { "after" => REDACTED } if may_have_edit?(payload)
          return out.merge(echo).merge("redaction" => { "count" => 0, "keys" => ["edited"], "failed" => true })
        end
        code = Redaction.string_field(fields["code"])
        return nil unless code && REFUSAL_CODES.include?(code)

        { "pauseId" => pause_id, "code" => code }
          .merge(echo)
          .merge("redaction" => { "count" => 0, "keys" => ["message"], "failed" => true })
      end

      def may_have_edit?(payload)
        found = false
        HASH_EACH_PAIR.bind_call(payload) do |key, _value|
          name = begin
            Redaction.json_key(key)
          rescue StandardError
            found = true
            next
          end
          name = name.name if Symbol === name
          found = true if name == "edited"
        end
        found
      rescue StandardError
        true
      end

      # -- fail closed ----------------------------------------------------------

      def fail_closed(type, payload, run_id)
        out = begin
          failed_form(type, payload, run_id)
        rescue StandardError, SystemStackError
          nil
        end
        if out.nil?
          report("redaction:dropped",
                 "a #{type} event could not be redacted and its identity fields could not be read; " \
                 "dropped it rather than send data a GRAPHMIND_HIDE_* switch hides")
          return DROP
        end
        report("redaction:failed",
               "redaction failed on a #{type} event (unreadable or malformed payload); " \
               "sent it with input/output/deltas hidden and redaction.failed set")
        out
      end

      # The failed form (module comment), or nil when it cannot be valid.
      # Never reads input, output or deltas.
      def failed_form(type, payload, run_id)
        return nil unless Hash === payload

        fields = Redaction.identity_fields(payload)
        node_id = Redaction.string_field(fields["nodeId"])
        return nil if node_id.nil?

        out = { "nodeId" => node_id }
        failed = { "count" => 0, "keys" => FAILED_KEYS.dup, "failed" => true }
        case type
        when "node.started"
          parent_id = Redaction.string_field(fields["parentId"])
          out["parentId"] = parent_id unless parent_id.nil?
          kind = Redaction.string_field(fields["kind"])
          name = Redaction.string_field(fields["name"])
          instance_id = Redaction.string_field(fields["instanceId"])
          return nil unless kind && Protocol::NODE_KINDS.include?(kind) && name && instance_id

          # Still learn the kind, so this instance's node.finished is judged right.
          remember(run_id, node_id, instance_id, kind)
          out.merge!("kind" => kind, "name" => name, "instanceId" => instance_id,
                     "input" => REDACTED, "redaction" => failed)
        when "node.finished"
          instance_id = Redaction.string_field(fields["instanceId"])
          unless instance_id.nil?
            out["instanceId"] = instance_id
            @mutex.synchronize { @instances.delete([run_id, node_id, instance_id]) }
          end
          duration = Redaction.duration_field(fields["durationMs"])
          status = Redaction.string_field(fields["status"])
          return nil unless duration && status && Protocol::RUN_STATUSES.include?(status)

          out["durationMs"] = duration
          held = Redaction.duration_field(fields["heldMs"])
          out["heldMs"] = held unless held.nil?
          out["status"] = status
          usage = Redaction.usage_field(fields["usage"])
          out["usage"] = usage unless usage.nil?
          out.merge!("output" => REDACTED, "redaction" => failed)
        else
          instance_id = Redaction.string_field(fields["instanceId"])
          out["instanceId"] = instance_id unless instance_id.nil?
          out.merge!("deltas" => [], "redaction" => failed)
        end
      end

      def report(key, message)
        @warn&.call(key, message)
      rescue StandardError
        nil # a raising sink must not turn a safe outcome into a raise
      end

      # -- events ----------------------------------------------------------------
      # Each handler receives the SNAPSHOT (a plain Hash the redactor owns) and
      # returns it, changed in place. A raise means "fail closed".

      def on_started(snap, run_id)
        kind = Redaction.identity(snap, "kind")
        node_id = Redaction.identity(snap, "nodeId")
        instance_id = Redaction.identity(snap, "instanceId")
        remember(run_id, node_id, instance_id, kind) if node_id && kind
        hide = @switches.hide_inputs || (@switches.hide_tool_args && Redaction.wire_eq?(kind, "tool"))
        replace(snap, "input", 1, hide)
      end

      def on_finished(snap, run_id)
        node_id = Redaction.identity(snap, "nodeId")
        instance_id = Redaction.identity(snap, "instanceId")
        kind = node_id ? kind_of(run_id, node_id, instance_id) : nil
        @mutex.synchronize { @instances.delete([run_id, node_id, instance_id]) } if node_id && instance_id
        hide = @switches.hide_outputs || (@switches.hide_tool_results && Redaction.wire_eq?(kind, "tool"))
        return replace(snap, "output", 1, true) if hide
        # The tool calls a model requested carry the very arguments the tool
        # node will receive: hide them wherever tool arguments are hidden (the
        # same switches as `tool-args` deltas).
        return hide_tool_call_args(snap) if @switches.hide_tool_args || @switches.hide_inputs

        snap
      end

      # output.toolCalls[*] with every argument field (TOOL_CALL_ARG_KEYS)
      # replaced by the placeholder, from one-read snapshots of the output and of
      # each call. A toolCalls that is not an Array, or an entry that is neither
      # nil nor a Hash, is replaced whole. Every spelling (String/Symbol key) is
      # covered; the count is the one the reader keeps (the last). TS parity:
      # hideToolCallArgs.
      def hide_tool_call_args(snap)
        count = 0
        Redaction.keys_of(snap, "output").each do |output_key|
          output = snap[output_key]
          next unless Hash === output

          copy = Redaction.snapshot(output)
          call_keys = Redaction.keys_of(copy, "toolCalls")
          next if call_keys.empty?

          call_keys.each do |call_key|
            calls = copy[call_key]
            next if calls.nil? || Redaction.placeholder?(calls)

            if Array === calls
              count, copy[call_key] = redact_tool_calls(ARRAY_TO_A.bind_call(calls))
            else
              copy[call_key] = REDACTED
              count = 1
            end
          end
          snap[output_key] = copy
        end
        count.zero? ? snap : with_summary(snap, count, "output.toolCalls")
      end

      # [count, copied calls].
      def redact_tool_calls(calls)
        count = 0
        out = calls.map do |call|
          next call if call.nil? || Redaction.placeholder?(call)
          unless Hash === call
            count += 1
            next REDACTED
          end

          entry = Redaction.snapshot(call)
          TOOL_CALL_ARG_KEYS.each do |name|
            keys = Redaction.keys_of(entry, name)
            next if keys.empty?

            count += 1 unless Redaction.placeholder?(entry[keys.last])
            keys.each { |key| entry[key] = REDACTED }
          end
          entry
        end
        [count, out]
      end

      def replace(snap, field, count, hide)
        return snap unless hide

        keys = Redaction.keys_of(snap, field)
        return snap if keys.empty?

        counted = !keys.all? { |key| Redaction.placeholder?(snap[key]) }
        # Every spelling becomes the plain placeholder — one that already equals
        # it too (not counted), so a String subclass that compares equal cannot
        # serialise as something else.
        keys.each { |key| snap[key] = REDACTED }
        counted ? with_summary(snap, count, field) : snap
      end

      # Merge the summary into the `redaction` the reader will see, and write it
      # under every key that spells `redaction` so no stale copy wins the parse.
      def with_summary(out, count, field)
        summary_keys = Redaction.keys_of(out, "redaction")
        summary = Redaction.merge_summary(summary_keys.empty? ? nil : out[summary_keys.last], count, field)
        (summary_keys.empty? ? ["redaction"] : summary_keys).each { |key| out[key] = summary }
        out
      end

      def on_token(snap, run_id)
        node_id = Redaction.identity(snap, "nodeId")
        node_is_tool = @switches.hide_tool_results && node_id &&
                       kind_of(run_id, node_id, nil) == "tool"
        hide_all = @switches.hide_outputs || node_is_tool
        hide_tool_args = @switches.hide_tool_args || @switches.hide_inputs
        return snap unless hide_all || hide_tool_args

        deltas_keys = Redaction.keys_of(snap, "deltas")
        raise Uninspectable, "deltas is missing" if deltas_keys.empty?

        # Every spelling of `deltas` is inspected and replaced by its copy; the
        # count is the one the reader keeps (the last).
        count = 0
        deltas_keys.each do |key|
          list = snap[key]
          raise Uninspectable, "deltas is not an Array" unless Array === list

          count, snap[key] = redact_deltas(ARRAY_TO_A.bind_call(list), hide_all, hide_tool_args)
        end
        count.zero? ? snap : with_summary(snap, count, "deltas")
      end

      # [count, copied deltas]. One read of the Array and of each delta; the
      # copies are what is sent.
      def redact_deltas(deltas, hide_all, hide_tool_args)
        count = 0
        out = deltas.map do |delta|
          next nil if delta.nil?
          # A bare String (or number, Array...) where a delta belongs: its
          # channel is unknown, so every hiding switch may cover it.
          raise Uninspectable, "a delta is not a Hash" unless Hash === delta

          copy = Redaction.snapshot(delta)
          channel = Redaction.identity(copy, "t") # read even under hide_all: one rule for every port
          hide = hide_all || (hide_tool_args && Redaction.wire_eq?(channel, "tool-args"))
          next copy unless hide

          v_keys = Redaction.keys_of(copy, "v")
          next copy if v_keys.empty?
          raise Uninspectable, "a covered delta value is not a String" unless v_keys.all? { |key| String === copy[key] }

          visible = copy[v_keys.last]
          counted = !STRING_BYTESIZE.bind_call(visible).zero?
          chars = counted ? Redaction.utf16_length(String.new(visible)) : nil
          v_keys.each { |key| copy[key] = "" unless STRING_BYTESIZE.bind_call(copy[key]).zero? }
          if counted
            count += 1
            copy["chars"] = chars
          end
          copy
        end
        [count, out]
      end

      def remember(run_id, node_id, instance_id, kind)
        @mutex.synchronize do
          node_key = [run_id, node_id]
          @nodes.delete(node_key) # re-insert so the newest is last
          @nodes[node_key] = kind
          @nodes.delete(@nodes.first[0]) while @nodes.size > MAX_TRACKED_NODES
          next if instance_id.nil?

          @instances[[run_id, node_id, instance_id]] = kind
          @instances.delete(@instances.first[0]) while @instances.size > @max_instances
        end
      end

      def kind_of(run_id, node_id, instance_id)
        found = @mutex.synchronize do
          (instance_id && @instances[[run_id, node_id, instance_id]]) || @nodes[[run_id, node_id]]
        end
        return found unless found.nil?

        # Last resort: the nodeId convention every adapter follows (decisions.md #1).
        node_id.start_with?("tool:") ? "tool" : nil
      end
    end
  end
end
