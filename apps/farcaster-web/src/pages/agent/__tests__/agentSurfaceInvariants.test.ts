/**
 * Product invariants for the agent surface.
 *
 * These are the two promises the surface makes in copy and must hold in code:
 *   1. provider-neutral naming — the client never names the vendor behind the
 *      agent service, and never mentions a provider credential;
 *   2. no key material in the browser bundle for the agent path — no provider
 *      key is read from the environment, stored, or sent.
 *
 * They are checked by reading the source, because a unit test of behaviour
 * cannot notice a string that quietly reappears in a file nobody calls.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '../../../..');

const SURFACE_FILES = [
  'src/lib/agentService.ts',
  'src/lib/agentSchedules.ts',
  'src/lib/fiddyAgentAutopair.ts',
  'src/hooks/agent/useAgentSession.ts',
  'src/components/agent/AgentCard.tsx',
  'src/components/agent/AgentNavItem.tsx',
  'src/pages/agent/AgentPage.tsx',
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return walk(full);
    }
    return full.endsWith('.tsx') || full.endsWith('.ts') ? [full] : [];
  });

const surfaceFiles = [
  ...SURFACE_FILES.map((file) => path.join(webRoot, file)),
  ...walk(path.join(webRoot, 'src/pages/agent/Component')),
];

const source = surfaceFiles.map(
  (file) => `${path.relative(webRoot, file)}\n${readFileSync(file, 'utf8')}`,
);

describe('agent surface invariants', () => {
  it('covers the whole surface, not just a couple of files', () => {
    expect(surfaceFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('names no model provider anywhere in the surface', () => {
    const forbidden = [/agent37/i, /anthropic/i, /openai/i, /X-Agent37-Key/i];
    for (const text of source) {
      for (const pattern of forbidden) {
        expect(text).not.toMatch(pattern);
      }
    }
  });

  it('reads no provider credential from the environment', () => {
    for (const text of source) {
      expect(text).not.toMatch(/API_KEY/);
      expect(text).not.toMatch(/startup_credits|api_secret/i);
    }
  });
});
