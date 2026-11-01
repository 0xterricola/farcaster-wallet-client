/**
 * The write seam's evidence, handed to whoever in the app has to read it.
 *
 * The mini app agent bridge's `post` ask is told `posted` / `unknown` /
 * `failed` from exactly this (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.3), and
 * the states that separate "it landed" from "the network took it and nothing
 * shows it" cannot be told apart from the composer's own answer. So the seam's
 * evidence is handed on, unchanged, and this pins that it is: read-only, no
 * write's behaviour, and a surface's own failure is never allowed to break a
 * write that has already been answered.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  noteWriteEvidence,
  observeWriteEvidence,
} from '~/snapchain/nodeApi/writeEvidenceWatch';

const EVIDENCE = {
  node: 'your node',
  nodeBaseUrl: 'https://mine.example',
  messageHash: '0xabc',
  accepted: true,
  landed: true,
};

describe('the write seam’s evidence, watched', () => {
  it('hands one write’s evidence to every watcher', () => {
    const one = vi.fn();
    const two = vi.fn();
    const stopOne = observeWriteEvidence(one);
    const stopTwo = observeWriteEvidence(two);

    noteWriteEvidence(EVIDENCE);

    expect(one).toHaveBeenCalledWith(EVIDENCE);
    expect(two).toHaveBeenCalledWith(EVIDENCE);

    stopOne();
    stopTwo();
  });

  it('stops when the watcher is done', () => {
    const seen = vi.fn();
    const stop = observeWriteEvidence(seen);

    stop();
    noteWriteEvidence(EVIDENCE);

    expect(seen).not.toHaveBeenCalled();
  });

  it('never lets a watcher’s own failure break the write it is reading', () => {
    const broken = vi.fn(() => {
      throw new Error('this surface is having a bad day');
    });
    const healthy = vi.fn();
    const stopBroken = observeWriteEvidence(broken);
    const stopHealthy = observeWriteEvidence(healthy);

    expect(() => noteWriteEvidence(EVIDENCE)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(EVIDENCE);

    stopBroken();
    stopHealthy();
  });

  it('keeps nothing: a watcher that arrives late hears nothing about the past', () => {
    noteWriteEvidence(EVIDENCE);

    const late = vi.fn();
    const stop = observeWriteEvidence(late);
    expect(late).not.toHaveBeenCalled();

    stop();
  });
});
