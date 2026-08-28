# frozen_string_literal: true

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))

require "minitest/autorun"
require "json"
require "graphmind"
require_relative "support/fake_viewer"

module GraphmindTest
  REPO_ROOT = File.expand_path("../..", __dir__)
  SCHEMA_PATH = File.join(REPO_ROOT, "packages", "schema", "schema.json")

  # Validate envelopes against the published wire contract when json_schemer is
  # available. It is a dev-only dependency, so the suite degrades to structural
  # checks rather than refusing to run.
  module Schema
    @checked = false
    @validator = nil

    class << self
      def available?
        load!
        !@validator.nil?
      end

      def validator
        load!
        @validator
      end

      def why_unavailable
        load!
        @reason
      end

      private

      def load!
        return if @checked

        @checked = true
        unless File.exist?(SCHEMA_PATH)
          @reason = "packages/schema/schema.json not found (partial checkout?)"
          return
        end
        begin
          require "json_schemer"
        rescue LoadError => e
          @reason = "json_schemer is not installed (#{e.message})"
          return
        end
        @validator = JSONSchemer.schema(JSON.parse(File.read(SCHEMA_PATH)))
      rescue StandardError => e
        @reason = "could not build the validator (#{e.class}: #{e.message})"
        @validator = nil
      end
    end
  end
end

module GraphmindTestHelpers
  def setup
    @viewers = []
    @sessions = []
    super
  end

  def teardown
    @sessions.each do |session|
      session.dispose
    rescue StandardError
      nil
    end
    @viewers.each do |viewer|
      viewer.close
    rescue StandardError
      nil
    end
    Graphmind.reset
    super
  end

  def new_viewer(**options)
    viewer = FakeViewer.new(**options)
    @viewers << viewer
    viewer
  end

  # An isolated session. `env: {}` keeps the developer's real environment (and
  # any GRAPHMIND_* kill switch) out of the test.
  def new_session(url: nil, **options)
    options = {
      enabled: true,
      env: {},
      logger: ->(message) { (@warnings ||= []) << message },
      retry_interval: 60.0,
      connect_timeout: 2.0,
      handshake_timeout: 2.0
    }.merge(options)
    session = Graphmind::Session.new(url: url, **options)
    @sessions << session
    session
  end

  # A session already attached to a fresh fake viewer.
  def attached_session(viewer_options: {}, **session_options)
    viewer = new_viewer(**viewer_options)
    session = new_session(url: viewer.url, **session_options)
    assert session.ready(5.0), "handshake did not complete"
    [session, viewer]
  end

  def warnings = (@warnings ||= [])

  def wait_until(timeout: 5.0, label: "condition")
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      flunk("timed out waiting for #{label}") if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.005
    end
    true
  end

  def now_ms = Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000.0

  def assert_valid_frame(frame)
    return skip("schema validation unavailable: #{GraphmindTest::Schema.why_unavailable}") unless
      GraphmindTest::Schema.available?

    errors = GraphmindTest::Schema.validator.validate(frame).to_a
    return if errors.empty?

    detail = errors.first(3).map { |e| "#{e['data_pointer']}: #{e['type']}" }.join("; ")
    flunk("frame #{frame['type'].inspect} violates schema.json — #{detail}")
  end
end

class Minitest::Test
  include GraphmindTestHelpers
end
