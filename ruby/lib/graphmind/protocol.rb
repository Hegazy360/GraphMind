# frozen_string_literal: true

require "json"

module Graphmind
  # The wire contract, mirrored from packages/schema.
  #
  # Every message on the socket is one JSON text frame:
  #
  #   { "gm": 1, "seq": n, "ts": ms, "runId": "...", "type": "...", "payload": {} }
  #
  # `gm` is the MAJOR version of the contract: peers MUST reject envelopes
  # whose `gm` differs from their own. Backwards-compatible additions (new
  # message types, new payload fields) do NOT bump it — receivers tolerate
  # unknown types and unknown fields instead.
  module Protocol
    PROTOCOL_VERSION = 1

    # Envelope runId for messages not bound to a run (handshake, breakpoints,
    # mode).
    WILDCARD_RUN_ID = "*"

    EVENT_TYPES = %w[
      run.started
      run.finished
      graph.hint
      node.started
      node.token
      node.finished
      node.error
      exec.paused
      exec.resumed
    ].freeze

    CONTROL_TYPES = %w[exec.resume breakpoint.set breakpoint.clear mode.set].freeze
    HANDSHAKE_TYPES = %w[hello hello.ack].freeze
    MESSAGE_TYPES = (EVENT_TYPES + CONTROL_TYPES + HANDSHAKE_TYPES).freeze

    NODE_KINDS = %w[agent llm tool chain retriever server resource prompt custom].freeze
    RUN_STATUSES = %w[ok error aborted].freeze
    PAUSE_POINTS = %w[before after error].freeze
    RESUME_ACTIONS = %w[continue retry inject abort].freeze
    RUN_MODES = %w[run step].freeze
    TOKEN_CHANNELS = %w[text reasoning tool-args].freeze

    # Capabilities this client announces in `hello`.
    # `run-claim`: this client stores the `sessionToken` from `hello.ack` and
    # echoes it as `hello.resumeToken` on reconnect, so the debugger can refuse
    # writes to this app's runs from any other local process — including across
    # a disconnect, which is otherwise the one window a claim cannot be proven in.
    KNOWN_CAPABILITIES = %w[pause step inject retry abort run-claim].freeze

    # Result of parsing one inbound frame.
    ParseResult = Struct.new(:kind, :envelope, :reason, :received, keyword_init: true)

    module_function

    def message_type?(type) = MESSAGE_TYPES.include?(type)

    def create_envelope(type, payload, seq, run_id, ts = nil)
      {
        "gm" => PROTOCOL_VERSION,
        "seq" => seq,
        "ts" => ts || (Time.now.to_f * 1000).round,
        "runId" => run_id,
        "type" => type,
        "payload" => payload
      }
    end

    def serialize_envelope(envelope)
      JSON.generate(envelope)
    end

    # Parse one inbound JSON text frame.
    #
    # kind is one of:
    #   :ok               — a known envelope (`envelope`)
    #   :unknown_type     — well-formed but a type we do not know (tolerate)
    #   :version_mismatch — `gm` differs from ours (`received`)
    #   :invalid          — malformed (`reason`)
    def parse_envelope_json(text)
      raw =
        begin
          JSON.parse(text)
        rescue StandardError => e
          return ParseResult.new(kind: :invalid, reason: "not JSON (#{e.class})")
        end
      parse_envelope(raw)
    end

    def parse_envelope(raw)
      return ParseResult.new(kind: :invalid, reason: "not an object") unless raw.is_a?(Hash)

      gm = raw["gm"]
      return ParseResult.new(kind: :invalid, reason: "missing gm") unless gm.is_a?(Integer)

      if gm != PROTOCOL_VERSION
        return ParseResult.new(kind: :version_mismatch, received: gm)
      end

      type = raw["type"]
      return ParseResult.new(kind: :invalid, reason: "missing type") unless type.is_a?(String)
      return ParseResult.new(kind: :invalid, reason: "missing seq") unless raw["seq"].is_a?(Integer)
      return ParseResult.new(kind: :invalid, reason: "missing runId") unless raw["runId"].is_a?(String)
      return ParseResult.new(kind: :unknown_type, envelope: raw) unless message_type?(type)

      raw["payload"] = {} unless raw["payload"].is_a?(Hash)
      ParseResult.new(kind: :ok, envelope: raw)
    end
  end
end
