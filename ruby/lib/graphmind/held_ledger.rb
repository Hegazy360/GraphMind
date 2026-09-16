# frozen_string_literal: true

require_relative "clock"

module Graphmind
  # Held-time ledger: how much of a node instance's wall-clock duration was the
  # *debugger* holding it, rather than the node running.
  #
  # Port of packages/client/src/held-ledger.ts — read that file's header for
  # the full rationale. In short: `durationMs` keeps its meaning (wall clock,
  # held time INCLUDED, so stored runs and importers are unaffected) and the
  # loose field `heldMs` on `node.finished` / `node.error` is the debugger's
  # share; "ran" is `durationMs - heldMs`.
  #
  # Attribution pins a hold to one of the node's open instances when it opens:
  #   * `before` / `error` gates -> the most recently started open instance
  #     (for `error`, an instance `node.error` named is preferred);
  #   * `after` gates -> the oldest open instance;
  #   * no open instance -> not attributed (a hold that opens after an instance
  #     finished is not inside that instance's `durationMs`).
  # The hold is also pinned to every open *ancestor* instance (following the
  # `parentId` from `node.started`) and to the run's root instance — the node
  # whose `instanceId` is the `runId`, which is how every SDK emits the
  # `agent:<run>` node. Each instance accumulates the UNION of the intervals
  # during which at least one hold pinned to it was open, so two children held
  # at the same time do not count twice in their parent.
  #
  # Exact whenever executions of one logical node do not overlap; a documented
  # heuristic for overlapping instances of the same node.
  #
  # Thread-safe (one mutex, never held while calling out), bounded, never raises.
  class HeldLedger
    DEFAULT_MAX_TRACKED_INSTANCES = 10_000
    MAX_DEPTH = 64

    Instance = Struct.new(:key, :node_key, :instance_id, :held_ms, :open_holds, :held_since, :errored)

    def initialize(max_instances: DEFAULT_MAX_TRACKED_INSTANCES, clock: nil)
      @max = [1, max_instances.to_i].max
      @clock = clock || -> { Clock.now_ms }
      @mutex = Mutex.new
      @instances = {}      # key -> Instance, insertion-ordered (oldest first)
      @by_node = {}        # [run_id, node_id] -> [Instance] in start order
      @parent_by_node = {} # [run_id, node_id] -> parent node_id
      @root_by_run = {}    # run_id -> Instance whose instance_id == run_id
      @holds = {}          # pause_id -> [Instance] (target first, then ancestors)
    end

    # -- instance lifecycle --------------------------------------------------

    def started(run_id, node_id, instance_id, parent_id = nil)
      node_key = [run_id, node_id]
      key = [run_id, node_id, instance_id]
      @mutex.synchronize do
        existing = @instances[key]
        remove(existing) if existing
        remove(@instances.values.first) if @instances.size >= @max
        @parent_by_node.clear if @parent_by_node.size >= @max * 4
        @parent_by_node[node_key] = parent_id if parent_id.is_a?(String) && parent_id != node_id
        instance = Instance.new(key, node_key, instance_id, 0.0, 0, 0.0, false)
        @instances[key] = instance
        @root_by_run[run_id] = instance if instance_id == run_id
        (@by_node[node_key] ||= []) << instance
      end
      nil
    end

    def errored(run_id, node_id, instance_id)
      @mutex.synchronize do
        instance = pick(run_id, node_id, instance_id)
        instance.errored = true if instance
      end
      nil
    end

    # Held so far for an open instance (a hold open right now included); nil when unknown.
    def peek(run_id, node_id, instance_id)
      now = @clock.call
      @mutex.synchronize do
        instance = pick(run_id, node_id, instance_id)
        instance && total(instance, now)
      end
    end

    # Close the instance and return its held total; nil when unknown. A hold
    # still open against it is credited up to now (that time IS inside the
    # `durationMs` just measured) and unpinned from it.
    def finished(run_id, node_id, instance_id)
      now = @clock.call
      @mutex.synchronize do
        instance = pick(run_id, node_id, instance_id)
        return nil unless instance

        held = total(instance, now)
        remove(instance)
        held
      end
    end

    # -- holds ---------------------------------------------------------------

    def hold_opened(pause_id, run_id, node_id, point)
      now = @clock.call
      @mutex.synchronize do
        instances = @by_node[[run_id, node_id]]
        target = nil
        if instances && !instances.empty?
          if point == "after"
            target = instances.first
          else
            target = instances.reverse.find(&:errored) if point == "error"
            target ||= instances.last
            target.errored = false if point == "error" # one hold per failure
          end
        end
        # No open instance of the held node (a callback-style after/error gate
        # fires AFTER node.finished): the hold is outside every instance of this
        # node's durationMs and must not be charged to the next one — but the
        # open ancestors and the run root are still running while the developer
        # looks, and it IS inside theirs.
        pinned = target ? [target] : []
        # Ancestors: the newest open instance of each parent up the chain.
        current = [run_id, node_id]
        seen = { current => true }
        MAX_DEPTH.times do
          parent_id = @parent_by_node[current]
          break if parent_id.nil?

          parent_key = [run_id, parent_id]
          break if seen[parent_key]

          seen[parent_key] = true
          parents = @by_node[parent_key]
          pinned << parents.last if parents && !parents.empty?
          current = parent_key
        end
        root = @root_by_run[run_id]
        pinned << root if root && pinned.none? { |i| i.equal?(root) }
        return nil if pinned.empty?

        pinned.each do |instance|
          instance.held_since = now if instance.open_holds.zero?
          instance.open_holds += 1
        end
        @holds[pause_id] = pinned
      end
      nil
    end

    def hold_closed(pause_id)
      now = @clock.call
      @mutex.synchronize do
        pinned = @holds.delete(pause_id)
        pinned&.each { |instance| release(instance, now) }
      end
      nil
    end

    # -- diagnostics ---------------------------------------------------------

    def tracked_instances = @mutex.synchronize { @instances.size }
    def open_holds = @mutex.synchronize { @holds.size }

    private

    # Call with the mutex held.

    def total(instance, now)
      open_ms = instance.open_holds.positive? ? [0.0, now - instance.held_since].max : 0.0
      Clock.normalize_duration_ms(instance.held_ms + open_ms)
    end

    def release(instance, now)
      return if instance.open_holds.zero?

      instance.open_holds -= 1
      instance.held_ms += [0.0, now - instance.held_since].max if instance.open_holds.zero?
    end

    # Exact instance when named; otherwise the newest open one for the node.
    def pick(run_id, node_id, instance_id)
      instances = @by_node[[run_id, node_id]]
      return nil if instances.nil? || instances.empty?
      # An unknown instanceId is not "the newest one".
      return @instances[[run_id, node_id, instance_id]] unless instance_id.nil?

      instances.last
    end

    def remove(instance)
      @instances.delete(instance.key)
      run_id = instance.node_key[0]
      @root_by_run.delete(run_id) if @root_by_run[run_id].equal?(instance)
      siblings = @by_node[instance.node_key]
      if siblings
        siblings.delete_if { |i| i.equal?(instance) }
        @by_node.delete(instance.node_key) if siblings.empty?
      end
      return unless instance.open_holds.positive?

      @holds.each_key.to_a.each do |pause_id|
        pinned = @holds[pause_id]
        pinned.delete_if { |i| i.equal?(instance) }
        @holds.delete(pause_id) if pinned.empty?
      end
      instance.open_holds = 0
    end
  end
end
