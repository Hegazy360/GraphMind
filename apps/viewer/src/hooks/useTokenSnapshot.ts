import { useCallback, useSyncExternalStore } from 'react';
import { tokenBuffers, type TokenSnapshot } from '../store/tokenBuffers.js';

/**
 * Subscribe one component to a node's streamed-token buffer. Updates arrive
 * on the registry's coalesced flush cadence (~75ms), never per delta.
 */
export function useTokenSnapshot(runId: string, nodeId: string): TokenSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) => tokenBuffers.subscribe(runId, nodeId, onChange),
    [runId, nodeId],
  );
  return useSyncExternalStore(subscribe, () => tokenBuffers.getSnapshot(runId, nodeId));
}
