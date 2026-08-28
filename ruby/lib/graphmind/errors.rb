# frozen_string_literal: true

module Graphmind
  # Raised into the host **only** when the debugger explicitly aborts a run.
  # Everything else in this gem degrades to a no-op.
  class AbortError < StandardError
    def initialize(message = "Run aborted by the GraphMind debugger")
      super
    end
  end

  module Errors
    MAX_STACK_FRAMES = 40

    module_function

    def abort_error?(error)
      return false if error.nil?
      return true if error.is_a?(Graphmind::AbortError)

      name = error.class.name.to_s
      name.end_with?("AbortError") || name.end_with?("Abort")
    end

    # Serialize an exception into the wire contract's ErrorInfo shape.
    def to_error_info(error)
      return { "name" => "Error", "message" => error.to_s } unless error.is_a?(Exception)

      info = {
        "name" => error.class.name.to_s,
        "message" => error.message.to_s
      }
      backtrace = error.backtrace
      if backtrace.is_a?(Array) && !backtrace.empty?
        info["stack"] = ([error.message.to_s] + backtrace.first(MAX_STACK_FRAMES)).join("\n")
      end
      info
    end
  end
end
