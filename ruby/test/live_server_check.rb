#!/usr/bin/env ruby
# frozen_string_literal: true

# Cross-check against the REAL GraphMind server (Node, `ws`).
#
# The rest of the suite talks to a fake viewer built on this gem's own frame
# codec, which would pass even if the codec were symmetrically wrong. This
# script removes that doubt: it boots `graphmind serve` from the monorepo and
# drives it with the gem, proving the hand-rolled RFC 6455 client interoperates
# with a third-party server implementation.
#
# It also proves fail-open end to end: the server arms pause-on-error by
# default, so a raising tool genuinely HOLDS, and killing the server releases
# the hold.
#
#   ruby -Ilib -Itest test/live_server_check.rb
#
# Requires Node and a built packages/cli (`pnpm -C packages/cli build`). Not
# part of `rake test` — `rake live`.

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))

require "graphmind"
require "json"
require "net/http"
require "socket"
require "tmpdir"

REPO_ROOT = File.expand_path("../..", __dir__)
CLI = File.join(REPO_ROOT, "packages", "cli", "dist", "cli.js")

def fail!(message)
  warn "FAIL: #{message}"
  exit 1
end

def ok(message)
  puts "  ok  #{message}"
end

def free_port
  server = TCPServer.new("127.0.0.1", 0)
  port = server.addr[1]
  server.close
  port
end

def wait_for_http(port, timeout: 30)
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
  loop do
    begin
      response = Net::HTTP.get_response(URI("http://127.0.0.1:#{port}/api/runs"))
      return true if response.code.to_i < 500
    rescue StandardError
      nil
    end
    return false if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

    sleep 0.1
  end
end

def runs(port)
  JSON.parse(Net::HTTP.get(URI("http://127.0.0.1:#{port}/api/runs")))["runs"]
rescue StandardError
  []
end

fail!("built CLI not found at #{CLI} — run `pnpm -C packages/cli build`") unless File.exist?(CLI)

port = free_port
db = File.join(Dir.mktmpdir("graphmind-ruby-live"), "live.db")
puts "starting `graphmind serve` on 127.0.0.1:#{port}"
pid = Process.spawn(
  "node", CLI, "serve", "--port", port.to_s, "--no-open", "--db", db,
  out: File::NULL, err: File::NULL
)

begin
  fail!("the server never answered on port #{port}") unless wait_for_http(port)
  ok "server is up"

  session = Graphmind::Session.new(
    url: "ws://127.0.0.1:#{port}/ingest",
    app_name: "ruby-live-check",
    enabled: true,
    env: {},
    retry_interval: 1.0,
    connect_timeout: 2.0,
    handshake_timeout: 3.0
  )

  fail!("handshake with the real server did not complete") unless session.ready(10.0)
  ok "handshake completed against Node `ws` (masked client frames accepted)"

  boom = Graphmind::Wrap.gate_callable(-> { raise IOError, "the tool exploded" },
                                       -> { session }, name: "explode")

  outcome = Queue.new
  worker = Thread.new do
    session.run("live-check") do
      boom.call
    rescue IOError => e
      outcome << e
    end
  end

  # The server arms `{point: "error"}` by default (decisions.md #8), so the
  # raising tool must be held with nobody to resume it.
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
  sleep 0.05 while session.stats.held_gates.zero? &&
                   Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
  fail!("the real server's pause-on-error breakpoint did not hold the tool") if
    session.stats.held_gates.zero?
  ok "held at the error gate armed by the real server"

  fail!("execution continued while the gate was held") unless outcome.empty?
  ok "execution is genuinely stopped (the caller has not returned)"

  stored = runs(port)
  fail!("the server stored no runs (events did not arrive)") if stored.empty?
  ok "the server ingested and stored the run (#{stored.length} run(s))"

  # FAIL-OPEN: kill the debugger mid-hold; every gate must release.
  Process.kill("KILL", pid)
  Process.wait(pid)
  pid = nil

  released = nil
  released = outcome.pop(true) rescue nil while released.nil? &&
                                                Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline + 15
  worker.join(15)
  fail!("the gate was not released when the debugger died") if released.nil?
  fail!("expected the original IOError, got #{released.class}") unless released.is_a?(IOError)
  ok "fail-open: killing the server released the hold and the original error surfaced"

  session.dispose
  puts "\nALL LIVE CHECKS PASSED"
ensure
  if pid
    begin
      Process.kill("KILL", pid)
      Process.wait(pid)
    rescue StandardError
      nil
    end
  end
end
