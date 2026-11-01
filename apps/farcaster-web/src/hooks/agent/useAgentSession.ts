/**
 * The agent session this browser holds.
 *
 * Kept deliberately tiny: whether a session exists, at which service. Network
 * state (which agents, what they say) belongs to the page, so that the sidebar
 * can show "hatched / not hatched" without making a request on every render.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  AGENT_SESSION_EVENT,
  type AgentServiceSession,
  clearAgentSession,
  loadAgentSession,
  notifyAgentSessionChanged,
  saveAgentSession,
} from '~/lib/agentService';

export interface AgentSessionState {
  status: 'loading' | 'unpaired' | 'paired';
  session: AgentServiceSession | null;
}

export const useAgentSession = (): AgentSessionState & {
  pair: (session: AgentServiceSession) => Promise<void>;
  forget: () => Promise<void>;
} => {
  const [state, setState] = useState<AgentSessionState>({
    status: 'loading',
    session: null,
  });

  const read = useCallback(async () => {
    const session = await loadAgentSession();
    setState({ status: session ? 'paired' : 'unpaired', session });
  }, []);

  useEffect(() => {
    read();
    const onChange = () => {
      read();
    };
    window.addEventListener(AGENT_SESSION_EVENT, onChange);
    return () => window.removeEventListener(AGENT_SESSION_EVENT, onChange);
  }, [read]);

  const pair = useCallback(async (session: AgentServiceSession) => {
    await saveAgentSession(session);
    const stored = await loadAgentSession();
    setState({ status: stored ? 'paired' : 'unpaired', session: stored });
    notifyAgentSessionChanged();
  }, []);

  const forget = useCallback(async () => {
    await clearAgentSession();
    setState({ status: 'unpaired', session: null });
    notifyAgentSessionChanged();
  }, []);

  return { ...state, pair, forget };
};
