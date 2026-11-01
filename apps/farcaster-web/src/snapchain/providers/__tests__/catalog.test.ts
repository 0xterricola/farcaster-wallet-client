/**
 * The order rules, as tests.
 *
 * The reader's first choice is their own first choice; the safety net is always
 * last; nothing is listed twice; and a server they never chose does not sneak in
 * ahead of one they did.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultProviderOrder,
  FARCASTER_PUBLIC_PROVIDER_ID,
  farcasterPublicProvider,
  NEYNAR_PROVIDER_ID,
  ownNodeProvider,
  resolveProviderOrder,
} from '~/snapchain/providers/catalog';

describe('resolveProviderOrder', () => {
  it('starts with the server the reader picked', () => {
    const order = resolveProviderOrder({
      chosen: { kind: 'own', url: 'https://mine.example' },
      storedIds: [],
      neynarConfigured: false,
    });
    expect(order[0]!.id).toBe('snapchain:https://mine.example');
    expect(order[0]!.source).toBe('own');
    expect(order[0]!.label).toBe('The node you run');
  });

  it('calls a picked public server a public one, not the reader’s own', () => {
    const order = resolveProviderOrder({
      chosen: { kind: 'public', url: 'https://haatz.quilibrium.com' },
      storedIds: [],
      neynarConfigured: false,
    });
    expect(order[0]!.source).toBe('public');
  });

  it('keeps the safety net last, always', () => {
    const order = resolveProviderOrder({
      chosen: { kind: 'own', url: 'https://mine.example' },
      storedIds: [
        FARCASTER_PUBLIC_PROVIDER_ID,
        'snapchain:https://spare.example',
      ],
      neynarConfigured: false,
    });
    expect(order[order.length - 1]!.id).toBe(FARCASTER_PUBLIC_PROVIDER_ID);
  });

  it('keeps Fiddy’s own relay behind the reader’s choices, as a backup', () => {
    const order = resolveProviderOrder({
      chosen: { kind: 'own', url: 'https://mine.example' },
      storedIds: [],
      neynarConfigured: false,
    });
    const ids = order.map((provider) => provider.id);
    expect(ids).toEqual([
      'snapchain:https://mine.example',
      'snapchain:https://haatz.quilibrium.com',
      FARCASTER_PUBLIC_PROVIDER_ID,
    ]);
  });

  it('never lists the same server twice', () => {
    const order = resolveProviderOrder({
      chosen: { kind: 'own', url: 'https://mine.example/' },
      storedIds: [
        'snapchain:https://mine.example',
        'snapchain:https://mine.example',
      ],
      neynarConfigured: false,
    });
    const ids = order.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops stored ids that name nothing this build can reach', () => {
    const order = resolveProviderOrder({
      chosen: null,
      storedIds: [
        'snapchain:not-a-url',
        'nonsense',
        'snapchain:https://good.example',
      ],
      neynarConfigured: false,
    });
    const ids = order.map((provider) => provider.id);
    expect(ids).toContain('snapchain:https://good.example');
    expect(ids).not.toContain('nonsense');
  });

  it('only lists Neynar when a key is configured', () => {
    const withoutKey = resolveProviderOrder({
      chosen: null,
      storedIds: [NEYNAR_PROVIDER_ID],
      neynarConfigured: false,
    });
    expect(withoutKey.map((provider) => provider.id)).not.toContain(
      NEYNAR_PROVIDER_ID,
    );

    const withKey = resolveProviderOrder({
      chosen: null,
      storedIds: [NEYNAR_PROVIDER_ID],
      neynarConfigured: true,
    });
    expect(withKey[0]!.id).toBe(NEYNAR_PROVIDER_ID);
  });

  it('falls back to Fiddy’s public relay when the reader has chosen nothing', () => {
    const order = resolveProviderOrder({
      chosen: null,
      storedIds: [],
      neynarConfigured: false,
    });
    expect(order[0]!.baseUrl).toContain('haatz.quilibrium.com');
    expect(order[0]!.source).toBe('public');
  });
});

describe('the default order, with the reader’s own Neynar key', () => {
  it('starts on Neynar when a key exists, and on the relay when it does not', () => {
    // The reader's direction (2026-10-21): the server that both reads and writes
    // is the one the signed-in client starts on.
    expect(
      resolveProviderOrder({
        chosen: null,
        storedIds: [],
        neynarConfigured: true,
      })[0]?.kind,
    ).toBe('neynar');
    expect(
      resolveProviderOrder({
        chosen: null,
        storedIds: [],
        neynarConfigured: false,
      })[0]?.kind,
    ).toBe('snapchain');
  });

  it('still lets an explicit choice keep the first place, with Neynar behind it', () => {
    const order = resolveProviderOrder({
      chosen: { kind: 'own', url: 'https://mine.example' },
      storedIds: [],
      neynarConfigured: true,
    });
    expect(order[0]?.id).toBe('snapchain:https://mine.example');
    expect(order.map((provider) => provider.id)).toContain('neynar');
    expect(order.at(-1)?.id).toBe('farcaster-public');
  });
});

describe('defaultProviderOrder', () => {
  it('is the relay we read from today, then the safety net', () => {
    const order = defaultProviderOrder();
    expect(order[0]!.baseUrl).toContain('haatz.quilibrium.com');
    expect(order[order.length - 1]!.id).toBe(FARCASTER_PUBLIC_PROVIDER_ID);
  });
});

describe('provider descriptors tell the truth about themselves', () => {
  it('marks Farcaster’s own public server read-only, with its limits stated', () => {
    const provider = farcasterPublicProvider();
    expect(provider.readOnly).toBe(true);
    expect(provider.detail).toContain('cannot say how far behind');
  });

  it('normalizes trailing slashes so one server is one provider', () => {
    expect(ownNodeProvider('https://mine.example/').id).toBe(
      ownNodeProvider('https://mine.example').id,
    );
  });
});
