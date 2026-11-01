// @vitest-environment jsdom
/**
 * The connect module, driven by a fake service: what it reports, and what it
 * refuses to report.
 *
 * The rules these tests hold the module to are the ones that matter to a
 * person: it never says "connected" unless the service did, it never writes as
 * one account for another, every failure arrives as a sentence — and it never
 * adopts an identity the person did not prove. The two facts that decide whose
 * connection this is are the sign-in proof it hands over with the request, and
 * the label that says this tab is the one that asked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canWriteThroughConnect,
  connectStatus,
  forgetConnectAttempt,
  forgetRememberedConnect,
  rememberConnectStatus,
  startConnect,
  stopConnect,
  writeThroughConnect,
} from '~/snapchain/accounts/managedConnect';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fakeFetch = (
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) =>
  vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );

beforeEach(() => {
  forgetRememberedConnect();
  forgetConnectAttempt();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managedConnect', () => {
  it('asks the service what is true, and reads only what it knows', async () => {
    const fetchImpl = fakeFetch(async () =>
      json({ ok: true, state: 'connected', fid: 4242, username: 'someone' }),
    );
    await expect(
      connectStatus({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
      forFid: null,
      refused: null,
      // fiddy.fun never hands the key to the browser; only an instance does.
      postingKey: null,
      // No request was made from this tab, so this answer is not its own.
      startedHere: false,
    });
  });

  it('adopts a posting key only from a connected answer, and only a real one', async () => {
    const key = `0x${'ab'.repeat(32)}`;
    const fetchImpl = fakeFetch(async (url, init) => {
      void url;
      void init;
      return json({
        ok: true,
        state: 'connected',
        fid: 4242,
        username: 'someone',
        postingKey: key,
      });
    });
    await expect(
      connectStatus({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toMatchObject({ state: 'connected', postingKey: key });

    // A key offered with anything but a completed connection, or in a shape this
    // client cannot sign with, is not a key: it reads as null so no screen and no
    // writer can mistake it for one.
    for (const payload of [
      { state: 'waiting', postingKey: key },
      { state: 'connected', postingKey: 'not-a-key' },
      { state: 'connected', postingKey: `0x${'ab'.repeat(31)}` },
      { state: 'connected', postingKey: 42 },
    ]) {
      const answer = fakeFetch(async () => json({ ok: true, ...payload }));
      await expect(
        connectStatus({ fetchImpl: answer as unknown as typeof fetch }),
      ).resolves.toMatchObject({ postingKey: null });
    }
  });

  it('reads an answer it does not recognise as unknown, never as connected', async () => {
    for (const payload of [
      { state: 'approved' },
      { state: 'ok' },
      {},
      null,
      'connected',
    ]) {
      const fetchImpl = fakeFetch(async () => json(payload));
      const status = await connectStatus({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(status.state).toBe('unknown');
      expect(status.fid).toBeNull();
    }
  });

  it('starts a connection and hands back the link to open', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('/api/fiddy/connect');
      expect(init?.method).toBe('POST');
      // The handle is in an HttpOnly cookie, so the request must be same-origin.
      expect(init?.credentials).toBe('same-origin');
      return json({
        ok: true,
        state: 'waiting',
        approvalUrl: 'https://warpcast.com/~/add-signer?signer_uuid=x',
        reused: false,
      });
    });

    const started = await startConnect({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(started.reused).toBe(false);
    expect(started.status.state).toBe('waiting');
    expect(started.status.approvalUrl).toBe(
      'https://warpcast.com/~/add-signer?signer_uuid=x',
    );
  });

  it('says what the service said when it refuses, in its own words', async () => {
    const fetchImpl = fakeFetch(async () =>
      json(
        {
          ok: false,
          code: 'CONNECT_NOT_SET_UP',
          message: 'connecting an account is not switched on here yet.',
        },
        501,
      ),
    );
    await expect(
      startConnect({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      code: 'CONNECT_NOT_SET_UP',
      status: 501,
      message: 'connecting an account is not switched on here yet.',
    });
  });

  it('answers an unreachable service with a sentence, not a crash', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      connectStatus({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      code: 'CONNECT_UNREACHABLE',
    });
    // A writer that cannot ask must answer "no", so the caller falls back to
    // the device's own key rather than pretending a write went somewhere.
    await expect(canWriteThroughConnect(4242)).resolves.toBe(false);
  });

  it('only lets a write through for the account the connection belongs to', async () => {
    rememberConnectStatus({
      state: 'connected',
      approvalUrl: null,
      fid: 4242,
      username: 'someone',
      forFid: null,
      refused: null,
      postingKey: null,
      startedHere: true,
    });
    await expect(canWriteThroughConnect(4242)).resolves.toBe(true);
    // A different account signed in on this device must not write as that one.
    await expect(canWriteThroughConnect(9999)).resolves.toBe(false);
    await expect(canWriteThroughConnect(undefined)).resolves.toBe(false);
  });

  it('hands a cast over with its text, and brings the hash back', async () => {
    const fetchImpl = fakeFetch(async (url, init) => {
      expect(url).toBe('/api/fiddy/connect/write');
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: 'cast',
        text: 'hello',
        embeds: [],
      });
      return json({ ok: true, kind: 'cast', hash: '0xabc' });
    });
    await expect(
      writeThroughConnect(
        { kind: 'cast', text: 'hello', embeds: [] },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).resolves.toEqual({ ok: true, hash: '0xabc' });
  });

  it('turns it off, and takes the service’s answer for the state', async () => {
    const fetchImpl = fakeFetch(async (_url, init) => {
      expect(init?.method).toBe('DELETE');
      return json({ ok: true, state: 'revoked' });
    });
    await expect(
      stopConnect({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toMatchObject({
      state: 'revoked',
      approvalUrl: null,
    });
  });

  it('marks the request as this tab’s own, and only recognises its own answer back', async () => {
    let sentAttempt = '';
    const started = await startConnect({
      fetchImpl: fakeFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentAttempt = String(body.attempt);
        expect(sentAttempt.length).toBeGreaterThanOrEqual(8);
        return json({
          ok: true,
          state: 'waiting',
          approvalUrl: 'https://warpcast.com/~/add-signer?signer_uuid=x',
          reused: false,
          attempt: sentAttempt,
        });
      }) as unknown as typeof fetch,
    });
    expect(started.status.startedHere).toBe(true);

    // Another tab's answer (a different label) is not this tab's connection,
    // whatever it says: a shared device must not adopt somebody else's.
    const other = await connectStatus({
      fetchImpl: fakeFetch(async () =>
        json({ ok: true, state: 'connected', fid: 4242, username: 'someone' }),
      ) as unknown as typeof fetch,
    });
    expect(other.startedHere).toBe(false);

    // And the tab's own request, read back later, is recognised.
    const mine = await connectStatus({
      fetchImpl: fakeFetch(async () =>
        json({
          ok: true,
          state: 'connected',
          fid: 4242,
          username: 'someone',
          attempt: sentAttempt,
        }),
      ) as unknown as typeof fetch,
    });
    expect(mine.startedHere).toBe(true);
  });

  it('hands the sign-in proof over with the request, so the connection is for that account', async () => {
    const binding = {
      forFid: 191554,
      proof: {
        message: 'fiddy.fun wants you to sign in with your Ethereum account',
        signature: `0x${'ab'.repeat(65)}`,
        nonce: 'a1b2c3d4',
      },
    };
    const fetchImpl = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.forFid).toBe(191554);
      expect(body.proof).toEqual(binding.proof);
      return json({
        ok: true,
        state: 'waiting',
        approvalUrl: 'https://warpcast.com/~/add-signer?signer_uuid=x',
        reused: false,
        forFid: 191554,
        attempt: body.attempt,
      });
    });
    const started = await startConnect({
      binding,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(started.status.forFid).toBe(191554);
    expect(started.status.startedHere).toBe(true);

    // A request with no proof at all is still made — and is nobody's until
    // somebody approves it — so the body carries no claim about who it is for.
    const bare = await startConnect({
      fetchImpl: fakeFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.forFid).toBeUndefined();
        expect(body.proof).toBeUndefined();
        return json({
          ok: true,
          state: 'waiting',
          approvalUrl: 'https://x.example/a',
          reused: false,
        });
      }) as unknown as typeof fetch,
    });
    expect(bare.status.forFid).toBeNull();
  });

  it('reports a refused approval as wrong_account, with nothing to adopt and nothing to write with', async () => {
    // The service refuses Fiddy's own account, and tells the browser nothing
    // about it: no number, no handle, no connection.
    const fetchImpl = fakeFetch(async () =>
      json({
        ok: true,
        state: 'wrong_account',
        approvalUrl: null,
        fid: null,
        username: null,
        forFid: 191554,
        refused: 'app_account',
      }),
    );
    const status = await connectStatus({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(status).toMatchObject({
      state: 'wrong_account',
      refused: 'app_account',
      fid: null,
      username: null,
      forFid: 191554,
    });

    // A refusal is never a connection: no write may go through it, for anybody.
    rememberConnectStatus(status);
    await expect(canWriteThroughConnect(191554)).resolves.toBe(false);
    await expect(canWriteThroughConnect(3356372)).resolves.toBe(false);
  });
});
