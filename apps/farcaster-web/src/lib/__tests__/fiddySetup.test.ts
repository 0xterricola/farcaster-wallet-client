// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import {
  allowedChannelCount,
  DEFAULT_AGENT_NAME,
  defaultFiddySetup,
  loadFiddySetup,
  resetFiddySetup,
  saveFiddySetup,
} from '~/lib/fiddySetup';

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  resetFiddySetup();
});

describe('fiddySetup', () => {
  it('starts with Farcaster allowed and nothing else', () => {
    const setup = loadFiddySetup();
    expect(setup.agentName).toBe(DEFAULT_AGENT_NAME);
    expect(setup.brain).toBe('fiddy');
    expect(setup.completedAt).toBeNull();
    expect(allowedChannelCount(setup)).toBe(1);
    expect(setup.channels.farcaster).toBe(true);
    expect(setup.channels.whatsapp).toBe(false);
  });

  it('keeps answers across a save and a reload', () => {
    saveFiddySetup({
      agentName: 'Sprout',
      brain: 'custom',
      brainServiceUrl: 'https://api.example.com/v1',
      brainModel: 'my-model',
      channels: { ...defaultFiddySetup().channels, telegram: true },
    });

    const setup = loadFiddySetup();
    expect(setup.agentName).toBe('Sprout');
    expect(setup.brain).toBe('custom');
    expect(setup.brainServiceUrl).toBe('https://api.example.com/v1');
    expect(setup.brainModel).toBe('my-model');
    expect(allowedChannelCount(setup)).toBe(2);
    expect(setup.channels.telegram).toBe(true);
  });

  it('merges a patch instead of replacing what was already answered', () => {
    saveFiddySetup({ agentName: 'Sprout' });
    saveFiddySetup({ brain: 'google' });
    expect(loadFiddySetup().agentName).toBe('Sprout');
    expect(loadFiddySetup().brain).toBe('google');
  });

  it('falls back to defaults on garbage instead of throwing', () => {
    window.localStorage.setItem(
      'fiddy.setup',
      '{"agentName":42,"brain":"gpt9"',
    );
    expect(loadFiddySetup().agentName).toBe(DEFAULT_AGENT_NAME);
    expect(loadFiddySetup().brain).toBe('fiddy');
  });

  it('ignores unknown channel keys from a future or older build', () => {
    window.localStorage.setItem(
      'fiddy.setup',
      JSON.stringify({
        agentName: 'Sprout',
        channels: { farcaster: true, myspace: true, email: 'yes' },
      }),
    );
    const setup = loadFiddySetup();
    expect(setup.channels).not.toHaveProperty('myspace');
    // A non-boolean is not a permission.
    expect(setup.channels.email).toBe(false);
  });

  it('never stores a credential: only an address and a model name survive a save', () => {
    saveFiddySetup({
      brain: 'custom',
      brainServiceUrl: 'https://api.example.com/v1',
      brainModel: 'my-model',
      // A key is not part of the setup, and passing one must not smuggle it in.
      key: 'sk-owner-secret-9f3a1c',
    } as never);
    const raw = window.localStorage.getItem('fiddy.setup') ?? '';
    expect(raw).toContain('https://api.example.com/v1');
    expect(raw).toContain('my-model');
    expect(raw.toLowerCase()).not.toContain('token');
    expect(raw.toLowerCase()).not.toContain('key');
    expect(raw).not.toContain('sk-owner-secret-9f3a1c');
  });

  it("carries an older build's answers forward instead of resetting them", () => {
    // 'claude', 'gemini' and 'other' were the same choices under other names.
    for (const [stored, expected] of [
      ['claude', 'anthropic'],
      ['gemini', 'google'],
      ['other', 'custom'],
    ] as const) {
      window.localStorage.setItem(
        'fiddy.setup',
        JSON.stringify({ brain: stored }),
      );
      expect(loadFiddySetup().brain).toBe(expected);
    }
  });

  it('refuses to put a model name back into a field when it does not look like one', () => {
    window.localStorage.setItem(
      'fiddy.setup',
      JSON.stringify({ brain: 'custom', brainModel: 'model; rm -rf /' }),
    );
    expect(loadFiddySetup().brainModel).toBeNull();
  });

  it('keeps Surp as Surp across a reload, rather than falling back to the built-in brain', () => {
    // asBrain() coerces anything it does not know to 'fiddy', so an id missing
    // from BRAIN_IDS is an option that silently disappears on the next load.
    saveFiddySetup({ brain: 'surp', brainModel: 'surp/value' });
    const setup = loadFiddySetup();
    expect(setup.brain).toBe('surp');
    expect(setup.brainModel).toBe('surp/value');
    expect(setup.brainServiceUrl).toBeNull();
  });

  it('keeps the wallet choice across a reload, and refuses one it does not know', () => {
    // The wallet home reads this back to say which wallet pays; a field the
    // whitelist drops would leave the choice reverting on every reload.
    saveFiddySetup({ walletChoice: 'fresh' });
    expect(loadFiddySetup().walletChoice).toBe('fresh');
    saveFiddySetup({ agentName: 'Sprout' });
    expect(loadFiddySetup()).toMatchObject({
      walletChoice: 'fresh',
      agentName: 'Sprout',
    });
    saveFiddySetup({ walletChoice: 'farcaster' });
    expect(loadFiddySetup().walletChoice).toBe('farcaster');

    // Two named options, and nothing else: an unknown value is not a third one.
    saveFiddySetup({ walletChoice: 'someone-elses' as never });
    expect(loadFiddySetup().walletChoice).toBe('farcaster');
  });
});
