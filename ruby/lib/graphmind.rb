# frozen_string_literal: true

# GraphMind — a live debugger for AI agents.
#
# Phoenix and Langfuse show you what your agent *did*. GraphMind attaches while
# it is happening: an instrumented app streams execution events to a local
# viewer, which renders the run as a live graph and can HOLD execution —
# before an LLM step, before/after a tool call, or on error — then resume with
# continue / retry / inject / abort.
#
# Quickstart:
#
#   require "graphmind"
#
#   gm = Graphmind.configure(app: "support-agent")
#   client = gm.instrument_openai(OpenAI::Client.new(access_token: ENV["OPENAI_API_KEY"]))
#
#   search = gm.tool("search_flights") { |origin:, destination:| Flights.search(origin, destination) }
#
#   gm.run("handle-ticket") do
#     client.chat(parameters: { model: "gpt-4o-mini", messages: [...] })
#   end
#
# Then run `npx graphmind-ai` and open http://127.0.0.1:4747. With nothing
# attached, all of the above is a no-op.
#
# Everything fails open: no debugger means near-zero overhead, and a debugger
# that disconnects mid-hold auto-continues every held gate.
module Graphmind
end

require_relative "graphmind/version"
require_relative "graphmind/errors"
require_relative "graphmind/env"
require_relative "graphmind/ids"
require_relative "graphmind/protocol"
require_relative "graphmind/safe"
require_relative "graphmind/ring_buffer"
require_relative "graphmind/gate_engine"
require_relative "graphmind/websocket"
require_relative "graphmind/transport"
require_relative "graphmind/token_batcher"
require_relative "graphmind/runtime"
require_relative "graphmind/session"
require_relative "graphmind/wrap"
require_relative "graphmind/api"

require_relative "graphmind/railtie" if defined?(::Rails::Railtie)
