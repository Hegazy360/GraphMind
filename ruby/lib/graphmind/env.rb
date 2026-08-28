# frozen_string_literal: true

module Graphmind
  # Kill switches and environment-derived defaults.
  #
  # Precedence for "is GraphMind enabled" (mirrors packages/client/src/env.ts,
  # with a Ruby-flavoured production check because there is no NODE_ENV):
  #
  #   1. GRAPHMIND_DISABLED=1   -> disabled, always. Ops-level kill switch; it
  #      beats an explicit `enabled: true` passed in code.
  #   2. explicit `enabled:`    -> as given.
  #   3. looks like production  -> disabled unless GRAPHMIND=1.
  #   4. otherwise              -> enabled.
  #
  # "Looks like production" is deliberately a boring, documented rule: the
  # first variable that is *set* out of ENV_VARS decides, and it counts as
  # production when its value is production/prod (case-insensitive). No
  # heuristics over hostnames, cloud metadata or TTYs — a debugger that
  # silently turns itself off for surprising reasons is worse than one you
  # have to switch on.
  module Env
    DEFAULT_URL = "ws://127.0.0.1:4747/ingest"

    # Checked in order; the first one that is set decides the environment.
    ENV_VARS = %w[
      GRAPHMIND_ENV
      ENVIRONMENT
      APP_ENV
      RAILS_ENV
      RACK_ENV
      ENV
      NODE_ENV
    ].freeze

    PRODUCTION_VALUES = %w[production prod].freeze

    module_function

    def source(env)
      env.nil? ? ENV : env
    end

    # True when the first *set* variable in ENV_VARS names a production env.
    def production?(env = nil)
      src = source(env)
      ENV_VARS.each do |key|
        value = src[key]
        next if value.nil? || value.to_s.empty?

        return PRODUCTION_VALUES.include?(value.to_s.strip.downcase)
      end
      false
    end

    def resolve_enabled(explicit = nil, env = nil)
      src = source(env)
      return false if src["GRAPHMIND_DISABLED"] == "1"
      return explicit unless explicit.nil?

      !(production?(src) && src["GRAPHMIND"] != "1")
    end

    def resolve_url(explicit = nil, env = nil)
      return explicit unless explicit.nil?

      value = source(env)["GRAPHMIND_URL"]
      value.nil? || value.empty? ? DEFAULT_URL : value
    end
  end
end
