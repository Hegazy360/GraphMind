# frozen_string_literal: true

require "json"
require_relative "redaction"
require_relative "shrink"

module Graphmind
  # The client-side inject guard (0.6.0, contract C2; refute-security C2.3 /
  # S5): a value that still carries the redaction placeholder or a truncation
  # marker is a pre-filled copy of a RECORDING its sender never saw in full —
  # not a result anyone meant to substitute. Refused (the gate stays held) under
  # every debugger, a 0.5 hub included, whose own guard knows only the
  # placeholder.
  #
  # Port of `proposedValueRefusal` in packages/client/src/edit-input.ts — one
  # marker list for every SDK and the hub, pinned by the shared fixture
  # packages/client/test/fixtures/edit-input.json (its `proposedValue`
  # section). This gem does not announce `edit-input`, so it never runs an
  # edited input; only injected values need the guard.
  #
  # The markers, over the value's compact JSON text:
  #   * "__REDACTED__" anywhere                               -> placeholder
  #   * the shrink's `__graphmindTruncated` key and "…[graphmind: truncated]"
  #     suffix, LangGraph's `"__graphmind":"truncated"` / `"unserializable"`,
  #     the MCP get_node preview's `"note":"payload truncated: showing first `
  #   * the Python SDK's recording bounds (`…[truncated]"`, `"<N bytes>"`,
  #     `"…[depth limit]"`, a `"…"` key holding `"[N more keys]"`, `"…[N more]"`)
  #                                                            -> truncated
  module EditGuard
    # A refusal the client decided (codes and messages never quote values).
    Refusal = Struct.new(:code, :message)

    ELLIPSIS = "\xE2\x80\xA6".dup.force_encoding(Encoding::UTF_8).freeze
    MCP_PREVIEW_NOTE_PREFIX = "payload truncated: showing first "

    TRUNCATION_MARKERS = [
      "__graphmindTruncated",
      Shrink::TRUNCATION_SUFFIX,
      '"__graphmind":"truncated"',
      '"__graphmind":"unserializable"',
      %("note":"#{MCP_PREVIEW_NOTE_PREFIX})
    ].map { |marker| marker.dup.force_encoding(Encoding::UTF_8).freeze }.freeze

    # `PYTHON_PREVIEW_MARKERS` in edit-input.ts, verbatim (`\A` / `\z` for its
    # `^` / `$`, which in Ruby would match at any line; ASCII digits only).
    E = Regexp.escape(ELLIPSIS)
    PYTHON_PREVIEW_MARKERS = [
      Regexp.new(%(#{E}\\[truncated\\]")),
      Regexp.new(%((?:\\A|[\\[:,])"<[0-9]+ bytes>"(?=[,\\]}]|\\z))),
      Regexp.new(%((?:\\A|[\\[:,])"#{E}\\[depth limit\\]"(?=[,\\]}]|\\z))),
      Regexp.new(%([{,]"#{E}":"\\[[0-9]+ more keys\\]"(?=[,}]))),
      Regexp.new(%((?:\\A|[\\[:,])"#{E}\\[[0-9]+ more\\]"(?=[,\\]}]|\\z)))
    ].freeze

    PLACEHOLDER_MESSAGE = 'the value contains redacted content ("__REDACTED__"); replace it before running'
    TRUNCATED_MESSAGE = "the value contains a truncated preview, not the full value; replace it before running"
    UNREADABLE_MESSAGE = "the value could not be read as JSON"

    module_function

    # How deep a value this guard serialises to check (json's default, 100,
    # refused values the TypeScript client and the Python SDK inject). Finite
    # on purpose: json's generator recurses on the machine stack, which on a
    # thread (the transport's, where this runs) runs out between 1,000 and
    # 2,000 levels, and running out is not always a catchable
    # SystemStackError. Deeper, or cyclic, is a `shape` refusal — answered,
    # never dropped.
    MAX_NESTING = 512

    # Refusal for a proposed inject output that must never run: `placeholder`,
    # `truncated`, or `shape` when it cannot be serialised to be checked
    # (nested past MAX_NESTING included). nil when it is clean. Never raises.
    def proposed_value_refusal(value)
      text = JSON.generate(value, max_nesting: MAX_NESTING)
      text = text.dup.force_encoding(Encoding::UTF_8) unless text.encoding == Encoding::UTF_8
      return Refusal.new("placeholder", PLACEHOLDER_MESSAGE) if text.include?(Redaction::REDACTED)
      if TRUNCATION_MARKERS.any? { |marker| text.include?(marker) } ||
         PYTHON_PREVIEW_MARKERS.any? { |pattern| pattern.match?(text) }
        return Refusal.new("truncated", TRUNCATED_MESSAGE)
      end

      nil
    rescue StandardError, SystemStackError
      Refusal.new("shape", UNREADABLE_MESSAGE)
    end
  end
end
