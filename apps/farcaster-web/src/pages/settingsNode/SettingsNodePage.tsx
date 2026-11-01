/**
 * Your own setup — the Advanced screen.
 *
 * The positioning pivot demoted this surface on purpose: it still works, it is
 * still linked from the status pill and from Advanced in the nav, and it is
 * deliberately absent from onboarding. Everything on it is optional, and the
 * product works without it.
 *
 * The vocabulary here is the precise one (node, app key, scope, TTL) because
 * these are the names of the things you are configuring — but the screen says
 * "Advanced" out loud, and every entry point into it uses plain words.
 *
 * Provides:
 * - Node status (health check, version, shards)
 * - Letting Fiddy post for you: one tap in the reader's own Farcaster app
 *   (`PostingKeyCard` — no fee, no passphrase), which is the primary flow
 * - App key management (issue/revoke gasless keys), behind a collapsed
 *   disclosure because issuing one asks for the account's recovery phrase
 * - Cast composer using your own node
 * - Feed from your own node
 * - Client include/exclude filter
 */

import { useQueryClient } from '@tanstack/react-query';
import {
  type AppKey,
  appKeyFromPrivateKeyHex,
  buildCastAddMessage,
  buildLinkAddMessage,
  buildLinkRemoveMessage,
  buildReactionAddMessage,
  buildReactionRemoveMessage,
  bytesToHex,
  CastClientResolver,
  type ClientFilterMode,
  type ClientFilterPolicy,
  type ClientIdentity,
  createAppClientNameLookup,
  fetchCastsByFid,
  fetchFollowingFeed,
  fetchSignerState,
  filterCastsByClient,
  generateAppKey,
  issueAppKey,
  type IssueAppKeyStep,
  type NodeSigner,
  revokeAppKey,
} from 'farcaster-node-client';
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { mnemonicToAccount } from 'viem/accounts';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { SettingsPageContent } from '~/components/page/SettingsPageContent';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { SettingsNav } from '~/layouts/SettingsNav';
import {
  clearAppKey,
  loadAppKey,
  loadAppNonce,
  saveAppKey,
  saveAppNonce,
} from '~/snapchain/appKeyStorage';
import {
  applyClientFilterPolicy,
  applyClientLabels,
  loadActiveClientPreferences,
} from '~/snapchain/clientFilterPreferences';
import {
  networkName,
  networkOffers,
  type NetworkRoute,
  readNetwork,
} from '~/snapchain/networks';
import {
  chooseNode,
  type NodeChoice,
  resetNodeChoice,
  resolveEffectiveNodeBaseUrl,
} from '~/snapchain/nodeChoice';
import {
  type ClientLabels,
  toClientLabels,
  toKnownClients,
  withClientLabel,
} from '~/snapchain/nodePreferences';
import { THIS_CLIENT_APP_FID } from '~/snapchain/thisClientApp';
import { useNodeChoice } from '~/snapchain/useNodeChoice';
import { useNodeClient } from '~/snapchain/useNodeClient';
import { trackError } from '~/utils/errorUtils';

import { AppKeyCard } from './Component/AppKeyCard';
import { ClientFilterCard } from './Component/ClientFilterCard';
import { NetworkChoiceCard } from './Component/NetworkChoiceCard';
import { NodeChoiceCard } from './Component/NodeChoiceCard';
import { NodeComposer } from './Component/NodeComposer';
import { NodeFeed } from './Component/NodeFeed';
import { NodeStatusCard } from './Component/NodeStatusCard';
import { PostingKeyCard } from './Component/PostingKeyCard';
import { ProviderListCard } from './Component/ProviderListCard';
import { SeedPhraseWarningModal } from './Component/SeedPhraseWarningModal';

/**
 * `trackError` takes a single error, so a failed node call is wrapped to keep
 * both the operation that failed and the underlying reason in the dev log.
 */
const nodeError = (operation: string, error: unknown) =>
  new Error(
    `${operation}: ${error instanceof Error ? error.message : String(error)}`,
  );

const SettingsNodePage = memo(() => {
  const { fid } = useCurrentUser();
  const node = useNodeClient();
  // Saved preferences also have to reach pages that are already cached: a filter
  // that is stored but still served from a stale page reads as "the filter does
  // nothing", so every save drops the cached reads.
  const queryClient = useQueryClient();

  // The server this reader chose (a public one, or their own). Restoring it is
  // what points the rest of this page — and the pill, and the feed — at it, so
  // it happens before anything is read.
  const nodeChoice = useNodeChoice(fid ?? undefined);

  // Node health state
  const [nodeHealth, setNodeHealth] = useState<{
    ok: boolean;
    baseUrl: string;
    latencyMs: number;
    version?: string;
    numShards?: number;
    maxHeight?: number;
    error?: string;
  } | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  // App key state
  const [appKey, setAppKey] = useState<AppKey | null>(null);
  /**
   * The recovery-phrase path is collapsed by default — `open` is the reader's
   * own toggle, OR a live key: a key that exists must not be hidden, because
   * that is where it is revoked from.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /**
   * The one-tap approval has no service to talk to at this address when a person
   * serves the client from their own machine (`fiddy client up`) — and on that
   * box the app key below is the only thing that can post for them. So the
   * screen opens that disclosure once, in that case, rather than hiding the one
   * control that works. Once: after that the toggle is the reader's own, and
   * nothing re-opens it under their hand.
   */
  const openedAppKeyForUnreachable = useRef(false);
  const handleUseOwnAppKey = useCallback(() => setAdvancedOpen(true), []);
  const handlePostingKeyUnreachable = useCallback(() => {
    if (openedAppKeyForUnreachable.current) {
      return;
    }
    openedAppKeyForUnreachable.current = true;
    setAdvancedOpen(true);
  }, []);
  const [signerState, setSignerState] = useState<{
    hasKey: boolean;
    gaslessSignerCount: number;
    gaslessSignerLimit: number;
    currentUserNonce: number;
    signer?: NodeSigner;
  } | null>(null);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueStep, setIssueStep] = useState<IssueAppKeyStep | null>(null);
  /** Is there a key on this device, or one the node is holding for it? */
  const appKeyLive = appKey !== null || signerState?.signer !== undefined;

  // Seed phrase modal state
  const [showSeedPhraseModal, setShowSeedPhraseModal] = useState(false);

  // Feed state
  const [casts, setCasts] = useState<
    Array<{
      cast: {
        fid: number;
        hash: string;
        signer: string;
        timestamp: number;
        timestampMs: number;
        castAdd?: { text: string; embeds: unknown[] };
      };
      client?: ClientIdentity;
    }>
  >([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedEmpty, setFeedEmpty] = useState(false);

  // Client filter state
  const [filterPolicy, setFilterPolicy] = useState<ClientFilterPolicy>({
    mode: 'all',
    clientIds: [],
  });
  const [clientLabels, setClientLabels] = useState<ClientLabels>({});
  const [clientCounts, setClientCounts] = useState<
    Map<string, { label: string; count: number }>
  >(new Map());

  // Post state
  const [postSuccess, setPostSuccess] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  // React/follow state. These writes have no optimistic UI, so without a
  // message a rejected reaction would look like a no-op to the reader.
  const [actionError, setActionError] = useState<string | null>(null);

  // Load app key on mount
  useEffect(() => {
    if (!fid) {
      return;
    }
    loadAppKey(fid).then((keyHex) => {
      if (keyHex) {
        // The seed phrase is never stored; the app key is, and this is how it
        // comes back after a reload.
        appKeyFromPrivateKeyHex(keyHex).then(setAppKey);
      }
    });
  }, [fid]);

  // Restore the view-layer preferences (client filter + your client labels).
  // Read through the shared store (`clientFilterPreferences`) rather than
  // straight out of storage: the same values the feed filters by are the ones
  // this screen shows, so the two cannot disagree — and saving below updates
  // that store, which is what makes a change apply without a reload.
  useEffect(() => {
    if (!fid) {
      return;
    }
    loadActiveClientPreferences(fid)
      .then(({ policy, knownClients }) => {
        setFilterPolicy(policy);
        setClientLabels(toClientLabels(knownClients));
      })
      .catch(() => {
        // Unreadable storage must not stop the screen: no filter, no labels.
      });
  }, [fid]);

  // Fetch node health
  const refreshHealth = useCallback(async () => {
    if (!node) {
      setNodeHealth({
        ok: false,
        baseUrl: resolveEffectiveNodeBaseUrl(),
        latencyMs: 0,
        error: 'No node client configured',
      });
      setHealthLoading(false);
      return;
    }

    setHealthLoading(true);
    try {
      const health = await node.health();
      setNodeHealth({
        ok: health.ok,
        baseUrl: health.baseUrl,
        latencyMs: health.latencyMs,
        version: health.info?.version,
        numShards: health.info?.numShards,
        maxHeight: health.info?.shardInfos?.[0]?.maxHeight,
        error: health.error,
      });
    } catch (err) {
      setNodeHealth({
        ok: false,
        baseUrl: node.baseUrl,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    setHealthLoading(false);
  }, [node]);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  // Fetch signer state when we have an app key
  useEffect(() => {
    if (!node || !fid || !appKey) {
      return;
    }

    fetchSignerState({ node, fid, publicKeyHex: appKey.publicKeyHex }).then(
      (state) => {
        const hasKey = !!state.signer;
        setSignerState({
          hasKey,
          gaslessSignerCount: state.gaslessSignerCount,
          gaslessSignerLimit: state.gaslessSignerLimit,
          currentUserNonce: state.currentUserNonce,
          signer: state.signer,
        });
      },
    );
  }, [node, fid, appKey]);

  // Fetch feed
  const refreshFeed = useCallback(async () => {
    if (!node || !fid) {
      return;
    }

    setFeedLoading(true);
    setFeedEmpty(false);

    try {
      // First try the following feed
      const followingFeed = await fetchFollowingFeed({
        node,
        fid,
        limit: 25,
        includeSelf: true,
      });

      if (followingFeed.length === 0) {
        // Fall back to own casts
        const ownCasts = await fetchCastsByFid({ node, fid, limit: 25 });
        setCasts(
          ownCasts.map((cast) => ({
            cast: {
              fid: cast.fid,
              hash: cast.hash,
              signer: cast.signer,
              timestamp: cast.timestamp,
              timestampMs: cast.timestampMs,
              castAdd: cast.castAdd,
            },
          })),
        );
        setFeedEmpty(true);
      } else {
        // Resolve who made each cast: the app FID that requested the signing
        // key, then that app account's own name from the node. A label the
        // reader typed wins over the app's own profile.
        const resolver = new CastClientResolver({
          node,
          thisAppFid: THIS_CLIENT_APP_FID,
          knownClients: toKnownClients(clientLabels),
          names: createAppClientNameLookup({ node }),
        });

        const resolved = await resolver.resolveAll(
          followingFeed.map((c) => ({
            fid: c.fid,
            signer: c.signer,
          })),
        );

        const castsWithClients = followingFeed.map((cast) => ({
          cast: {
            fid: cast.fid,
            hash: cast.hash,
            signer: cast.signer,
            timestamp: cast.timestamp,
            timestampMs: cast.timestampMs,
            castAdd: cast.castAdd,
          },
          client: resolved.get(cast.signer.toLowerCase()),
        }));

        // Count clients for filter UI
        const counts = new Map<string, { label: string; count: number }>();
        castsWithClients.forEach(({ client }) => {
          if (client) {
            const existing = counts.get(client.id);
            if (existing) {
              existing.count++;
            } else {
              counts.set(client.id, { label: client.label, count: 1 });
            }
          }
        });
        setClientCounts(counts);

        // Apply filter
        if (filterPolicy.mode !== 'all' && filterPolicy.clientIds.length > 0) {
          const filtered = filterCastsByClient({
            messages: followingFeed,
            clients: resolved,
            policy: filterPolicy,
          });
          const filteredSet = new Set(
            filtered.map((f) => `${f.fid}:${f.hash}`),
          );
          setCasts(
            castsWithClients
              .filter((c) => filteredSet.has(`${c.cast.fid}:${c.cast.hash}`))
              .map((c) => ({
                cast: {
                  fid: c.cast.fid,
                  hash: c.cast.hash,
                  signer: c.cast.signer,
                  timestamp: c.cast.timestamp,
                  timestampMs: c.cast.timestampMs,
                  castAdd: c.cast.castAdd,
                },
                client: c.client,
              })),
          );
        } else {
          setCasts(castsWithClients);
        }
      }
    } catch (error) {
      // One unreachable read must not empty the page: surface it and stop.
      trackError(nodeError('Failed to load node feed', error));
    }

    setFeedLoading(false);
  }, [node, fid, filterPolicy, clientLabels]);

  useEffect(() => {
    refreshFeed();
  }, [refreshFeed]);

  // Handle issuing a new app key
  const handleIssueKey = useCallback(
    async (mnemonic: string) => {
      if (!node || !fid) {
        return;
      }

      setIssueLoading(true);
      setPostError(null);

      try {
        // Derive custody account from mnemonic
        const custodyAccount = mnemonicToAccount(mnemonic);

        // Generate a new app key
        const newKey = await generateAppKey();

        // Issue the key through the node
        // First get the current nonce so we can compute the next one
        const nodeSignerState = await fetchSignerState({ node, fid });
        const nextNonce = nodeSignerState.currentUserNonce + 1;

        const result = await issueAppKey({
          node,
          fid,
          appKey: newKey,
          custodyAccount,
          nonce: nextNonce,
          onStep: setIssueStep,
        });

        // Save the key - convert private key Uint8Array to hex
        const privateKeyHex = bytesToHex(newKey.privateKey);
        await saveAppKey(fid, privateKeyHex);
        await saveAppNonce(fid, result.userId.nonce + 1);

        setAppKey(newKey);
        setSignerState({
          hasKey: true,
          gaslessSignerCount: nodeSignerState?.gaslessSignerCount ?? 1,
          gaslessSignerLimit: nodeSignerState?.gaslessSignerLimit ?? 1000,
          currentUserNonce: result.userId.nonce,
          signer: result.signer,
        });

        setShowSeedPhraseModal(false);
      } catch (err) {
        setPostError(err instanceof Error ? err.message : String(err));
      }

      setIssueLoading(false);
      setIssueStep(null);
    },
    [node, fid],
  );

  // Handle revoking the app key
  const handleRevokeKey = useCallback(async () => {
    if (!node || !fid || !appKey) {
      return;
    }

    setIssueLoading(true);
    setPostError(null);

    try {
      const nonce = await loadAppNonce(fid);
      await revokeAppKey({
        node,
        fid,
        appKey,
        nonce,
      });

      await clearAppKey(fid);
      setAppKey(null);
      setSignerState(null);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : String(err));
    }

    setIssueLoading(false);
  }, [node, fid, appKey]);

  // Handle posting a cast
  const handlePostCast = useCallback(
    async (text: string) => {
      if (!node || !fid || !appKey) {
        return;
      }

      setPostError(null);
      setPostSuccess(null);

      try {
        const built = await buildCastAddMessage({
          fid,
          signerPrivateKey: appKey.privateKey,
          text,
        });

        const accepted = await node.submitMessage(built.bytes);
        const confirmed = await node.confirmMessage({
          fid,
          hash: accepted.hash,
        });

        if (confirmed) {
          setPostSuccess('Cast stored on the node');
          refreshFeed();
        } else {
          setPostSuccess('Accepted for relay (not yet stored)');
        }
      } catch (err) {
        const error = err as { nodeError?: string; nodeErrorDetail?: string };
        setPostError(
          error.nodeError ||
            error.nodeErrorDetail ||
            (err instanceof Error ? err.message : String(err)),
        );
      }
    },
    [node, fid, appKey, refreshFeed],
  );

  // Handle reaction
  const handleReaction = useCallback(
    async (
      castFid: number,
      castHash: string,
      reactionType: 'like' | 'recast',
      remove: boolean,
    ) => {
      if (!node || !fid || !appKey) {
        return;
      }

      try {
        const built = remove
          ? await buildReactionRemoveMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              reactionType,
              targetCastId: { fid: castFid, hash: castHash },
            })
          : await buildReactionAddMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              reactionType,
              targetCastId: { fid: castFid, hash: castHash },
            });

        await node.submitMessage(built.bytes);
        setActionError(null);
        refreshFeed();
      } catch (error) {
        const message = nodeError('Failed to react through the node', error);
        trackError(message);
        setActionError(message.message);
      }
    },
    [node, fid, appKey, refreshFeed],
  );

  // Handle follow
  const handleFollow = useCallback(
    async (targetFid: number, remove: boolean) => {
      if (!node || !fid || !appKey) {
        return;
      }

      try {
        const built = remove
          ? await buildLinkRemoveMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              targetFid,
            })
          : await buildLinkAddMessage({
              fid,
              signerPrivateKey: appKey.privateKey,
              targetFid,
            });

        await node.submitMessage(built.bytes);
        setActionError(null);
        refreshFeed();
      } catch (error) {
        const message = nodeError('Failed to follow through the node', error);
        trackError(message);
        setActionError(message.message);
      }
    },
    [node, fid, appKey, refreshFeed],
  );

  // Handle filter change. The policy is view-layer preference, so it is stored
  // per FID and reapplied on reload; saving through the shared store is also
  // what puts it in force for the next feed read (the read seam asks that store
  // on every request), and the page cache is dropped so the change is visible
  // on the next page rather than after a stale copy expires.
  const handleFilterChange = useCallback(
    (mode: ClientFilterMode, clientIds: string[]) => {
      const next: ClientFilterPolicy = { mode, clientIds };
      setFilterPolicy(next);
      if (fid) {
        applyClientFilterPolicy(fid, next)
          .then(() => queryClient.invalidateQueries())
          .catch(() => {
            // Storage failing must not block filtering for this session: the
            // in-memory policy above still applies to this screen's feed.
          });
      }
    },
    [fid, queryClient],
  );

  // Choosing a server is a preference like the filter: stored per FID, and
  // applied to the running session at once. The health check below re-runs by
  // itself, because the client it uses is rebuilt from the new choice.
  const handleChooseNode = useCallback(
    (choice: NodeChoice) => (fid ? chooseNode(fid, choice) : Promise.resolve()),
    [fid],
  );

  const handleResetNode = useCallback(
    () => (fid ? resetNodeChoice(fid) : Promise.resolve()),
    [fid],
  );

  // Which NETWORK this client is reading — a different question from which
  // Which NETWORK this client is reading — a different question from which
  // server, and one the client must answer from provenance, never by guessing
  // (a node carries no network name in /v1/info; see ~/snapchain/networks).
  const networkReading = useMemo(
    () =>
      readNetwork({
        choiceUrl: nodeChoice?.url ?? null,
        choiceKind: nodeChoice?.kind ?? null,
      }),
    [nodeChoice],
  );

  // And both networks with the address each would be read from here, so the
  // chooser offers only what this client can actually read.
  const networkChoices = useMemo(
    () => networkOffers({ choiceUrl: nodeChoice?.url ?? null }),
    [nodeChoice],
  );

  // Picking a network is picking its server: the same stored choice the card
  // above writes, which is what makes the switch real rather than a label.
  const handleChooseNetwork = useCallback(
    (route: NetworkRoute) =>
      fid
        ? chooseNode(fid, { kind: route.kind, url: route.url })
        : Promise.resolve(),
    [fid],
  );

  // Name (or un-name) another client. A label the reader types wins over what
  // the app calls itself, and saving it through the store is what makes every
  // cast from that app read the new name on the next page.
  const handleLabelClient = useCallback(
    (clientId: string, label: string) => {
      setClientLabels((current) => {
        const next = withClientLabel(current, clientId, label);
        if (fid) {
          applyClientLabels(fid, next)
            .then(() => queryClient.invalidateQueries())
            .catch(() => {});
        }
        return next;
      });
    },
    [fid, queryClient],
  );

  if (!fid) {
    return (
      <Page meta={{ title: 'Your own setup (Advanced) / Fiddy' }}>
        <div className="border-default sm:border-x">
          <PageHeader hideCastButton>
            <div className="flex items-center gap-2">
              <PageTitle>Your own setup</PageTitle>
              <span className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                Advanced
              </span>
            </div>
          </PageHeader>
        </div>
        <BorderedMainContent className="flex flex-row">
          <SettingsNav />
          <SettingsPageContent>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="text-lg font-semibold">No account</span>
              <span className="text-sm text-muted">
                Sign in to use the setup you run
              </span>
            </div>
          </SettingsPageContent>
        </BorderedMainContent>
      </Page>
    );
  }

  return (
    <Page meta={{ title: 'Your own setup (Advanced) / Fiddy' }}>
      <div className="border-default sm:border-x">
        <PageHeader hideCastButton>
          <div className="flex items-center gap-2">
            <PageTitle>Your own setup</PageTitle>
            <span className="rounded-full border border-[rgba(255,255,255,0.09)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              Advanced
            </span>
          </div>
        </PageHeader>
      </div>
      <BorderedMainContent className="flex flex-row">
        <SettingsNav />
        <SettingsPageContent>
          <div className="flex flex-col gap-6">
            {/* Plain words first: nothing on this screen is needed to use
                Fiddy, and the precise words below are the ones you configure. */}
            <p className="text-sm text-muted">
              This is the Advanced part. Point Fiddy at the server you want to
              read through — your own, or one that is already open to everyone —
              and everything you read and write goes through it. The rest of
              Fiddy works without it, and nothing here is needed to get started.
            </p>

            {/* Where Fiddy reads from: the reader's choice, and the first
                thing on this screen because everything below it reads through
                whichever server it names. */}
            <NetworkChoiceCard
              reading={networkReading}
              offers={networkChoices}
              onChooseRoute={handleChooseNetwork}
            />

            <NodeChoiceCard
              choice={nodeChoice}
              onChoose={handleChooseNode}
              onReset={handleResetNode}
            />

            {/* The order, and what happens when the first server on it stops
                answering: the reader's list, with the last check on each. */}
            <ProviderListCard fid={fid ?? undefined} />

            {/* Node Status Card */}
            <NodeStatusCard
              health={nodeHealth}
              loading={healthLoading}
              onRefresh={refreshHealth}
              network={networkName(networkReading.network)}
            />

            {/* Posting key: the primary way to let Fiddy post for you — one
                tap in the reader's own Farcaster app, no fee and no passphrase.
                Everything below it is the slower, developer-shaped path. */}
            <PostingKeyCard
              fid={fid ?? undefined}
              onUseOwnAppKey={handleUseOwnAppKey}
              onServiceUnreachable={handlePostingKeyUnreachable}
            />

            {/* App key: this device's own key, which is minted by signing the
                approval with the account's own recovery phrase. That is why it
                lives behind a collapsed disclosure that says so out loud: a
                normal reader never has to see a phrase prompt, and a developer
                (or a test account) can still find the old flow where it was. */}
            <details
              className="rounded-lg border p-3 border-default"
              data-fiddy="advanced-app-key"
              open={advancedOpen || appKeyLive}
              onToggle={(event) =>
                setAdvancedOpen(
                  (event.currentTarget as HTMLDetailsElement).open,
                )
              }
            >
              <summary className="cursor-pointer text-sm text-muted">
                {appKeyLive
                  ? 'Advanced: this device’s own app key (test-account recovery phrase)'
                  : 'Advanced: test account recovery phrase (developers only)'}
              </summary>
              <p className="mb-3 mt-2 text-xs text-muted">
                This path asks for your account’s recovery phrase, signs one
                approval with it in this browser tab, and keeps the key it makes
                on this device. Use a test account. If you only want Fiddy to
                post for you, use the card above instead — it needs neither.
              </p>
              <AppKeyCard
                signer={signerState?.signer}
                publicKeyHex={appKey?.publicKeyHex}
                gaslessSignerCount={signerState?.gaslessSignerCount ?? 0}
                gaslessSignerLimit={signerState?.gaslessSignerLimit ?? 1000}
                currentUserNonce={signerState?.currentUserNonce ?? 0}
                loading={issueLoading}
                issueStep={issueStep}
                error={postError}
                onIssue={() => setShowSeedPhraseModal(true)}
                onRevoke={handleRevokeKey}
              />
            </details>

            {/* Composer */}
            <NodeComposer
              disabled={!appKey}
              disabledMessage={
                !appKey
                  ? 'Issue an app key first to post casts through your own setup'
                  : undefined
              }
              onPost={handlePostCast}
              success={postSuccess}
              error={postError}
            />

            {/* Feed. `actionError` covers the react/follow writes, which have
                no optimistic UI of their own. */}
            {actionError && (
              <div
                className="rounded border p-2 text-xs bg-tertiary border-default text-danger"
                role="alert"
              >
                {actionError}
              </div>
            )}
            <NodeFeed
              casts={casts}
              loading={feedLoading}
              isFallback={feedEmpty}
              onRefresh={refreshFeed}
              onReact={handleReaction}
              onFollow={handleFollow}
            />

            {/* Client Filter */}
            <ClientFilterCard
              policy={filterPolicy}
              clientCounts={clientCounts}
              clientLabels={clientLabels}
              onChange={handleFilterChange}
              onLabelClient={handleLabelClient}
            />
          </div>
        </SettingsPageContent>
      </BorderedMainContent>

      {/* Seed Phrase Warning Modal */}
      {showSeedPhraseModal && (
        <SeedPhraseWarningModal
          onClose={() => setShowSeedPhraseModal(false)}
          onConfirm={handleIssueKey}
          loading={issueLoading}
        />
      )}
    </Page>
  );
});

SettingsNodePage.displayName = 'SettingsNodePage';

export { SettingsNodePage };
