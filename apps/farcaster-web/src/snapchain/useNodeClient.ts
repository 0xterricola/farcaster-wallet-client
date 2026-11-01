/**
 * React hooks for Snapchain node interaction.
 *
 * Provides:
 * - useNodeClient: memoized client instance
 * - useNodeHealth: health check with refresh capability
 * - useAppKey: reading/writing the app key per FID
 */

import { type NodeHealth, SnapchainNodeClient } from 'farcaster-node-client';
import React, { useCallback, useMemo, useState } from 'react';

import { resolveBaseUrlForChoice } from './nodeChoice';
import { useActiveNodeChoice } from './useNodeChoice';

/**
 * Memoized SnapchainNodeClient instance.
 *
 * The address is resolved through the reader's chosen server (public, or the
 * one they run) and re-resolved when that choice changes, so switching it on
 * the Advanced screen takes effect without a reload — and every surface that
 * writes through this client follows the same server the reader picked.
 */
export const useNodeClient = (): SnapchainNodeClient | undefined => {
  const choice = useActiveNodeChoice();
  // The reader's choice is what the address is resolved from, so it is a real
  // dependency of this memo — the one input that can change under a running tab.
  const baseUrl = useMemo(() => resolveBaseUrlForChoice(choice), [choice]);
  return useMemo(() => new SnapchainNodeClient({ baseUrl }), [baseUrl]);
};

/**
 * Node health state and refresh capability.
 */
export interface NodeHealthState {
  health: NodeHealth | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch and refresh node health.
 * Polls on mount and provides manual refresh.
 */
export const useNodeHealth = (
  node: SnapchainNodeClient | undefined,
): NodeHealthState => {
  const [health, setHealth] = useState<NodeHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!node) {
      setError('No node client configured');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const healthResult = await node.health();
      setHealth(healthResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // Keep the previous health state if we fail
      setLoading(false);
    }
  }, [node]);

  // Fetch on mount and when node changes
  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return { health, loading, error, refresh };
};
