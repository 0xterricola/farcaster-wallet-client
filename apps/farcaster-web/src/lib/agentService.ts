/**
 * Fiddy Agent — client for the agent service.
 *
 * The client never talks to a model provider and never holds a provider key.
 * It talks to an *agent service* (the control plane that runs Hermes instances)
 * over the small JSON API below; the provider credential stays on the server
 * that owns the instance. That is the whole security story, so it lives in the
 * module doc: nothing in this file may accept, store, log or forward a provider
 * key, and no user-visible copy names the provider that happens to be behind
 * the service today.
 *
 * Endpoints (all under the service origin, all JSON):
 *
 *   GET    /api/health                              service liveness + mode
 *   GET    /api/agents/instances                    the agents this owner has
 *   POST   /api/agents/instances/:id/:action        start | stop | restart
 *   DELETE /api/agents/instances/:id                destroy (stops all billing)
 *   POST   /api/agents/instances/:id/chat           one message, one reply
 *   GET    /api/agents/instances/:id/integrations   channel toolkits + links
 *   POST   /api/agents/instances/:id/integrations   begin a channel connection
 *   GET    /api/fiddy/hatch-quote                   price certificate (opt-in)
 *   GET    /api/hermes/catalog                      the live Hermes catalog
 *   POST   /api/agents/brains/probe                 read-only model list of an AI service
 *   PUT    /api/agents/instances/:id/brain          point an agent at a different AI service
 *
 * The hatch-quote route is not deployed on every control plane. A 404 there is
 * a normal answer ("hatching is not open on this service"), not a crash, and
 * the surface says so.
 */

import { deleteItem, getItem, setItem } from '~/utils/storageUtils';

/**
 * The agent service this build points at by default. Override per user in the
 * pairing screen (`VITE_AGENT_SERVICE_URL` for a self-hosted deploy), because
 * the service is just a Hermes control plane, not a vendor.
 */
export const DEFAULT_AGENT_SERVICE_URL =
  (import.meta.env.VITE_AGENT_SERVICE_URL as string | undefined)?.trim() ||
  'https://fiddy.fun';

const SESSION_KEY = 'fiddy.agent.session';
const REQUEST_TIMEOUT_MS = 150_000;

/**
 * AbortSignal.timeout is not in every runtime this bundle can meet (jsdom in
 * tests, older Safari). A missing timeout is better than a thrown TypeError:
 * the request still happens, it just has no client-side deadline.
 */
const timeoutSignal = (ms: number): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;

export interface AgentServiceSession {
  /** Service origin, no path/query/hash: `https://agents.example.com`. */
  baseUrl: string;
  /**
   * The owner's session token for that service. It authorises this browser to
   * manage the owner's agents; it is not a provider key and it grants nothing
   * at the model provider.
   */
  token: string;
}

export type AgentServiceStatus =
  | 'starting'
  | 'running'
  | 'stopped'
  | 'sleeping'
  | 'error'
  | string;

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentServiceStatus;
  template?: string;
  url?: string;
  created?: number;
}

export interface HatchFees {
  nurseryMonthlyCents?: number;
  cribMonthlyCents?: number;
  awakeMonthlyCents?: number;
  asleepMonthlyCents?: number;
  awakeDailyCents?: number;
}

export interface HatchCertificate {
  displayName?: string | null;
  username?: string | null;
  template?: string;
  fees?: HatchFees;
  notes?: string;
}

export interface HatchQuote {
  hatchEnabled: boolean;
  certificate: HatchCertificate | null;
}

export interface ChannelToolkit {
  slug: string;
  name: string;
  description?: string;
}

export interface ChannelConnection {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  status: string;
}

export interface HermesCatalog {
  skills: number;
  plugins: number;
  examples: { name: string; description: string }[];
}

export class AgentServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = 'AgentServiceError';
    this.code = code;
    this.status = status;
  }
}

/** Codes the UI treats as "not offered here", never as a failure. */
export const isUnavailable = (error: unknown): boolean =>
  error instanceof AgentServiceError &&
  (error.status === 404 || error.code === 'NOT_DEPLOYED');

/**
 * Is the default agent service answering at all? Anonymous, so the empty state
 * can say something true before anyone pairs: "unreachable" instead of a
 * perpetual "checking…" against a host that is down.
 */
export const probeAgentService = async (
  fetchImpl?: typeof fetch,
): Promise<{ reachable: boolean; mode: string | null }> => {
  try {
    const payload = await request<{ mode?: string }>(null, '/api/health', {
      anonymous: true,
      fetchImpl,
    });
    return { reachable: true, mode: payload.mode ?? null };
  } catch {
    return { reachable: false, mode: null };
  }
};

/**
 * A service origin is https, bare, and nothing else: no credentials in the URL,
 * no path, no query. Rejecting instead of "fixing" keeps a typo from silently
 * pointing the client at the wrong host.
 */
export const normaliseServiceUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  if (url.port) {
    // A default port is the only one a browser needs on the public internet.
    return null;
  }
  return url.origin;
};

/** Tokens are opaque, single-line, and bounded — nothing else is accepted. */
export const isValidServiceToken = (raw: string): boolean => {
  const trimmed = raw.trim();
  return trimmed.length >= 8 && trimmed.length <= 4096 && !/\s/.test(trimmed);
};

export const loadAgentSession =
  async (): Promise<AgentServiceSession | null> => {
    const stored = await getItem<AgentServiceSession | null>({
      key: SESSION_KEY,
      fallback: null,
    });
    if (!stored || typeof stored !== 'object') {
      return null;
    }
    const baseUrl = normaliseServiceUrl(String(stored.baseUrl ?? ''));
    const token = String(stored.token ?? '');
    if (!baseUrl || !isValidServiceToken(token)) {
      return null;
    }
    return { baseUrl, token };
  };

export const saveAgentSession = async (
  session: AgentServiceSession,
): Promise<void> => {
  const baseUrl = normaliseServiceUrl(session.baseUrl);
  if (!baseUrl || !isValidServiceToken(session.token)) {
    throw new AgentServiceError('INVALID_SESSION', 400);
  }
  await setItem({ key: SESSION_KEY, value: { baseUrl, token: session.token } });
};

export const clearAgentSession = (): Promise<void> => deleteItem(SESSION_KEY);

/** Event name the sidebar and the agent page agree on for session changes. */
export const AGENT_SESSION_EVENT = 'fiddy:agent-session';

export const notifyAgentSessionChanged = (): void => {
  window.dispatchEvent(new Event(AGENT_SESSION_EVENT));
};

const parseError = async (response: Response): Promise<AgentServiceError> => {
  let code = `HTTP_${response.status}`;
  let message: string | undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body?.code === 'string' && body.code) {
      code = body.code;
    }
    if (typeof body?.message === 'string' && body.message) {
      message = body.message;
    }
  } catch {
    // Non-JSON body (an HTML 404 page, a proxy error): the status is the code.
  }
  return new AgentServiceError(code, response.status, message);
};

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Public endpoints (the Hermes catalog) need no token. */
  anonymous?: boolean;
  fetchImpl?: typeof fetch;
}

const request = async <T>(
  session: Pick<AgentServiceSession, 'baseUrl' | 'token'> | null,
  path: string,
  {
    method = 'GET',
    body,
    anonymous = false,
    fetchImpl = fetch,
  }: RequestOptions = {},
): Promise<T> => {
  if (!session && !anonymous) {
    throw new AgentServiceError('NOT_PAIRED', 401);
  }
  const baseUrl = session
    ? normaliseServiceUrl(session.baseUrl)
    : normaliseServiceUrl(DEFAULT_AGENT_SERVICE_URL);
  if (!baseUrl) {
    throw new AgentServiceError('INVALID_SERVICE_URL', 400);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (!anonymous && session) {
    headers.authorization = `Bearer ${session.token}`;
  }

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
};

/** Health of the service itself (not of an agent). */
export const fetchServiceHealth = async (
  session: Pick<AgentServiceSession, 'baseUrl' | 'token'>,
  fetchImpl?: typeof fetch,
): Promise<{ mode: string }> => {
  const payload = await request<{ ok?: boolean; mode?: string }>(
    session,
    '/api/health',
    { fetchImpl },
  );
  return { mode: payload.mode ?? 'unknown' };
};

export const listAgents = async (
  session: AgentServiceSession,
  fetchImpl?: typeof fetch,
): Promise<AgentSummary[]> => {
  const payload = await request<{ data?: unknown }>(
    session,
    '/api/agents/instances',
    { fetchImpl },
  );
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows.flatMap((row): AgentSummary[] => {
    if (!row || typeof row !== 'object') {
      return [];
    }
    const item = row as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id) {
      return [];
    }
    return [
      {
        id: item.id,
        name:
          typeof item.name === 'string' && item.name.trim()
            ? item.name
            : 'Your agent',
        status: typeof item.status === 'string' ? item.status : 'unknown',
        template: typeof item.template === 'string' ? item.template : undefined,
        url: typeof item.url === 'string' ? item.url : undefined,
        created: typeof item.created === 'number' ? item.created : undefined,
      },
    ];
  });
};

export const agentLifecycle = async (
  session: AgentServiceSession,
  agentId: string,
  action: 'start' | 'stop' | 'restart',
  fetchImpl?: typeof fetch,
): Promise<void> => {
  await request(
    session,
    `/api/agents/instances/${encodeURIComponent(agentId)}/${action}`,
    {
      method: 'POST',
      fetchImpl,
    },
  );
};

export const destroyAgent = async (
  session: AgentServiceSession,
  agentId: string,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  await request(
    session,
    `/api/agents/instances/${encodeURIComponent(agentId)}`,
    {
      method: 'DELETE',
      fetchImpl,
    },
  );
};

export const chatWithAgent = async (
  session: AgentServiceSession,
  agentId: string,
  message: string,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new AgentServiceError('EMPTY_MESSAGE', 400);
  }
  const payload = await request<{
    result?: { output_text?: unknown };
  }>(session, `/api/agents/instances/${encodeURIComponent(agentId)}/chat`, {
    method: 'POST',
    body: { message: trimmed },
    fetchImpl,
  });
  const text = payload.result?.output_text;
  if (typeof text !== 'string') {
    throw new AgentServiceError('EMPTY_REPLY', 502);
  }
  return text;
};

export const listChannels = async (
  session: AgentServiceSession,
  agentId: string,
  fetchImpl?: typeof fetch,
): Promise<{
  toolkits: ChannelToolkit[];
  connections: ChannelConnection[];
}> => {
  const payload = await request<{
    toolkits?: unknown;
    connections?: unknown;
  }>(
    session,
    `/api/agents/instances/${encodeURIComponent(agentId)}/integrations`,
    { fetchImpl },
  );
  const toolkits = (
    Array.isArray(payload.toolkits) ? payload.toolkits : []
  ).flatMap((row): ChannelToolkit[] => {
    if (!row || typeof row !== 'object') {
      return [];
    }
    const item = row as Record<string, unknown>;
    const slug = typeof item.slug === 'string' ? item.slug : '';
    if (!slug) {
      return [];
    }
    return [
      {
        slug,
        name: typeof item.name === 'string' && item.name ? item.name : slug,
        description:
          typeof item.description === 'string' ? item.description : undefined,
      },
    ];
  });
  const connections = (
    Array.isArray(payload.connections) ? payload.connections : []
  ).flatMap((row): ChannelConnection[] => {
    if (!row || typeof row !== 'object') {
      return [];
    }
    const item = row as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id) {
      return [];
    }
    return [
      {
        id: item.id,
        toolkitSlug:
          typeof item.toolkitSlug === 'string' ? item.toolkitSlug : '',
        toolkitName:
          typeof item.toolkitName === 'string' && item.toolkitName
            ? item.toolkitName
            : typeof item.toolkitSlug === 'string'
              ? item.toolkitSlug
              : 'channel',
        status: typeof item.status === 'string' ? item.status : 'UNKNOWN',
      },
    ];
  });
  return { toolkits, connections };
};

/**
 * Begin a channel connection. The service returns a URL the owner finishes on
 * the agent's own side — the client never receives a credential for the channel.
 */
export const connectChannel = async (
  session: AgentServiceSession,
  agentId: string,
  toolkit: string,
  fetchImpl?: typeof fetch,
): Promise<string> => {
  const payload = await request<{ redirectUrl?: unknown }>(
    session,
    `/api/agents/instances/${encodeURIComponent(agentId)}/integrations`,
    { method: 'POST', body: { toolkit }, fetchImpl },
  );
  if (typeof payload.redirectUrl !== 'string' || !payload.redirectUrl) {
    throw new AgentServiceError('CHANNEL_CONNECT_FAILED', 502);
  }
  return payload.redirectUrl;
};

/** Price certificate for hatching. Absent on a control plane without hatching. */
export const fetchHatchQuote = async (
  session: AgentServiceSession,
  fetchImpl?: typeof fetch,
): Promise<HatchQuote> => {
  const payload = await request<{
    hatchEnabled?: unknown;
    certificate?: unknown;
  }>(session, '/api/fiddy/hatch-quote', { fetchImpl });
  const certificate =
    payload.certificate && typeof payload.certificate === 'object'
      ? (payload.certificate as HatchCertificate)
      : null;
  return { hatchEnabled: payload.hatchEnabled === true, certificate };
};

/**
 * The live Hermes catalog: what a hatched agent actually ships with. Counts
 * only — this is a receipt, not a shopping list, and it is public data.
 */
export const fetchHermesCatalog = async (
  fetchImpl?: typeof fetch,
): Promise<HermesCatalog> => {
  const payload = await request<{
    items?: unknown;
    counts?: { skills?: unknown; plugins?: unknown };
  }>(null, '/api/hermes/catalog?size=4', { anonymous: true, fetchImpl });
  const examples = (Array.isArray(payload.items) ? payload.items : []).flatMap(
    (row): { name: string; description: string }[] => {
      if (!row || typeof row !== 'object') {
        return [];
      }
      const item = row as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name) {
        return [];
      }
      return [
        {
          name: item.name,
          description:
            typeof item.description === 'string' ? item.description : '',
        },
      ];
    },
  );
  return {
    skills: Number(payload.counts?.skills ?? 0) || 0,
    plugins: Number(payload.counts?.plugins ?? 0) || 0,
    examples,
  };
};

/**
 * Which AI service an agent thinks with — described the way the service wants it,
 * and never stored here.
 *
 * `key` is the owner's own credential for their own AI service. It is passed
 * straight through to the agent service, which is the only party that talks to
 * the workspace it belongs on: this client does not keep it, does not put it in
 * the setup file, and does not put it on any agent of its own. The choice of
 * brain (which service, which model, which address) is what this client keeps.
 */
export interface BrainChoice {
  kind: 'default' | 'preset' | 'custom';
  /** Preset id for `preset`; the service picks the address itself. */
  presetId?: string | null;
  /** The owner's own address for `custom`. */
  baseUrl?: string | null;
  model?: string | null;
  /** The owner's key for their service, for this call only. */
  key?: string | null;
}

export interface BrainProbe {
  ok: boolean;
  /** Plain machine status; the surface turns it into plain words. */
  status: string;
  code: string;
  /** Model ids the service listed, when it lists them. */
  models: string[];
}

/**
 * Ask the agent service to check an AI service, read-only.
 *
 * It runs on the service rather than in this browser for a measurable reason:
 * the big providers answer a page's cross-origin request with no CORS headers at
 * all, so a browser-side check would fail for everyone and blame the owner's
 * perfectly good key. Anonymous, because the screen that asks for it (choosing a
 * brain on the way in) happens before anyone has paired.
 */
export const probeBrain = async (
  session: AgentServiceSession | null,
  choice: BrainChoice,
  fetchImpl?: typeof fetch,
): Promise<BrainProbe> => {
  const payload = await request<{
    ok?: unknown;
    status?: unknown;
    code?: unknown;
    models?: unknown;
  }>(session, '/api/agents/brains/probe', {
    method: 'POST',
    body: choice,
    anonymous: true,
    fetchImpl,
  });
  return {
    ok: payload.ok === true,
    status: typeof payload.status === 'string' ? payload.status : 'unknown',
    code: typeof payload.code === 'string' ? payload.code : 'BRAIN_UNKNOWN',
    models: (Array.isArray(payload.models) ? payload.models : []).flatMap(
      (model): string[] => (typeof model === 'string' && model ? [model] : []),
    ),
  };
};

/** Point this agent at the AI service the owner chose. Owner's agent only. */
export const applyBrain = async (
  session: AgentServiceSession,
  agentId: string,
  choice: BrainChoice,
  fetchImpl?: typeof fetch,
): Promise<{ changed: boolean; readback: Record<string, unknown> | null }> => {
  const payload = await request<{
    ok?: unknown;
    readback?: unknown;
  }>(session, `/api/agents/instances/${encodeURIComponent(agentId)}/brain`, {
    method: 'PUT',
    body: { brain: choice },
    fetchImpl,
  });
  return {
    changed: payload.ok === true,
    readback:
      payload.readback && typeof payload.readback === 'object'
        ? (payload.readback as Record<string, unknown>)
        : null,
  };
};
