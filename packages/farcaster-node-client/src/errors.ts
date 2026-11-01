/**
 * Errors raised by the node client.
 *
 * Every failure that crosses the node HTTP API boundary is a {@link NodeApiError}
 * so callers (and the UI) can render the node's own words instead of a generic
 * "something went wrong".
 */

export interface NodeApiErrorOptions {
  status: number;
  path: string;
  error: string;
  detail?: string;
  body?: string;
}

export class NodeApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly nodeError: string;
  readonly nodeErrorDetail?: string;
  readonly body?: string;

  constructor(options: NodeApiErrorOptions) {
    super(
      options.detail
        ? `${options.error}: ${options.detail}`
        : options.error || `HTTP ${options.status}`,
    );
    this.name = 'NodeApiError';
    this.status = options.status;
    this.path = options.path;
    this.nodeError = options.error;
    this.nodeErrorDetail = options.detail;
    this.body = options.body;
  }

  /** The node has no such endpoint (e.g. a hub build without this route). */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** The node rejected the request body — the caller must change the message. */
  get isBadRequest(): boolean {
    return this.status === 400;
  }
}

export class NodeUnreachableError extends Error {
  readonly baseUrl: string;

  constructor(baseUrl: string, cause: unknown) {
    super(
      `Could not reach the Snapchain node at ${baseUrl}` +
        (cause instanceof Error ? ` (${cause.message})` : ''),
    );
    this.name = 'NodeUnreachableError';
    this.baseUrl = baseUrl;
  }
}

/**
 * A message we asked `@farcaster/core` to build was rejected before it ever hit
 * the wire (bad text length, missing embed, expired deadline, ...).
 */
export class MessageBuildError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'MessageBuildError';
    this.code = code;
  }
}

export const isNodeApiError = (error: unknown): error is NodeApiError =>
  error instanceof NodeApiError;

/**
 * Is this failure the node saying "there is nothing there", rather than "that
 * request was wrong"?
 *
 * Two shapes, both MEASURED (2026-10-21, a public read node and Neynar's node,
 * on a real mainnet state):
 *
 *   - a 404 — the route or the object does not exist;
 *   - a **400 whose detail says `NotFound`** — `/v1/linkById` answers
 *     `status: NotFound, message: "cast not found"` for an edge that is not in
 *     the merged state. A writer testing a state ("has my unfollow landed?")
 *     has to read that as "no", or it would report a request that worked as a
 *     request that failed.
 */
export const isMissingOnNode = (error: unknown): boolean =>
  isNodeApiError(error) &&
  (error.status === 404 ||
    /not.?found/i.test(`${error.nodeError} ${error.nodeErrorDetail ?? ''}`));

export const isNodeUnreachableError = (
  error: unknown,
): error is NodeUnreachableError => error instanceof NodeUnreachableError;
