# frozen_string_literal: true

module Graphmind
  # Process-wide shutdown plumbing.
  #
  # A gate held on the main thread would otherwise block interpreter exit
  # forever, so every live session registers a fail-open hook here and a single
  # at_exit handler releases them all. One handler, not one per session, so a
  # test suite that builds hundreds of sessions does not build hundreds of
  # at_exit callbacks.
  module Runtime
    @mutex = Mutex.new
    @hooks = []
    @installed = false

    class << self
      def register(hook)
        @mutex.synchronize do
          @hooks << hook
          install!
        end
        nil
      end

      def unregister(hook)
        @mutex.synchronize { @hooks.delete(hook) }
        nil
      end

      def fail_open_all
        hooks = @mutex.synchronize { @hooks.dup }
        hooks.each do |hook|
          hook.call
        rescue StandardError
          nil
        end
        nil
      end

      private

      def install!
        return if @installed

        @installed = true
        at_exit { Graphmind::Runtime.fail_open_all }
      end
    end
  end
end
