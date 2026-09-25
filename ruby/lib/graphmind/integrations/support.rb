# frozen_string_literal: true

require "digest"
require "json"
require "set"
require_relative "../loop_guard"

module Graphmind
  module Integrations
    # Shared helpers for provider integrations, including the LLM-step capture
    # rules of contract C1 (0.6.0) — a port of packages/client/src/llm-capture.ts
    # held to the same conformance fixture (packages/client/test/fixtures/llm.json):
    #
    #   make_usage       the wire TokenUsage: inputTokens is the TOTAL prompt
    #                    (cache reads and writes included), inclusive: true,
    #                    cache/reasoning counts only when reported (never 0-filled)
    #   normalize_finish_reason / finish_fields
    #                    stop|length|tool-calls|content-filter|error|other, plus
    #                    the provider's own string as rawFinishReason
    #   tool_call        {id?, name, input, inputText?} — inputText only when the
    #                    argument text does not parse
    #   capture_tools    tools: [{name, schemaHash}], each definition sent once
    #                    per run as toolSchemas (sha256 of canonical JSON, 16 hex),
    #                    as sanitize_tool_definition leaves it (never a credential)
    #   pick_params     the allow-listed sampling parameters actually sent
    #   record           a prompt made JSON-safe in FULL: no message-count or
    #                    length trim (the session's 512 KB shrink is the bound)
    module Support
      # Kept for the one place a non-Hash provider response is shown as text.
      MAX_CONTENT_CHARS = 2000

      FINISH_REASON_MAP = {
        "stop" => "stop", "end_turn" => "stop", "stop_sequence" => "stop", "pause_turn" => "other",
        "eos" => "stop", "eos_token" => "stop", "complete" => "stop", "completed" => "stop",
        "finished" => "stop",
        "length" => "length", "max_tokens" => "length", "max_output_tokens" => "length",
        "max_completion_tokens" => "length", "model_context_window_exceeded" => "length",
        "model_length" => "length",
        "tool_calls" => "tool-calls", "tool_call" => "tool-calls", "tool_use" => "tool-calls",
        "function_call" => "tool-calls",
        "content_filter" => "content-filter", "content_filtered" => "content-filter",
        "refusal" => "content-filter", "safety" => "content-filter", "recitation" => "content-filter",
        "blocklist" => "content-filter", "prohibited_content" => "content-filter",
        "spii" => "content-filter", "image_safety" => "content-filter",
        "guardrail_intervened" => "content-filter",
        "error" => "error", "failed" => "error", "malformed_function_call" => "error",
        "other" => "other", "unknown" => "other"
      }.freeze

      # Same list, same order as the TypeScript client (pinned by the fixture).
      SAMPLING_PARAM_KEYS = %w[
        maxOutputTokens maxTokens temperature topP topK stopSequences presencePenalty
        frequencyPenalty seed toolChoice responseFormat reasoning
        max_tokens max_completion_tokens max_output_tokens top_p top_k stop stop_sequences
        presence_penalty frequency_penalty logit_bias logprobs top_logprobs n tool_choice
        parallel_tool_calls response_format reasoning_effort thinking service_tier truncation
        text verbosity prompt_cache_key max_tool_calls context_management output_config
        cache_control
      ].freeze

      SCHEMA_HASH_HEX_CHARS = 16
      MAX_SCHEMA_RUNS = 256
      MAX_SCHEMA_HASHES_PER_RUN = 1024
      MAX_RECORD_DEPTH = 64

      # Keys of a tool definition that hold its SCHEMA: recorded verbatim (a
      # schema's property names are the tool's parameter names).
      TOOL_SCHEMA_KEYS = %w[parameters input_schema inputSchema output_schema outputSchema schema format].freeze
      # A key of a tool definition (outside its schema) that may carry a
      # credential or transport configuration: never recorded.
      TOOL_SECRET_KEY_RE = /authori[sz]ation|header|token|secret|passw(?:or)?d|key|cookie|credential|bearer/i
      TOOL_URL_KEY_RE = /url\z/i
      # A URL's userinfo: after its "//" (a backslash may stand for a slash, a
      # tab or newline may sit between them; whatever precedes them is kept) up
      # to the LAST "@" before the path, where URL parsers end it, so a password
      # holding "@" goes whole. Same pattern as TypeScript.
      URL_USERINFO_RE = %r{\A([^/\\]*[/\\][\t\n\r]*[/\\])[^/]*@}
      MAX_TOOL_DEFINITION_DEPTH = 16

      # What an owner (the session) was sent lives on the owner itself, so it is
      # exactly as alive as the owner. Not an ObjectSpace::WeakMap: its VALUES
      # are weak too, so any GC wiped it and the schemas were re-sent mid-run.
      SCHEMA_MEMORY_IVAR = :@__graphmind_tool_schemas
      SCHEMA_LOCK = Mutex.new
      private_constant :SCHEMA_MEMORY_IVAR, :SCHEMA_LOCK

      module_function

      # Read a parameter that may be keyed by Symbol or String.
      def param(parameters, key)
        return nil unless parameters.respond_to?(:[])

        value = parameters[key.to_sym]
        value.nil? ? parameters[key.to_s] : value
      end

      def param_key(parameters, key)
        return key.to_sym unless parameters.is_a?(Hash)
        return key.to_sym if parameters.key?(key.to_sym)
        return key.to_s if parameters.key?(key.to_s)

        key.to_sym
      end

      def truncate(text, limit = MAX_CONTENT_CHARS)
        string = text.to_s
        string.length > limit ? "#{string[0, limit]}… (#{string.length} chars)" : string
      end

      # -- usage ---------------------------------------------------------------

      # A finite non-negative number rounded like JS Math.round, else nil.
      def token_count(value)
        case value
        when Integer then value >= 0 ? value : nil
        when Float then value.finite? && value >= 0 ? (value + 0.5).floor : nil
        end
      end

      # The sum of the parts that were reported; nil when none was.
      def sum_reported(*parts)
        present = parts.compact
        present.empty? ? nil : present.sum
      end

      # The wire TokenUsage, or nil when neither count was reported. The schema
      # requires both counts, so the one a provider left out is 0; the optional
      # counts are never invented.
      def make_usage(input: nil, output: nil, cache_read: nil, cache_write: nil, reasoning: nil)
        input = token_count(input)
        output = token_count(output)
        return nil if input.nil? && output.nil?

        usage = { "inputTokens" => input || 0, "outputTokens" => output || 0, "inclusive" => true }
        { "cacheReadTokens" => cache_read, "cacheWriteTokens" => cache_write,
          "reasoningTokens" => reasoning }.each do |key, value|
          count = token_count(value)
          usage[key] = count unless count.nil?
        end
        usage
      end

      # Chat Completions usage: prompt_tokens is inclusive; cache reads in
      # prompt_tokens_details.cached_tokens (prompt_cache_hit_tokens on
      # OpenAI-compatible servers), writes in .cache_write_tokens.
      def openai_chat_usage(usage)
        return nil unless usage.is_a?(Hash)

        details = param(usage, :prompt_tokens_details)
        cache_read = token_count(param(details, :cached_tokens))
        cache_read = token_count(param(usage, :prompt_cache_hit_tokens)) if cache_read.nil?
        make_usage(
          input: param(usage, :prompt_tokens),
          output: param(usage, :completion_tokens),
          cache_read: cache_read,
          cache_write: param(details, :cache_write_tokens),
          reasoning: param(param(usage, :completion_tokens_details), :reasoning_tokens)
        )
      end

      # Responses usage: input_tokens is inclusive; details in
      # input_tokens_details / output_tokens_details.
      def openai_responses_usage(usage)
        return nil unless usage.is_a?(Hash)

        details = param(usage, :input_tokens_details)
        make_usage(
          input: param(usage, :input_tokens),
          output: param(usage, :output_tokens),
          cache_read: param(details, :cached_tokens),
          cache_write: param(details, :cache_write_tokens),
          reasoning: param(param(usage, :output_tokens_details), :reasoning_tokens)
        )
      end

      # Either OpenAI shape, by its keys.
      def openai_usage(usage)
        return nil unless usage.is_a?(Hash)

        chat = !param(usage, :prompt_tokens).nil? || !param(usage, :completion_tokens).nil?
        chat ? openai_chat_usage(usage) : openai_responses_usage(usage)
      end

      # ruby_llm token counts: `input` is the NON-cached count in 2.0
      # (Tokens#input, "standard (non-cached) input tokens") and in 1.x (every
      # provider subtracts or reports the uncached tail), so the total adds the
      # cache reads and writes. 1.x names them cached / cache_creation.
      def ruby_llm_usage(input:, output:, cache_read: nil, cache_write: nil, thinking: nil)
        read = token_count(cache_read)
        write = token_count(cache_write)
        make_usage(
          input: sum_reported(token_count(input), read, write),
          output: output,
          cache_read: read,
          cache_write: write,
          reasoning: thinking
        )
      end

      # -- finish reasons ------------------------------------------------------

      # The normalized finish reason, or nil when nothing usable was reported. A
      # Symbol (ruby_llm's :stop, :max_tokens) counts as its name.
      def normalize_finish_reason(raw, has_tool_calls = false)
        raw = raw.name if raw.is_a?(Symbol)
        return nil unless raw.is_a?(String)

        key = raw.strip.downcase.gsub(/[-\s]+/, "_")
        return nil if key.empty?

        mapped = FINISH_REASON_MAP.fetch(key, "other")
        mapped == "stop" && has_tool_calls ? "tool-calls" : mapped
      end

      # A `refused` step (OpenAI: a plain stop carrying a refusal) is
      # content-filter, as Anthropic's `refusal` stop reason is.
      def finish_fields(raw, has_tool_calls, refused = false)
        out = {}
        normalized = normalize_finish_reason(raw, has_tool_calls)
        normalized = "content-filter" if refused && normalized == "stop"
        out["finishReason"] = normalized unless normalized.nil?
        raw = raw.name if raw.is_a?(Symbol)
        out["rawFinishReason"] = String.new(raw) if raw.is_a?(String) && !raw.empty?
        out
      end

      # -- tool calls ----------------------------------------------------------

      # One requested call as {id?, name, input, inputText?}, or nil without a
      # name. A String `args` is JSON-parsed (blank -> {}; text that does not
      # parse -> input nil + inputText); anything else is the input as it is.
      def tool_call(id, name, args)
        name = name.name if name.is_a?(Symbol)
        return nil unless name.is_a?(String) && !name.empty?

        out = {}
        out["id"] = String.new(id) if id.is_a?(String) && !id.empty?
        out["name"] = String.new(name)
        if args.nil?
          out["input"] = {}
        elsif args.is_a?(String)
          if args.strip.empty?
            out["input"] = {}
          else
            begin
              out["input"] = JSON.parse(args)
            rescue JSON::ParserError, EncodingError
              out["input"] = nil
              out["inputText"] = String.new(args)
            end
          end
        else
          out["input"] = record(args)
        end
        out
      end

      # -- tool definitions ----------------------------------------------------

      def schema_hash(definition)
        Digest::SHA256.hexdigest(Graphmind::LoopGuard.canonicalize(definition))[0, SCHEMA_HASH_HEX_CHARS]
      end

      # The name of one request tool definition in any provider shape.
      def tool_def_name(entry)
        return nil unless entry.is_a?(Hash)

        [param(param(entry, :function), :name), param(param(entry, :custom), :name),
         param(entry, :name), param(entry, :type)].each do |candidate|
          candidate = candidate.name if candidate.is_a?(Symbol)
          return String.new(candidate) if candidate.is_a?(String) && !candidate.empty?
        end
        nil
      end

      # A (JSON-safe) tool definition as it is hashed and recorded: the schema
      # keys verbatim, every key matching TOOL_SECRET_KEY_RE dropped at any
      # depth outside them (an OpenAI `type: "mcp"` tool's authorization and
      # headers), a `*url` value cut to scheme://host/path. A function tool is
      # unchanged. Held to the fixture's toolDefinitions.
      def sanitize_tool_definition(definition, depth = 0)
        case definition
        when Array
          return [] if depth >= MAX_TOOL_DEFINITION_DEPTH

          definition.map { |item| sanitize_tool_definition(item, depth + 1) }
        when Hash
          return {} if depth >= MAX_TOOL_DEFINITION_DEPTH

          definition.each_with_object({}) do |(key, item), out|
            next unless key.is_a?(String)

            if TOOL_SCHEMA_KEYS.include?(key)
              out[key] = item
            elsif key.match?(TOOL_SECRET_KEY_RE)
              next
            elsif item.is_a?(String) && key.match?(TOOL_URL_KEY_RE)
              out[key] = without_url_secrets(item)
            else
              out[key] = sanitize_tool_definition(item, depth + 1)
            end
          end
        else
          definition
        end
      end

      # scheme://user:pass@host/path?query#fragment -> scheme://host/path
      def without_url_secrets(url)
        cut = [url.index("?"), url.index("#")].compact.min || url.length
        url[0, cut].sub(URL_USERINFO_RE) { Regexp.last_match(1) }
      end

      # {"tools" => [...], "toolSchemas" => {...}} for one LLM step, or nil. The
      # block names a definition (default: tool_def_name). The definition is
      # recorded JSON-safe and without credentials (sanitize_tool_definition),
      # and hashed in that form. Never raises.
      def capture_tools(owner, run_key, definitions, &describe)
        return nil unless definitions.is_a?(Array) && !definitions.empty?

        describe ||= method(:tool_def_name)
        tools = []
        schemas = {}
        SCHEMA_LOCK.synchronize do
          sent = run_memory(owner, run_key.to_s)
          # So the session can hand the hashes back (release_tool_schemas) when
          # the event carrying them does not reach the wire whole.
          schemas.instance_variable_set(:@graphmind_sent, sent)
          definitions.each do |definition|
            name = begin
              describe.call(definition)
            rescue StandardError
              nil
            end
            next if name.nil?

            plain = sanitize_tool_definition(record(definition))
            digest = schema_hash(plain)
            tools << { "name" => name, "schemaHash" => digest }
            next if sent.include?(digest)

            sent.clear if sent.size >= MAX_SCHEMA_HASHES_PER_RUN
            sent << digest
            schemas[digest] = plain
          end
        end
        return nil if tools.empty?

        out = { "tools" => tools }
        out["toolSchemas"] = schemas unless schemas.empty?
        out
      rescue StandardError
        nil
      end

      # The definitions in `tool_schemas` (a capture_tools result's, as it sits
      # in a node.started input) did NOT reach the wire whole: the payload
      # budget shrank that event (emptying every array inside them, `required:
      # []`) or it was dropped. Forget the run was sent them, so its next step
      # that uses them sends them again, intact. The session calls this. Never
      # raises.
      def release_tool_schemas(tool_schemas)
        return unless tool_schemas.is_a?(Hash) && tool_schemas.instance_variable_defined?(:@graphmind_sent)

        SCHEMA_LOCK.synchronize do
          sent = tool_schemas.instance_variable_get(:@graphmind_sent)
          tool_schemas.remove_instance_variable(:@graphmind_sent)
          tool_schemas.each_key { |digest| sent.delete(digest) } if sent.is_a?(Set)
        end
      rescue StandardError
        nil
      end

      def run_memory(owner, run_key)
        runs = owner_memory(owner)
        hashes = runs.delete(run_key)
        if hashes.nil?
          hashes = Set.new
          runs.delete(runs.first[0]) while runs.size >= MAX_SCHEMA_RUNS
        end
        runs[run_key] = hashes
        hashes
      end

      # A frozen owner cannot carry the memory: it gets a fresh one per step, so
      # its schemas are re-sent (extra bytes, never a missing definition).
      def owner_memory(owner)
        return {} if owner.frozen?

        runs = owner.instance_variable_get(SCHEMA_MEMORY_IVAR)
        runs.is_a?(Hash) ? runs : owner.instance_variable_set(SCHEMA_MEMORY_IVAR, {})
      end

      # Forget what a session was sent (tests).
      def reset_tool_schema_memory(owner)
        SCHEMA_LOCK.synchronize { owner.instance_variable_set(SCHEMA_MEMORY_IVAR, {}) unless owner.frozen? }
      end

      # The allow-listed parameters actually given (String or Symbol keys), JSON-safe.
      def pick_params(source)
        return {} unless source.is_a?(Hash)

        SAMPLING_PARAM_KEYS.each_with_object({}) do |key, out|
          value = param(source, key)
          out[key] = record(value) unless value.nil? || value.respond_to?(:call)
        end
      end

      # -- full prompts --------------------------------------------------------

      # `value` made JSON-safe WITHOUT truncation: every item, every character.
      # Binary Strings become {"type" => "binary", "bytes" => n}, a cycle
      # "[circular]", depth past 64 "…[depth limit]". Never raises.
      def record(value, depth = 0, path = nil)
        case value
        when nil, true, false, Integer then return value
        when Float then return value.finite? ? value : nil
        when Symbol then return value.name
        when String
          return value if value.encoding != Encoding::BINARY || value.ascii_only?

          utf8 = value.dup.force_encoding(Encoding::UTF_8)
          return utf8 if utf8.valid_encoding?

          return { "type" => "binary", "bytes" => value.bytesize }
        end
        return "…[depth limit]" if depth >= MAX_RECORD_DEPTH

        path ||= {}.compare_by_identity
        return "[circular]" if path.key?(value)

        path[value] = true
        begin
          record_container(value, depth, path)
        ensure
          path.delete(value)
        end
      rescue StandardError, SystemStackError
        begin
          value.to_s
        rescue StandardError
          value.class.name.to_s
        end
      end

      def record_container(value, depth, path)
        case value
        when Hash
          value.each_with_object({}) do |(key, item), out|
            out[key.is_a?(Symbol) ? key.name : key.to_s] = record(item, depth + 1, path)
          end
        when Array, Set then value.map { |item| record(item, depth + 1, path) }
        else
          value.respond_to?(:to_h) ? record(value.to_h, depth + 1, path) : value.to_s
        end
      end
    end
  end
end
