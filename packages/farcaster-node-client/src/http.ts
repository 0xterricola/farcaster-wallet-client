/**
 * HTTP client for a Snapchain read node.
 *
 * A read node serves the same `/v1/*` surface as a hub: reads are GETs with
 * query params and JSON answers, and the one write path is
 * `POST /v1/submitMessage` — binary protobuf, `application/octet-stream`, JSON
 * back. The node relays accepted messages to validators over gossip; it has no
 * mempool of its own, so a 200 means "accepted for relay", and the client
 * confirms inclusion by querying the message back (`confirmCast`).
 *
 * Nothing here imports node internals: the HTTP API is the whole seam.
 */

import { type Message } from '@farcaster/core';

import { NodeApiError, NodeUnreachableError } from './errors';
import type {
  NodeHealth,
  NodeInfo,
  NodeMessage,
  NodeMessagesPage,
  NodeOnChainSignersPage,
  NodeSigner,
  NodeSignersPage,
  NodeStorageLimits,
  ReactionTypeQuery,
} from './types';
import {
  buildQuery,
  decodeInfo,
  decodeMessageBytes,
  decodeMessagesPage,
  decodeSigner,
  decodeSignersPage,
  decodeStorageLimits,
  encodeMessage,
} from './wire';

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json?(): Promise<unknown>;
}>;

export interface SnapchainNodeClientOptions {
  /**
   * Base URL of the node, e.g. `http://127.0.0.1:3381` (SSH tunnel) or the
   * same-origin `/snapchain-api` relay path the web client uses in the browser.
   */
  baseUrl: string;
  /** Injected for tests; defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout. Node reads are fast; sync-heavy reads get more room. */
  timeoutMs?: number;
  /** Extra headers (e.g. a private node's basic auth). */
  headers?: Record<string, string>;
}

export interface PageOptions {
  pageSize?: number;
  pageToken?: string;
  reverse?: boolean;
}

export interface FidPageOptions extends PageOptions {
  fid: number;
}

const DEFAULT_TIMEOUT_MS = 20000;

export class SnapchainNodeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: SnapchainNodeClientOptions) {
    if (!options.baseUrl) {
      throw new Error('SnapchainNodeClient requires a baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const globalFetch = (globalThis as { fetch?: unknown }).fetch as
      | FetchLike
      | undefined;
    const fetchImpl = options.fetch ?? globalFetch;
    if (!fetchImpl) {
      throw new Error('No fetch implementation available — pass options.fetch');
    }
    // THE GLOBAL IS BOUND, AN INJECTED ONE IS NOT. A browser's `fetch` is a
    // method of `Window`: held on this instance and called as
    // `this.fetchImpl(...)`, it answers "Failed to execute 'fetch' on 'Window':
    // Illegal invocation" — MEASURED 2026-10-23 in the client's own social
    // sign-up probe, where the account flow's node reads never left the page
    // (`useNodeClient` builds a client exactly this way). Node's fetch tolerates
    // the receiver, which is why this was only ever visible in a browser. An
    // injected fetch is the caller's own function and is handed on untouched.
    this.fetchImpl = options.fetch ? options.fetch : fetchImpl.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = options.headers ?? {};
  }

  // --- transport ----------------------------------------------------------

  private async request(
    path: string,
    init: {
      method?: string;
      body?: Uint8Array;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? this.timeoutMs,
    );
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...this.headers,
          ...init.headers,
        },
        body: init.body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new NodeUnreachableError(this.baseUrl, error);
    } finally {
      clearTimeout(timeout);
    }

    const body = await response.text();

    if (!response.ok) {
      throw toNodeApiError({ path, status: response.status, body });
    }

    if (body.length === 0) {
      return {};
    }

    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new NodeApiError({
        status: response.status,
        path,
        error: 'Node returned a non-JSON response',
        body: body.slice(0, 500),
      });
    }
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    decode: (value: unknown) => T,
    timeoutMs?: number,
  ): Promise<T> {
    return decode(
      await this.request(`${path}${buildQuery(params)}`, { timeoutMs }),
    );
  }

  // --- reads --------------------------------------------------------------

  /** `/v1/info` — version, shards, and sync height. */
  async info(): Promise<NodeInfo> {
    return this.get('/v1/info', {}, decodeInfo);
  }

  /** Liveness + latency + info, for the client's node-health badge. */
  async health(): Promise<NodeHealth> {
    const startedAt = Date.now();
    try {
      const info = await this.get('/v1/info', {}, decodeInfo, 6000);
      return {
        ok: true,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - startedAt,
        info,
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async castsByFid(options: FidPageOptions): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/castsByFid',
      {
        fid: options.fid,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  async castById(options: { fid: number; hash: string }): Promise<NodeMessage> {
    return decodeNodeMessageSafe(
      await this.request(
        `/v1/castById${buildQuery({ fid: options.fid, hash: options.hash })}`,
      ),
    );
  }

  async castsByParent(options: {
    fid?: number;
    hash?: string;
    url?: string;
    pageSize?: number;
    pageToken?: string;
    reverse?: boolean;
  }): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/castsByParent',
      {
        fid: options.fid,
        hash: options.hash,
        url: options.url,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  async castsByMention(options: FidPageOptions): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/castsByMention',
      {
        fid: options.fid,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  async userDataByFid(options: FidPageOptions): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/userDataByFid',
      {
        fid: options.fid,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  async linksByFid(
    options: FidPageOptions & { linkType?: string },
  ): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/linksByFid',
      {
        fid: options.fid,
        link_type: options.linkType,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  /**
   * `GET /v1/linkById` — one follow (or other link) edge, and the cheapest way
   * to ask "does this account follow that one?".
   *
   * The node answers with the edge only while the ADD is the account's latest
   * message for that target: after a `LINK_REMOVE` merges, this route answers
   * 400 with `NotFound` in its detail rather than an empty 200. MEASURED
   * (2026-10-21, both a public read node and Neynar's node):
   *
   *   200 {"data":{"type":"MESSAGE_TYPE_LINK_ADD","fid":3,…}}   for a real edge
   *   400 {"error":"Failed to get link",
   *        "error_detail":"status: NotFound, message: \"cast not found\""}
   *
   * A caller that is testing a state ("has my follow landed?") has to read the
   * 400 as "no", not as a failed request — see `isNotFound` in errors.ts.
   */
  async linkById(
    options: {
      fid: number;
      targetFid: number;
      linkType?: string;
    },
  ): Promise<NodeMessage> {
    const json = await this.request(
      `/v1/linkById${buildQuery({
        fid: options.fid,
        target_fid: options.targetFid,
        link_type: options.linkType,
      })}`,
    );
    return decodeNodeMessageSafe(json);
  }

  async linksByTargetFid(
    options: { targetFid: number; linkType?: string } & PageOptions,
  ): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/linksByTargetFid',
      {
        target_fid: options.targetFid,
        link_type: options.linkType,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  /**
   * Reactions authored by a FID. `reaction_type` is mandatory on this route and
   * takes the node's Rust variant name (`Like`), not the proto name.
   */
  async reactionsByFid(
    options: FidPageOptions & { reactionType: ReactionTypeQuery },
  ): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/reactionsByFid',
      {
        fid: options.fid,
        reaction_type: options.reactionType,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  /** Reactions on one cast — the "who liked this" read. */
  async reactionsByCast(
    options: {
      targetFid: number;
      targetHash: string;
      reactionType?: ReactionTypeQuery;
    } & PageOptions,
  ): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/reactionsByCast',
      {
        target_fid: options.targetFid,
        target_hash: options.targetHash,
        reaction_type: options.reactionType,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  /** Reactions on a URL (channel / long-cast) target. */
  async reactionsByUrl(
    options: { url: string; reactionType?: ReactionTypeQuery } & PageOptions,
  ): Promise<NodeMessagesPage> {
    return this.get(
      '/v1/reactionsByTarget',
      {
        url: options.url,
        reaction_type: options.reactionType,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeMessagesPage,
    );
  }

  /** One signer record — how a cast's `signer` field is identified. */
  async signer(options: { fid: number; signer: string }): Promise<NodeSigner> {
    const json = await this.request(
      `/v1/signer${buildQuery({ fid: options.fid, signer: options.signer })}`,
    );
    const record = (json as { signer?: unknown }).signer;
    if (!record) {
      throw new NodeApiError({
        status: 404,
        path: '/v1/signer',
        error: 'Signer not found',
      });
    }
    return decodeSigner(record);
  }

  /**
   * Every signer for a FID, with the FID's current user nonce (what a gasless
   * `KEY_ADD` must exceed) and the gasless-key quota.
   */
  async signersByFid(options: FidPageOptions): Promise<NodeSignersPage> {
    return this.get(
      '/v1/signersByFid',
      {
        fid: options.fid,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      },
      decodeSignersPage,
    );
  }

  async onChainSignersByFid(
    options: FidPageOptions,
  ): Promise<NodeOnChainSignersPage> {
    const json = await this.request(
      `/v1/onChainSignersByFid${buildQuery({
        fid: options.fid,
        pageSize: options.pageSize,
        pageToken: options.pageToken,
        reverse: options.reverse,
      })}`,
    );
    const page = json as { events?: unknown[]; nextPageToken?: string };
    return {
      // On-chain signer events, not messages; surfaced raw for the UI's
      // "on-chain keys" list.
      events: Array.isArray(page.events) ? page.events : [],
      nextPageToken: page.nextPageToken,
    };
  }

  async storageLimitsByFid(fid: number): Promise<NodeStorageLimits> {
    return this.get('/v1/storageLimitsByFid', { fid }, decodeStorageLimits);
  }

  async userNameProofByName(name: string): Promise<unknown> {
    return this.request(`/v1/userNameProofByName${buildQuery({ name })}`);
  }

  // --- writes -------------------------------------------------------------

  /**
   * `POST /v1/submitMessage`. The node requires exactly
   * `Content-Type: application/octet-stream` with a binary protobuf body; a
   * JSON body is rejected with a 400 before it is even parsed.
   *
   * On success the node echoes the message it accepted — that echo is the
   * closest thing a read node gives you to an ack, and it is not a block
   * inclusion. Confirm with `confirmMessage`.
   */
  async submitMessage(message: Message | Uint8Array): Promise<NodeMessage> {
    const bytes =
      message instanceof Uint8Array ? message : encodeMessage(message);
    const json = await this.request('/v1/submitMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    return decodeNodeMessageSafe(json);
  }

  /** `POST /v1/validateMessage` — dry-run a message without merging it. */
  async validateMessage(message: Message | Uint8Array): Promise<unknown> {
    const bytes =
      message instanceof Uint8Array ? message : encodeMessage(message);
    return this.request('/v1/validateMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
  }

  /**
   * Query a submitted message back out of the node. A read node has no
   * mempool, so "my cast exists" is only true once the message is stored —
   * this is the query-back half of the confirmation path the tutorial teaches.
   */
  async confirmMessage(options: {
    fid: number;
    hash: string;
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<NodeMessage | undefined> {
    const attempts = options.attempts ?? 12;
    const intervalMs = options.intervalMs ?? 1500;
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.castById({ fid: options.fid, hash: options.hash });
      } catch (error) {
        if (error instanceof NodeApiError && error.status === 404) {
          await sleep(intervalMs);
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }
}

// --- helpers --------------------------------------------------------------

const decodeNodeMessageSafe = (value: unknown): NodeMessage => {
  const decoder = decodeMessagesPage({ messages: [value] }).messages[0];
  if (!decoder) {
    throw new NodeApiError({
      status: 200,
      path: '/v1',
      error: 'Node returned an empty message',
    });
  }
  return decoder;
};

/** Turn a non-2xx node response into a {@link NodeApiError}. */
export function toNodeApiError(options: {
  path: string;
  status: number;
  body: string;
}): NodeApiError {
  const trimmed = options.body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as {
        error?: unknown;
        error_detail?: unknown;
        errorDetail?: unknown;
      };
      return new NodeApiError({
        status: options.status,
        path: options.path,
        error:
          typeof json.error === 'string'
            ? json.error
            : `HTTP ${options.status}`,
        detail:
          typeof json.errorDetail === 'string'
            ? json.errorDetail
            : typeof json.error_detail === 'string'
              ? json.error_detail
              : undefined,
        body: trimmed.slice(0, 500),
      });
    } catch {
      // fall through to the plain-text form below
    }
  }
  return new NodeApiError({
    status: options.status,
    path: options.path,
    error:
      trimmed.length > 0 ? trimmed.slice(0, 300) : `HTTP ${options.status}`,
    body: trimmed.slice(0, 500),
  });
}

/** Re-exported so callers can parse a raw message body themselves. */
export { decodeMessageBytes };
