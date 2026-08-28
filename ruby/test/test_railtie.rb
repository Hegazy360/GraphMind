# frozen_string_literal: true

require_relative "test_helper"

begin
  require "rails"
  require "graphmind/railtie"
  RAILS_AVAILABLE = true
rescue LoadError
  RAILS_AVAILABLE = false
end

# The Railtie, exercised by booting a real (tiny) Rails application.
class TestRailtie < Minitest::Test
  SETTINGS = {
    enabled: true,
    url: "ws://127.0.0.1:1/ingest",
    env: {},
    logger: ->(_message) {}
  }.freeze

  class << self
    # Boot once for the whole class: a Rails process can only have one
    # application, and `initialize!` is not repeatable.
    def boot!
      return @boot_result if defined?(@boot_result)

      @boot_result =
        if Rails.application
          :foreign
        else
          build_app
          { app_name: Graphmind.instance.session.app_name, url: Graphmind.session.url,
            configured: Graphmind.configured? }
        end
    end

    private

    def build_app
      require "tmpdir"
      klass = Class.new(Rails::Application) do
        def self.name = "GraphmindRailtieTestApp"
      end
      Object.const_set(:GraphmindRailtieTestApp, klass)

      klass.config.root = Dir.mktmpdir("graphmind-railtie")
      klass.config.eager_load = false
      klass.config.logger = Logger.new(IO::NULL)
      klass.config.secret_key_base = "graphmind-test"
      SETTINGS.each { |key, value| klass.config.graphmind[key] = value }
      klass.initialize!
    end
  end

  def setup
    super
    skip("railties is not installed") unless RAILS_AVAILABLE

    @boot = self.class.boot!
    skip("another Rails application is already booted in this process") if @boot == :foreign
    # The shared teardown resets the default instance between tests; the
    # Railtie only configures at boot, so restore it for the executor tests.
    Graphmind.configure(app: @boot[:app_name], **SETTINGS) unless Graphmind.configured?
  end

  def test_the_railtie_configured_graphmind_at_boot
    assert @boot[:configured], "the Railtie should have configured GraphMind during initialize!"
    assert_equal "ws://127.0.0.1:1/ingest", @boot[:url], "config.graphmind.url should be honoured"
    assert_equal "graphmindrailtietestapp", @boot[:app_name],
                 "the app name should default to the Rails application"
  end

  def test_the_executor_clears_a_leaked_run_context
    session = Graphmind.session
    Thread.current[Graphmind::Session::RUN_KEY] = Graphmind::RunContext.new("run_leak", "leaked")
    assert_equal "leaked", session.current_run.name

    Rails.application.executor.wrap { :some_request }

    assert_nil session.current_run, "the executor must drop the run context after a unit of work"
  end

  def test_a_run_inside_the_executor_does_not_survive_it
    session = Graphmind.session
    Rails.application.executor.wrap do
      session.run("request") { assert_equal "request", session.current_run.name }
    end

    assert_nil session.current_run
  end

  def test_the_gem_still_works_normally_under_rails
    session = Graphmind.session
    tool = Graphmind.tool("lookup") { |id:| "record-#{id}" }

    result = Rails.application.executor.wrap do
      session.run("request") { tool.call(id: 3) }
    end

    assert_equal "record-3", result
  end
end
