/**
 * Live check of the agent-service wire contract, against the deployed service.
 *
 * Skipped unless FIDDY_LIVE_AGENT_SERVICE=1, because it is the only suite here
 * that talks to a host we do not control. It asserts the shapes the client
 * depends on — a 401 code it can show, the public Hermes catalog counts — not
 * that any particular agent exists, since no test should create one.
 *
 *   FIDDY_LIVE_AGENT_SERVICE=1 npx vitest run src/lib/__tests__/live.agentService.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  AgentServiceError,
  DEFAULT_AGENT_SERVICE_URL,
  fetchHermesCatalog,
  listAgents,
  normaliseServiceUrl,
} from '~/lib/agentService';

const enabled = process.env.FIDDY_LIVE_AGENT_SERVICE === '1';
const describeLive = enabled ? describe : describe.skip;

const session = {
  baseUrl: normaliseServiceUrl(DEFAULT_AGENT_SERVICE_URL) as string,
  // A token that is well-formed but not authorised: the point is to see the
  // service's own refusal, not to touch anyone's agents.
  token: 'live-probe-token-not-authorized',
};

describeLive('live agent service', () => {
  it('answers the client list call with the documented auth refusal', async () => {
    let caught: unknown;
    try {
      await listAgents(session);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentServiceError);
    const error = caught as AgentServiceError;
    expect(['AUTH_REQUIRED', 'INVALID_AUTH_TOKEN']).toContain(error.code);
    expect(error.status).toBe(401);
  });

  it('serves the public Hermes catalog with real counts', async () => {
    const catalog = await fetchHermesCatalog();
    expect(catalog.skills).toBeGreaterThan(1000);
    expect(catalog.plugins).toBeGreaterThan(10);
    expect(catalog.examples.length).toBeGreaterThan(0);
  });
});
