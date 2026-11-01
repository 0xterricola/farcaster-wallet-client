import { isHandledFetchError } from 'farcaster-client-data';

/**
 * What the node adapter said when it could not serve a read.
 *
 * `~/snapchain/nodeApi/nodeBackedFetch` answers in the hosted API's own error
 * envelope, so the client turns its answers into `HandledFetchError`s carrying
 * the adapter's sentence in `responseData.errors[0].message`:
 *
 *   `501` — your node cannot answer this read at all. `hostedRoutes` says which
 *           requests those are (search, ranking, channel directories, direct
 *           messages) and writes the sentence for each. MEASURED: nothing else
 *           in this client answers 501 — the hosted API uses 400/401/403/404/
 *           429/500 — so a 501 here is always the adapter saying "not mine".
 *   `502` — your node was asked and did not answer (down, unreachable, or
 *           answering with something unreadable).
 *
 * A surface that lands on one of these can say so where it sits, instead of a
 * generic "error retrieving data, try again" for a read a retry cannot fix —
 * and instead of an empty list, which reads as "there is nothing here".
 */
export interface NodeCannotAnswer {
  /** The adapter's own sentence, as the user should read it. */
  message: string;
  /** `true` only when a retry could change the outcome (the node was down). */
  retryable: boolean;
}

/** The status the adapter uses for "your node cannot answer this". */
export const NODE_CANNOT_ANSWER_STATUS = 501;
/** The status it uses for "your node did not answer". */
export const NODE_DID_NOT_ANSWER_STATUS = 502;

export const nodeCannotAnswer = (
  error: unknown,
): NodeCannotAnswer | undefined => {
  if (!isHandledFetchError(error)) {
    return undefined;
  }
  const status = error.status;
  if (
    status !== NODE_CANNOT_ANSWER_STATUS &&
    status !== NODE_DID_NOT_ANSWER_STATUS
  ) {
    return undefined;
  }

  const body = error.responseData?.errors?.[0] as
    | { message?: unknown }
    | undefined;
  const message = body?.message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    return undefined;
  }

  return {
    message: message.trim(),
    retryable: status === NODE_DID_NOT_ANSWER_STATUS,
  };
};

/**
 * The adapter's sentence as a sentence: the ones it writes are clauses ("a read
 * node keeps no search index"), so a surface showing one stands it up on its own
 * line with a capital and a full stop.
 */
export const asSentence = (clause: string): string => {
  const trimmed = clause.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
};
