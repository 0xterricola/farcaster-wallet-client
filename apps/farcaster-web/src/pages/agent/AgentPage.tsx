/**
 * The Fiddy Agent surface.
 *
 * Four states, no fake ones:
 *   signed in, built-in brain — the owner picked the Fiddy or Surp brain on the
 *     way in, so their owner session is asked for on arrival and they land in
 *     **Chat**, under the name they chose, with the conversation they already
 *     had before signing in. When starting an agent is closed on this service,
 *     or the service cannot be reached, the header says so in one sentence —
 *     still no URL field, still no token to paste.
 *   not paired, own service — the egg, one hatch action, the honest availability
 *     line, and the pairing form, which is the right screen for somebody who
 *     runs their own control plane.
 *   pairing     — paste the address of the service that runs your agent
 *   paired      — the agent itself: identity, chat, scheduled tasks, channels
 *
 * Every network call goes through `~/lib/agentService`, which never holds a
 * provider key. Capabilities the service has not confirmed are labelled; a
 * failed call says so instead of showing a spinner forever.
 *
 * Asking again: the service is read when the surface arrives, and again when
 * the owner comes back to the tab (`focus`, or the document becoming visible)
 * or presses "Check again". An agent can start existing while this tab is open
 * — hatched in another tab, or the service coming back up — and a surface that
 * reads once per visit leaves the owner looking at "not awake yet" with a
 * working agent behind it, with only a reload to show it. That was measured on
 * live: the Agent tab never learned the agent existed.
 */

import { Brain, Plug } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  AgentHatchCard,
  AgentIdentityCard,
  type HatchAvailability,
  hatchAvailabilityCopy,
} from '~/components/agent/AgentCard';
import { brainSummary } from '~/components/fiddy/BrainSheet';
import { Link } from '~/components/links/Link';
import { Page } from '~/components/page/Page';
import { useAgentSession } from '~/hooks/agent/useAgentSession';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import {
  loadSchedules,
  newScheduleId,
  saveSchedules,
  type ScheduleRequest,
  upsertSchedule,
} from '~/lib/agentSchedules';
import {
  agentLifecycle,
  AgentServiceError,
  type AgentServiceSession,
  type AgentSummary,
  type ChannelConnection,
  type ChannelToolkit,
  chatWithAgent,
  connectChannel,
  DEFAULT_AGENT_SERVICE_URL,
  destroyAgent,
  fetchHatchQuote,
  fetchHermesCatalog,
  fetchServiceHealth,
  isUnavailable,
  listAgents,
  listChannels,
  probeAgentService,
} from '~/lib/agentService';
import {
  AUTOPAIR_SENTENCES,
  type AutopairProvisioning,
  openOwnerSession,
  shouldAutopair,
} from '~/lib/fiddyAgentAutopair';
import { allowedChannelCount, useFiddySetup } from '~/lib/fiddySetup';
import { clearSiwfProof, loadSiwfProof } from '~/lib/siwfSession';
import { clearTrialExchange, loadTrialExchange } from '~/lib/trialChat';
import { trackError } from '~/utils/errorUtils';

import { AgentChannelsPanel } from './Component/AgentChannelsPanel';
import {
  type AgentChatMessage,
  AgentChatPanel,
} from './Component/AgentChatPanel';
import { AgentPairPanel } from './Component/AgentPairPanel';
import { AgentSchedulesPanel } from './Component/AgentSchedulesPanel';

/** Channels Hermes supports that this control plane does not expose yet. */
const PENDING_CHANNELS = ['iMessage', 'WhatsApp', 'Email', 'Web / API'];

const errorText = (error: unknown): string => {
  if (error instanceof AgentServiceError) {
    switch (error.code) {
      case 'AUTH_REQUIRED':
      case 'INVALID_AUTH_TOKEN':
        return 'That session token was not accepted. Check it and try again.';
      case 'INVALID_SERVICE_URL':
        return 'That address is not a usable agent service address.';
      case 'NOT_PAIRED':
        return 'Pair an agent service first.';
      case 'CHAT_FAILED':
      case 'EMPTY_REPLY':
        return 'Your agent did not answer. Its instance may be stopped — check the status above.';
      default:
        return error.message || `Agent service error: ${error.code}`;
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Your agent took too long to answer. Try again, or check whether it is running.';
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
};

const newMessageId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * How soon a return to the tab may ask the service again. A tab is focused
 * constantly — every alt-tab, every click back — and none of those is a reason
 * to call the service. A few seconds is enough to cover the case this exists
 * for: the owner hatched their agent somewhere else and came back.
 */
const RECHECK_MIN_INTERVAL_MS = 5_000;

/**
 * The one failure a retry cannot change: there is no sign-in proof left to
 * spend, so asking the service again would say exactly the same sentence. Every
 * other failure is worth one more ask, because the proof is only spent by a
 * successful answer.
 */
const PROOF_MISSING = 'NO_PROOF';

const AgentPage: React.FC = () => {
  const { status, session, pair, forget } = useAgentSession();
  const setup = useFiddySetup();
  const { fid } = useCurrentUser();

  const [view, setView] = useState<'surface' | 'pair'>('surface');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const [availability, setAvailability] =
    useState<HatchAvailability>('unknown');
  const [catalog, setCatalog] = useState<{
    skills: number;
    plugins: number;
  } | null>(null);

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  const [tab, setTab] = useState<'chat' | 'tasks' | 'channels'>('chat');
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRequest[]>([]);
  const [toolkits, setToolkits] = useState<ChannelToolkit[]>([]);
  const [connections, setConnections] = useState<ChannelConnection[]>([]);
  const [channelBusy, setChannelBusy] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);

  const paired: AgentServiceSession | null =
    status === 'paired' ? session : null;

  /**
   * The owner session this browser asks the service for, on arrival, when the
   * setup names a brain Fiddy itself provides. `started` is a ref rather than
   * state on purpose: this must run at most once per visit, and a re-render must
   * never be able to ask twice.
   *
   * The code of the last failed ask is kept in a ref, not in state: it decides
   * whether a return to the tab may ask again, and reading it from a ref keeps
   * that decision out of the effect's own inputs. (In the deps, it would re-run
   * the effect the moment the attempt set its own state, and the cleanup would
   * throw away the answer that was still in flight.)
   */
  const [autopair, setAutopair] = useState<{
    state: 'idle' | 'running' | 'failed';
    sentence: string | null;
    provisioning: AutopairProvisioning | null;
  }>({ state: 'idle', sentence: null, provisioning: null });
  const autopairStarted = useRef(false);
  const autopairFailure = useRef<string | null>(null);
  const trialStarted = useRef(false);

  /**
   * The signal that the answer may have changed: bumped when the owner comes
   * back to the tab, and when they press "Check again". Every read of the
   * service is keyed on it — the agent list when paired, and one more ask for
   * the owner session when the last ask failed for a reason a retry can change.
   */
  const [checkTick, setCheckTick] = useState(0);
  const lastReturnAt = useRef(0);
  const lastRetriedTick = useRef(0);
  const askAgain = useCallback(() => {
    setCheckTick((current) => current + 1);
  }, []);

  useEffect(() => {
    const onReturn = () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      const now = Date.now();
      if (now - lastReturnAt.current < RECHECK_MIN_INTERVAL_MS) {
        return;
      }
      lastReturnAt.current = now;
      askAgain();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [askAgain]);

  /** The exchange the visitor had before signing in, if there was one. */
  const [trial, setTrial] = useState<{
    messages: AgentChatMessage[];
    name: string | null;
    note: string | null;
  }>({ messages: [], name: null, note: null });

  // Adopt the conversation that happened before the sign-in, once. It is read
  // from storage, shown first, and then deleted so a later visit cannot seed the
  // same two messages again.
  useEffect(() => {
    if (trialStarted.current) {
      return;
    }
    trialStarted.current = true;
    const exchange = loadTrialExchange();
    if (!exchange) {
      return;
    }
    setTrial({
      messages: [
        {
          id: newMessageId(),
          role: 'owner',
          text: exchange.message,
          at: exchange.at,
        },
        {
          id: newMessageId(),
          role: 'agent',
          text: exchange.reply,
          at: exchange.at + 1,
        },
      ],
      name: exchange.agentName,
      note: exchange.note,
    });
    clearTrialExchange();
  }, []);

  // Ask for the owner session: signed in, built-in brain, nothing paired yet.
  // Once per visit — plus once per return to the tab, when the last ask failed
  // for a reason a retry can still change. The proof is only spent by a
  // successful answer, so nothing is lost by asking again; a failure that WAS
  // the missing proof is not retried, because asking would say the same thing.
  useEffect(() => {
    if (status !== 'unpaired' || !shouldAutopair({ setup, fid })) {
      return;
    }
    if (autopairStarted.current) {
      const failedCode = autopairFailure.current;
      const retryable =
        checkTick > 0 &&
        lastRetriedTick.current !== checkTick &&
        failedCode !== null &&
        failedCode !== PROOF_MISSING;
      if (!retryable) {
        return;
      }
      lastRetriedTick.current = checkTick;
    }
    autopairStarted.current = true;
    autopairFailure.current = null;
    let cancelled = false;
    setAutopair({ state: 'running', sentence: null, provisioning: null });

    void (async () => {
      const outcome = await openOwnerSession({ proof: loadSiwfProof(), setup });
      if (cancelled) {
        return;
      }
      if (!outcome.ok) {
        autopairFailure.current = outcome.code;
        setAutopair({
          state: 'failed',
          sentence: outcome.sentence,
          provisioning: null,
        });
        return;
      }
      // The proof has been spent; a session is what is kept now.
      clearSiwfProof();
      await pair({
        baseUrl: outcome.session.baseUrl,
        token: outcome.session.token,
      });
      setTab('chat');
      autopairFailure.current = null;
      setAutopair({
        state: 'idle',
        sentence: null,
        provisioning: outcome.provisioning,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [status, fid, pair, setup, checkTick]);

  /** What to call the agent while it is not yet a live instance. */
  const namedAgent = trial.name ?? setup.agentName;

  /** The thread: what was said before signing in, then what has been said since. */
  const thread = trial.messages.length
    ? [...trial.messages, ...messages]
    : messages;

  /**
   * The one sentence the surface is allowed to say about an agent that is not
   * awake. The service's own words when it sent any, and otherwise the plainest
   * true thing: nothing was changed.
   */
  const notAwakeSentence =
    autopair.provisioning?.message ??
    autopair.sentence ??
    AUTOPAIR_SENTENCES.UNREACHABLE;

  // The live Hermes catalog is public: it is a receipt for what a hatched agent
  // ships with, so it is fetched before anyone pairs.
  useEffect(() => {
    let cancelled = false;
    fetchHermesCatalog()
      .then((result) => {
        if (!cancelled) {
          setCatalog({ skills: result.skills, plugins: result.plugins });
        }
      })
      .catch(() => {
        // A catalog that will not load is not an error the owner can act on.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Not paired: the only thing knowable anonymously is whether the default
  // service is up. Never claim hatching is closed without asking it.
  useEffect(() => {
    if (paired) {
      return;
    }
    let cancelled = false;
    probeAgentService()
      .then((probe) => {
        if (!cancelled) {
          setAvailability(probe.reachable ? 'unknown' : 'unreachable');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [paired]);

  // Paired: what agents exist, is the service up, is hatching offered here.
  useEffect(() => {
    if (!paired) {
      setAgents(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);

    const load = async () => {
      try {
        const [listed] = await Promise.all([
          listAgents(paired),
          fetchServiceHealth(paired).catch(() => undefined),
        ]);
        if (cancelled) {
          return;
        }
        setAgents(listed);
        setSelectedId((current) => current ?? listed[0]?.id ?? null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        trackError(new Error(`agent surface: ${errorText(error)}`));
        setLoadError(errorText(error));
        setAgents([]);
      }

      try {
        const quote = await fetchHatchQuote(paired);
        if (!cancelled) {
          setAvailability(quote.hatchEnabled ? 'open' : 'closed');
        }
      } catch (error) {
        if (!cancelled) {
          setAvailability(isUnavailable(error) ? 'closed' : 'unreachable');
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // `checkTick` in the deps is what makes a return to the tab re-read the
    // service: the agent list, the service's health, and whether hatching is
    // open. The selected agent stays selected and the conversation is kept.
  }, [paired, checkTick]);

  // Selected agent: its schedule log and its channels.
  useEffect(() => {
    if (!paired || !selectedId) {
      setSchedules([]);
      setToolkits([]);
      setConnections([]);
      return;
    }
    let cancelled = false;
    setMessages([]);
    setChannelError(null);
    loadSchedules(selectedId)
      .then((stored) => {
        if (!cancelled) {
          setSchedules(stored);
        }
      })
      .catch(() => undefined);

    listChannels(paired, selectedId)
      .then((result) => {
        if (!cancelled) {
          setToolkits(result.toolkits);
          setConnections(result.connections);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setChannelError(
            isUnavailable(error)
              ? 'This service does not expose channel connections yet.'
              : errorText(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [paired, selectedId]);

  const handlePair = useCallback(
    async (next: AgentServiceSession) => {
      setPairBusy(true);
      setPairError(null);
      try {
        // Prove the token before storing it: a bad token must not look paired.
        await listAgents(next);
        await pair(next);
        setView('surface');
      } catch (error) {
        setPairError(errorText(error));
      } finally {
        setPairBusy(false);
      }
    },
    [pair],
  );

  const handleForget = useCallback(async () => {
    await forget();
    setAgents(null);
    setSelectedId(null);
    setMessages([]);
    setSchedules([]);
    setToolkits([]);
    setConnections([]);
    setView('surface');
  }, [forget]);

  const selected = agents?.find((agent) => agent.id === selectedId) ?? null;

  const refreshAgents = useCallback(async () => {
    if (!paired) {
      return;
    }
    try {
      const listed = await listAgents(paired);
      setAgents(listed);
      setSelectedId((current) => current ?? listed[0]?.id ?? null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [paired]);

  const handleLifecycle = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      if (!paired || !selected) {
        return;
      }
      setLifecycleBusy(true);
      try {
        await agentLifecycle(paired, selected.id, action);
        await refreshAgents();
      } catch (error) {
        setLoadError(errorText(error));
      } finally {
        setLifecycleBusy(false);
      }
    },
    [paired, selected, refreshAgents],
  );

  const handleDestroy = useCallback(async () => {
    if (!paired || !selected) {
      return;
    }
    const confirmed = window.confirm(
      `Destroy ${selected.name}? This stops all billing and cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }
    setLifecycleBusy(true);
    try {
      await destroyAgent(paired, selected.id);
      setSelectedId(null);
      setMessages([]);
      await refreshAgents();
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLifecycleBusy(false);
    }
  }, [paired, selected, refreshAgents]);

  const sendMessage = useCallback(
    async (text: string, options: { trackAs?: ScheduleRequest } = {}) => {
      if (!paired || !selected) {
        return null;
      }
      setChatBusy(true);
      setMessages((current) => [
        ...current,
        {
          id: newMessageId(),
          role: 'owner',
          text,
          at: Date.now(),
        },
      ]);
      try {
        const reply = await chatWithAgent(paired, selected.id, text);
        setMessages((current) => [
          ...current,
          { id: newMessageId(), role: 'agent', text: reply, at: Date.now() },
        ]);
        if (options.trackAs) {
          const answered: ScheduleRequest = {
            ...options.trackAs,
            state: 'answered',
            reply: reply.slice(0, 600),
          };
          setSchedules((current) => {
            const next = upsertSchedule(current, answered);
            saveSchedules(selected.id, next).catch(() => undefined);
            return next;
          });
        }
        return reply;
      } catch (error) {
        const text2 = errorText(error);
        setMessages((current) => [
          ...current,
          { id: newMessageId(), role: 'error', text: text2, at: Date.now() },
        ]);
        if (options.trackAs) {
          const failed: ScheduleRequest = {
            ...options.trackAs,
            state: 'failed',
            reply: text2,
          };
          setSchedules((current) => {
            const next = upsertSchedule(current, failed);
            saveSchedules(selected.id, next).catch(() => undefined);
            return next;
          });
        }
        return null;
      } finally {
        setChatBusy(false);
      }
    },
    [paired, selected],
  );

  const handleSchedule = useCallback(
    (prompt: string) => {
      if (!selected) {
        return;
      }
      const request: ScheduleRequest = {
        id: newScheduleId(),
        agentId: selected.id,
        prompt,
        state: 'requested',
        createdAt: Date.now(),
      };
      setSchedules((current) => {
        const next = upsertSchedule(current, request);
        saveSchedules(selected.id, next).catch(() => undefined);
        return next;
      });
      void sendMessage(
        `Schedule this recurring task for me, then confirm it in one line: ${prompt}`,
        { trackAs: request },
      );
    },
    [selected, sendMessage],
  );

  const handleRemoveSchedule = useCallback(
    (id: string) => {
      if (!selected) {
        return;
      }
      setSchedules((current) => {
        const next = current.filter((item) => item.id !== id);
        saveSchedules(selected.id, next).catch(() => undefined);
        return next;
      });
    },
    [selected],
  );

  const handleConnectChannel = useCallback(
    async (slug: string) => {
      if (!paired || !selected) {
        return;
      }
      setChannelBusy(slug);
      setChannelError(null);
      try {
        const redirectUrl = await connectChannel(paired, selected.id, slug);
        window.open(redirectUrl, '_blank', 'noopener,noreferrer');
      } catch (error) {
        setChannelError(errorText(error));
      } finally {
        setChannelBusy(null);
      }
    },
    [paired, selected],
  );

  const renderSurface = () => {
    if (status === 'loading') {
      return <p className="p-8 text-sm text-muted">Loading your agent…</p>;
    }

    if (view === 'pair') {
      return (
        <AgentPairPanel
          busy={pairBusy}
          error={pairError}
          onSubmit={handlePair}
          onCancel={() => {
            setView('surface');
            setPairError(null);
          }}
        />
      );
    }

    if (!paired && shouldAutopair({ setup, fid })) {
      // Signed in with a brain Fiddy provides: this is a chat, not a form. The
      // service is asked for the owner's session on arrival; whether that is
      // open or closed, what the owner sees is their agent's name and one
      // sentence — plus the one conversation they already started.
      return (
        <section className="solid-glass-pane mx-auto w-full max-w-xl rounded-[18px] p-5">
          <header className="mb-3 flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-[#d4ff3f] bg-[#1d1e1c]">
              <span
                aria-hidden="true"
                className="text-lg font-bold text-[#d4ff3f]"
              >
                {namedAgent.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <h1 className="font-[SeasonMix] text-lg font-semibold text-default">
                {namedAgent}
              </h1>
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted"
              >
                {autopair.state === 'running'
                  ? 'Waking your agent…'
                  : 'Not awake yet'}
              </p>
            </div>
          </header>

          <p role="alert" className="mb-2 text-sm text-muted">
            {autopair.state === 'running'
              ? 'You are signed in, so this browser asked the service that runs your agent for your session.'
              : notAwakeSentence}
          </p>
          {trial.note ? (
            <p className="mb-2 text-xs text-muted">{trial.note}</p>
          ) : null}

          <AgentChatPanel
            messages={thread}
            busy={false}
            onSend={() => undefined}
            awaiting={{
              note: `You can write to ${namedAgent} once it is awake.`,
            }}
          />

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[rgba(255,255,255,0.09)] pt-4">
            <button
              type="button"
              onClick={askAgain}
              disabled={autopair.state === 'running'}
              className="rounded-lg border border-[#d4ff3f] px-3 py-1.5 text-sm font-medium text-[#d4ff3f] hover:bg-[#d4ff3f]/10 disabled:opacity-50"
            >
              Check again
            </button>
            <button
              type="button"
              onClick={() => setView('pair')}
              className="text-sm text-[#d4ff3f] underline underline-offset-4 hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#d4ff3f]"
            >
              I run my own agent service — pair it
            </button>
          </div>
        </section>
      );
    }

    if (!paired) {
      return (
        <AgentHatchCard
          availability={availability}
          catalog={catalog}
          onHatch={() => setView('pair')}
          onPair={() => setView('pair')}
        />
      );
    }

    if (agents === null) {
      return (
        <p className="p-8 text-sm text-muted">Reading your agent service…</p>
      );
    }

    if (loadError) {
      return (
        <section className="solid-glass-pane mx-auto w-full max-w-xl rounded-[18px] p-6 text-center">
          <h1 className="mb-2 font-[SeasonMix] text-lg font-semibold text-default">
            Your agent service did not answer
          </h1>
          <p role="alert" className="mb-4 text-sm text-muted">
            {loadError}
          </p>
          <p className="mb-4 text-xs text-muted">
            Paired at {paired.baseUrl.replace('https://', '')}. The token is
            still in this browser; retry, or unpair and pair again.
          </p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void refreshAgents()}
              className="rounded-lg border border-[#d4ff3f] px-4 py-2 text-sm font-medium text-[#d4ff3f] hover:bg-[#d4ff3f]/10"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => void handleForget()}
              className="rounded-lg border border-[rgba(255,255,255,0.09)] px-4 py-2 text-sm text-muted hover:text-default"
            >
              Unpair
            </button>
          </div>
        </section>
      );
    }

    if (!selected) {
      return (
        <section className="solid-glass-pane mx-auto w-full max-w-xl rounded-[18px] p-8 text-center">
          <h1 className="mb-2 font-[SeasonMix] text-lg font-semibold text-default">
            No agent on this service yet
          </h1>
          <p className="mb-2 text-sm text-muted">
            You are paired with {paired.baseUrl.replace('https://', '')}, which
            has no agents for your account.
          </p>
          <p className="mb-4 text-xs text-muted">
            {hatchAvailabilityCopy[availability]}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={askAgain}
              className="rounded-lg border border-[#d4ff3f] px-4 py-2 text-sm font-medium text-[#d4ff3f] hover:bg-[#d4ff3f]/10"
            >
              Check again
            </button>
            <button
              type="button"
              onClick={() => setView('pair')}
              className="rounded-lg border border-[rgba(255,255,255,0.09)] px-4 py-2 text-sm text-muted hover:text-default"
            >
              Pair a different service
            </button>
          </div>
        </section>
      );
    }

    return (
      <div className="flex flex-col gap-4">
        <AgentIdentityCard
          name={selected.name}
          status={selected.status}
          serviceUrl={paired.baseUrl}
          busy={lifecycleBusy}
          onStart={() => void handleLifecycle('start')}
          onStop={() => void handleLifecycle('stop')}
          onRestart={() => void handleLifecycle('restart')}
          onDestroy={() => void handleDestroy()}
          onForget={() => void handleForget()}
        />

        {agents && agents.length > 1 ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            Agent
            <select
              value={selected.id}
              onChange={(event) => setSelectedId(event.target.value)}
              className="rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#1d1e1c] px-2 py-1 text-xs text-default focus:border-[#d4ff3f] focus:outline-none"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div
          role="tablist"
          aria-label="Agent surfaces"
          className="flex gap-1 rounded-xl border border-[rgba(255,255,255,0.09)] p-1"
        >
          {(
            [
              ['chat', 'Chat'],
              ['tasks', 'Scheduled tasks'],
              ['channels', 'Channels'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm ${
                tab === key
                  ? 'bg-[#d4ff3f] font-semibold text-[#1a1c10]'
                  : 'text-muted hover:text-default'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'chat' ? (
          <AgentChatPanel
            messages={thread}
            busy={chatBusy}
            onSend={(text) => void sendMessage(text)}
          />
        ) : null}

        {tab === 'tasks' ? (
          <AgentSchedulesPanel
            schedules={schedules}
            busy={chatBusy}
            onRequest={handleSchedule}
            onRemove={handleRemoveSchedule}
          />
        ) : null}

        {tab === 'channels' ? (
          <AgentChannelsPanel
            toolkits={toolkits}
            connections={connections}
            busyToolkit={channelBusy}
            error={channelError}
            pending={PENDING_CHANNELS}
            onConnect={(slug) => void handleConnectChannel(slug)}
          />
        ) : null}
      </div>
    );
  };

  return (
    <Page meta={{ title: 'Fiddy Agent' }} className="px-4 py-6">
      <div className="fiddy-agent-tiles">
        <Link
          to="fiddyBrains"
          params={{}}
          searchParams={{}}
          title="Add a brain"
          className="fiddy-tile"
        >
          <Brain aria-hidden="true" />
          <span>
            <b>Add a brain</b>
            <small>{brainSummary(setup)}</small>
          </span>
        </Link>
        <Link
          to="fiddyApps"
          params={{}}
          searchParams={{}}
          title="Connect apps"
          className="fiddy-tile"
        >
          <Plug aria-hidden="true" />
          <span>
            <b>Connect apps</b>
            <small>
              {allowedChannelCount(setup)} on — the list you choose from
            </small>
          </span>
        </Link>
      </div>

      <p className="mb-4 text-xs text-muted">
        Agent service:{' '}
        {paired
          ? paired.baseUrl.replace('https://', '')
          : DEFAULT_AGENT_SERVICE_URL.replace('https://', '')}
      </p>
      {renderSurface()}
    </Page>
  );
};

export { AgentPage };
