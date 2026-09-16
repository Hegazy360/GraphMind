# frozen_string_literal: true

module Graphmind
  # Duration clock.
  #
  # Every GraphMind duration (`durationMs`, `heldMs`) is measured on
  # `Process.clock_gettime(Process::CLOCK_MONOTONIC, :float_millisecond)` —
  # monotonic and sub-microsecond — never on `Time.now`, which steps under NTP
  # adjustment and reads a 80µs handler as `0ms`. Wall-clock fields on the wire
  # (envelope `ts`) stay integer epoch milliseconds; only elapsed-time
  # measurement lives here.
  #
  # Port of packages/client/src/clock.ts. The wire contract for a duration:
  #   * rounded to 0.01 ms (two decimals),
  #   * clamped to >= 0,
  #   * never NaN / infinite (those become 0.0).
  #
  # The clock is read through `Clock.now_ms` at call time so tests can
  # substitute it with `Clock.override=`.
  module Clock
    class << self
      # Installed by tests; nil means the real monotonic clock.
      attr_accessor :override

      # Milliseconds on the monotonic clock. Fractional; only differences mean anything.
      def now_ms
        o = @override
        return o.call.to_f if o

        Process.clock_gettime(Process::CLOCK_MONOTONIC, :float_millisecond)
      end

      # Coerce a raw millisecond measurement into the wire contract.
      def normalize_duration_ms(raw)
        return 0.0 unless raw.is_a?(Numeric)

        value = raw.to_f
        return 0.0 if value.nan? || value.infinite? || value <= 0.0

        value.round(2)
      end

      # Elapsed since a `now_ms` reading, normalised for the wire.
      def elapsed_ms(started_at, now = nil)
        normalize_duration_ms((now || now_ms) - started_at)
      end
    end
  end
end
