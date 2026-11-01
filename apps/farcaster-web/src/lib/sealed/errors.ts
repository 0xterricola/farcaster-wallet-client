/**
 * The one error type the sealed-cast modules throw.
 *
 * A sealed cast fails in a handful of ways that a reader can be told about in
 * plain words — the text is not sealed text, the key is not a key, the message
 * does not fit in a cast — and none of them should ever surface as a raw
 * WebCrypto `OperationError`. `reason` is written for a person, and the surfaces
 * show it as-is.
 */
export class SealedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'SealedError';
    this.reason = reason;
  }
}

export const sealedProblem = (reason: string): SealedError =>
  new SealedError(reason);
