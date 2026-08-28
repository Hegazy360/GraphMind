# frozen_string_literal: true

require "rails/railtie"
require "active_support/ordered_options"

module Graphmind
  # A deliberately small Railtie. It does three things a plain initializer
  # cannot do as well:
  #
  #  1. names the app after the Rails application, so the viewer shows
  #     "shopify-support" instead of "ruby";
  #  2. clears the thread's run context when Rails finishes a unit of work.
  #     Puma reuses threads, so a run left behind by a request that died
  #     mid-flight would otherwise adopt the *next* request's events;
  #  3. releases held gates and closes the socket on shutdown.
  #
  # Configure it from `config/application.rb` or an initializer:
  #
  #   config.graphmind.enabled = Rails.env.development?
  #   config.graphmind.app     = "support-agent"
  #   config.graphmind.url     = "ws://127.0.0.1:4747/ingest"
  #
  # Every key is passed straight to Graphmind.configure. Setting
  # `config.graphmind.autoconfigure = false` leaves everything to you.
  class Railtie < ::Rails::Railtie
    config.graphmind = ActiveSupport::OrderedOptions.new if defined?(ActiveSupport::OrderedOptions)

    initializer "graphmind.configure" do |app|
      options = app.config.respond_to?(:graphmind) ? app.config.graphmind : nil
      next if options.nil?
      next if options[:autoconfigure] == false

      settings = options.to_h.reject { |key, _| key == :autoconfigure }
      settings[:app] ||= app.class.name.to_s.split("::").first.to_s.downcase
      next if Graphmind.configured?

      begin
        Graphmind.configure(**settings)
      rescue StandardError => e
        # A debugger must never take an application down at boot. A typo in
        # config.graphmind is a warning, not a failed deploy.
        warn "[graphmind] ignoring config.graphmind (#{e.class}: #{e.message}); " \
             "GraphMind will use its defaults"
        Graphmind.configure(app: settings[:app]) unless Graphmind.configured?
      end
    end

    initializer "graphmind.executor" do |app|
      # `to_complete` runs after every request, job or console block — the
      # right place to drop a thread-local that must not outlive it.
      app.executor.to_complete do
        Graphmind.clear_run_context if Graphmind.configured?
      rescue StandardError
        nil
      end
    end

    config.after_initialize do
      at_exit do
        Graphmind.dispose if Graphmind.configured?
      rescue StandardError
        nil
      end
    end
  end
end
