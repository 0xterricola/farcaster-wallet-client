// @vitest-environment node
/**
 * The store the write seam asks, as tests.
 *
 * What matters here is the contract the writer depends on and the screen
 * renders: one write in front of the person at a time, a decision that ends the
 * wait, the carried write's *own* answer passed through untouched, and a
 * deadline so a request cannot hang forever when nobody answers the phone.
 *
 * It is React-free on purpose (`getState`/`subscribe` are the two things
 * `useSyncExternalStore` wants), so none of this needs a browser.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createPostingKeyApproval,
  type PostingKeyApprovalState,
} from '~/snapchain/accounts/postingKeyApproval';
import type { WriteApprovalRequest } from '~/snapchain/nodeApi/nodeWrites';

const carried = (status = 200): Response =>
  new Response(JSON.stringify({ ok: true }), { status });

const request = (
  overrides: Partial<WriteApprovalRequest> = {},
): WriteApprovalRequest => ({
  fid: 3,
  label: 'like',
  carry: vi.fn(async () => carried()),
  ...overrides,
});

/** Let every already-resolved promise chain settle (no fake timers needed). */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('the posting-key approval', () => {
  it('puts the write in front of the person, and carries it once approved', async () => {
    const approval = createPostingKeyApproval();
    const seen: PostingKeyApprovalState[] = [];
    approval.subscribe(() => seen.push(approval.getState()));

    const write = request();
    const answer = approval.ask(write);

    expect(approval.getState()).toEqual({
      phase: 'asking',
      pending: { fid: 3, label: 'like' },
    });

    approval.approved();
    const response = await answer;

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(200);
    expect(write.carry).toHaveBeenCalledTimes(1);
    expect(approval.getState()).toEqual({ phase: 'idle', pending: null });
    // The screen was told, at least: asking, finishing, gone.
    expect(seen.map((state) => state.phase)).toEqual([
      'asking',
      'finishing',
      'idle',
    ]);
  });

  it('answers nothing, and carries nothing, when the person says not now', async () => {
    const approval = createPostingKeyApproval();
    const write = request();
    const answer = approval.ask(write);

    approval.declined();

    expect(await answer).toBeNull();
    expect(write.carry).not.toHaveBeenCalled();
    expect(approval.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it('holds one write in front of the person, and lets a second join the same tap', async () => {
    const approval = createPostingKeyApproval();
    const first = request();
    const second = request({
      label: 'follow',
      carry: vi.fn(async () => carried()),
    });

    const one = approval.ask(first);
    const two = approval.ask(second);

    // One screen, and it names the write that got there first.
    expect(approval.getState().pending).toEqual({ fid: 3, label: 'like' });

    approval.approved();

    expect((await one)?.status).toBe(200);
    expect((await two)?.status).toBe(200);
    expect(first.carry).toHaveBeenCalledTimes(1);
    expect(second.carry).toHaveBeenCalledTimes(1);
  });

  it('ends the wait on its own when nobody answers, rather than hanging a request', async () => {
    const approval = createPostingKeyApproval({ deadlineMs: 20 });
    const write = request();

    const answer = approval.ask(write);

    expect(await answer).toBeNull();
    expect(write.carry).not.toHaveBeenCalled();
    expect(approval.getState()).toEqual({ phase: 'idle', pending: null });
  });

  it('passes the carried write’s own answer through, refusals included', async () => {
    const approval = createPostingKeyApproval();
    const refused = new Response('{"errors":[{"message":"no"}]}', {
      status: 502,
    });
    const write = request({ carry: vi.fn(async () => refused) });

    const answer = approval.ask(write);
    approval.approved();

    expect(await answer).toBe(refused);
    expect(
      ((await refused.json()) as { errors: { message: string }[] }).errors[0]!
        .message,
    ).toBe('no');
  });

  it('survives a decision with nothing waiting', async () => {
    const approval = createPostingKeyApproval();
    approval.approved();
    approval.declined();
    expect(approval.getState()).toEqual({ phase: 'idle', pending: null });
    await settle();
  });
});
