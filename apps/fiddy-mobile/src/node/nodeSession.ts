/**
 * The Fiddy node session: one client, one health poll, shared by every tab.
 *
 * All reads go through `farcaster-node-client`, the same package the web client
 * and the CLI use — so "reads your node" is one implementation, not three.
 */

import {
  fetchFollowingFeed,
  SnapchainNodeClient,
  type NodeHealth,
  type NodeMessage,
} from 'farcaster-node-client';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  hostOf,
  resolveBuildFid,
  resolveBuildNode,
  type NodeSource,
} from './nodeConfig';

export type NodeHealthStatus = 'checking' | 'ok' | 'down';

export interface NodeSession {
  client: SnapchainNodeClient;
  url: string;
  source: NodeSource;
  host: string;
  /** True only for the URL this build was compiled with. */
  isBuildNode: boolean;
  status: NodeHealthStatus;
  health: NodeHealth | null;
  /** Re-run the health probe now (used by pull-to-refresh too). */
  refreshHealth: () => Promise<void>;
  /** Point this session at another node (not persisted; v1 keeps no storage). */
  useSessionNode: (url: string) => void;
  /** Drop a session override and go back to the build node. */
  resetNode: () => void;
  fid: number;
  setFid: (fid: number) => void;
  /** Bumped whenever the node or fid changes so feeds know to refetch. */
  epoch: number;
}

export const NodeContext = createContext<NodeSession | null>(null);

const HEALTH_POLL_MS = 30_000;

export const useNodeSession = (): NodeSession => {
  const session = useContext(NodeContext);
  if (!session) {
    throw new Error('useNodeSession must be used inside <NodeProvider>');
  }
  return session;
};

/** The state <NodeProvider> owns, so the provider component stays trivial. */
export const useNodeSessionState = (): NodeSession => {
  const buildNode = useMemo(resolveBuildNode, []);
  const [sessionUrl, setSessionUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<NodeHealthStatus>('checking');
  const [health, setHealth] = useState<NodeHealth | null>(null);
  const [fid, setFid] = useState<number>(resolveBuildFid);
  const [epoch, setEpoch] = useState(0);
  const mounted = useRef(true);

  const url = sessionUrl ?? buildNode.url;
  const source: NodeSource = sessionUrl ? 'session' : buildNode.source;

  const client = useMemo(
    () =>
      new SnapchainNodeClient({
        baseUrl: url,
        timeoutMs: 15_000,
        // `/v1/info` can take a moment on a node that is mid-sync; the client's
        // own default is 20s, health probes cap it at 6s internally.
      }),
    [url],
  );

  const refreshHealth = useMemo(
    () => async () => {
      if (mounted.current) {
        setStatus((current) => (current === 'ok' ? current : 'checking'));
      }
      const next = await client.health();
      if (!mounted.current) {
        return;
      }
      setHealth(next);
      setStatus(next.ok ? 'ok' : 'down');
    },
    [client],
  );

  useEffect(() => {
    mounted.current = true;
    setStatus('checking');
    setHealth(null);
    void refreshHealth();
    const timer = setInterval(() => {
      void refreshHealth();
    }, HEALTH_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refreshHealth]);

  return {
    client,
    url,
    source,
    host: hostOf(url),
    isBuildNode: !sessionUrl,
    status,
    health,
    refreshHealth,
    useSessionNode: (next: string) => {
      setSessionUrl(next);
      setEpoch((value) => value + 1);
    },
    resetNode: () => {
      setSessionUrl(null);
      setEpoch((value) => value + 1);
    },
    fid,
    setFid: (next: number) => {
      setFid(next);
      setEpoch((value) => value + 1);
    },
    epoch,
  };
};

// --- feed -------------------------------------------------------------------

export interface HomeFeedState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  casts: NodeMessage[];
  following: number[];
  error: string | null;
}

const NO_FID: HomeFeedState = {
  status: 'idle',
  casts: [],
  following: [],
  error: null,
};

/**
 * A home feed assembled locally from *your* node: your follow graph, their
 * casts, merged on the Farcaster timestamp. There is no indexer in the loop,
 * which is also why there is a visible "reading N follows" step.
 */
export const useHomeFeed = (
  session: NodeSession,
  options: { limit?: number; followingLimit?: number } = {},
): HomeFeedState & { reload: () => void } => {
  const { limit = 60, followingLimit = 120 } = options;
  const { client, fid, epoch } = session;
  const [state, setState] = useState<HomeFeedState>(NO_FID);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!fid) {
      setState(NO_FID);
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, status: 'loading', error: null }));
    void (async () => {
      try {
        const casts = await fetchFollowingFeed({
          node: client,
          fid,
          limit,
          followingLimit,
          castsPerAccount: 8,
          concurrency: 6,
          includeSelf: true,
          onFollowing: (following) => {
            if (!cancelled) {
              setState((current) => ({ ...current, following }));
            }
          },
        });
        if (!cancelled) {
          setState({ status: 'ready', casts, following: [], error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            casts: [],
            following: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, fid, epoch, limit, followingLimit, nonce]);

  return { ...state, reload: () => setNonce((value) => value + 1) };
};