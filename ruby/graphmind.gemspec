# frozen_string_literal: true

require_relative "lib/graphmind/version"

Gem::Specification.new do |spec|
  spec.name = "graphmind"
  spec.version = Graphmind::VERSION
  spec.authors = ["GraphMind"]
  spec.license = "MIT"

  spec.summary = "Live debugger for AI agents — attach to a running Ruby agent, watch it as a graph, pause and inject at LLM and tool boundaries."
  spec.description = <<~TEXT
    GraphMind attaches to an agent while it is running. Your instrumented app
    streams execution events to a local viewer, which renders the run as a live
    graph and can hold execution — before an LLM step, before/after a tool call,
    or on error — then resume with continue / retry / inject / abort.

    Local-first (127.0.0.1), zero runtime dependencies, fails open: with no
    debugger attached everything is a no-op, and a debugger that disconnects
    mid-hold releases every gate.
  TEXT

  spec.homepage = "https://graphmind.ai"
  spec.metadata = {
    "homepage_uri" => spec.homepage,
    "source_code_uri" => "https://github.com/Hegazy360/GraphMind",
    "bug_tracker_uri" => "https://github.com/Hegazy360/GraphMind/issues",
    "changelog_uri" => "https://github.com/Hegazy360/GraphMind/blob/master/CHANGELOG.md",
    "documentation_uri" => "https://github.com/Hegazy360/GraphMind/blob/master/ruby/README.md",
    "rubygems_mfa_required" => "true"
  }

  # Verified on Ruby 3.3.12 (see README "Verified on"). The floor is 3.1
  # because that is the oldest release whose syntax and stdlib this gem uses
  # (endless methods, argument forwarding, io/wait); 3.1 and 3.2 were not
  # exercised on the machine this gem was built on.
  spec.required_ruby_version = ">= 3.1.0"

  spec.files = Dir[
    "lib/**/*.rb",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ]
  spec.require_paths = ["lib"]

  # No runtime dependencies. A debugger you add to someone else's Gemfile must
  # not force a resolution on faraday, websocket-driver or eventmachine — the
  # RFC 6455 client is hand-rolled over stdlib sockets (lib/graphmind/websocket.rb).
end
