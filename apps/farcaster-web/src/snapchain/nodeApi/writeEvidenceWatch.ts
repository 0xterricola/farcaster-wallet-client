/**
 * The write seam's own evidence, as it happens, for the surfaces that have to
 * read it rather than guess.
 *
 * `~/snapchain/nodeApi/nodeWrites` already records what happened to one write —
 * the message that was signed, whether the server accepted it, and whether that
 * server's own state showed it afterwards — and `nodeBackedFetch` /
 * `providers/providerFetch` already keep it, per request, on the debug request
 * log (`window.__nodeBackedRequests`, off unless a build asks for it). A probe
 * reads it there; a *surface in the app* could not, and one now has to.
 *
 * That surface is the mini app agent bridge's `post` ask
 * (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.3): when the reader presses Cast in
 * Fiddy's own composer, the app is told `posted` only when the seam's evidence
 * says the message landed and the network reads it back, `unknown` when it was
 * accepted and nothing shows it, and `failed` when an attempt did not land. The
 * two cannot be told apart from the composer's own answer, and inventing an
 * answer would be the exact dishonesty the design forbids — so the evidence the
 * seam already produces is handed to whoever is listening.
 *
 * This is a read-only observer: it changes no write's behaviour, holds no
 * request, and keeps nothing after the fact. A listener is called while the
 * write is being answered, so a surface subscribes for as long as it cares and
 * unsubscribes after.
 */

import type { WriteEvidence } from '~/snapchain/nodeApi/nodeWrites';

type WriteEvidenceListener = (evidence: WriteEvidence) => void;

const listeners = new Set<WriteEvidenceListener>();

/**
 * One write's evidence, from the seam. Called on the adapter's own path, so it
 * does nothing beyond handing it on: a listener that throws must not be able to
 * break a write that is already answered.
 */
export const noteWriteEvidence = (evidence: WriteEvidence): void => {
  for (const listener of [...listeners]) {
    try {
      listener(evidence);
    } catch {
      // A surface's own problem, never the write's.
    }
  }
};

/** Watch every write's evidence until the returned function is called. */
export const observeWriteEvidence = (
  listener: WriteEvidenceListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
