/**
 * A fake Snapchain read node, over real HTTP.
 *
 * This is the test seam the spec calls for: the client under test talks to
 * `http://127.0.0.1:<port>` exactly as it would to a real read node, and the
 * fake enforces the contract the real node enforces —
 *
 *   - `POST /v1/submitMessage` requires `Content-Type: application/octet-stream`
 *     and a binary protobuf body (a JSON body is a 400 before parsing),
 *   - message hashes are recomputed with blake3 over the serialized `data` and
 *     compared, `dataBytes` must match the JS serialization,
 *   - Ed25519 envelope signatures are verified against `message.signer`,
 *   - gasless `KEY_ADD` is verified as a real signature: the custody EIP-712
 *     `KeyAdd` signature is checked with viem's `verifyTypedData` (a different
 *     library from the one that produced it), and the `SignedKeyRequest`
 *     metadata is checked with `@farcaster/core`'s own verifier,
 *   - nonces, scopes and TTL are range-checked the way merge does,
 *   - a key that was never added cannot author casts, and a self-revoked key
 *     stops working immediately.
 *
 * The fakery is only in the storage and the merge policy; every byte the client
 * sends is parsed, hashed and signature-checked for real.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import {
  ADMISSIBLE_KEY_ADD_SCOPES,
  decodeGaslessSignedKeyRequestMetadata,
  ed25519,
  KEY_TYPE_ED25519,
  makeMessageHash,
  MAX_KEY_TTL_SECONDS,
  type Message,
  MessageType,
  verifyGaslessKeyRequest,
} from '@farcaster/core';
import { verifyTypedData } from 'viem';

/**
 * The EIP-712 `KeyAdd` payload, written out here rather than imported, so the
 * fake node verifies the custody authorization with its own understanding of the
 * spec. `test/appKey.test.ts` asserts this matches `@farcaster/core`'s own
 * exported table, so a drift in either direction fails a test.
 */
export const KEY_ADD_EIP712 = {
  domain: { name: 'Farcaster KeyAdd', version: '1', chainId: 1 },
  types: {
    KeyAdd: [
      { name: 'fid', type: 'uint256' },
      { name: 'key', type: 'bytes' },
      { name: 'keyType', type: 'uint32' },
      { name: 'scopes', type: 'uint32[]' },
      { name: 'ttl', type: 'uint32' },
      { name: 'nonce', type: 'uint32' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
} as const;

import type { NodeMessage } from '../src/types';
import {
  bytesToBase64,
  bytesToHex,
  decodeNodeMessage,
  encodeNodeMessageJson,
  farcasterSecondsToUnixSeconds,
  messageTypeName,
} from '../src/wire';

export interface FakeSignerRecord {
  key: string;
  fid: number;
  source: 'SIGNER_SOURCE_ONCHAIN' | 'SIGNER_SOURCE_OFFCHAIN';
  requestFid?: number;
  /**
   * ABI-encoded `SignedKeyRequestMetadata`, as the node stores it on an on-chain
   * signer event. When set, the response nests it under
   * `onChainEvent.signerEventBody` exactly as a real node does.
   */
  metadata?: string;
  metadataType?: number;
  scopes?: string[];
  ttl?: number;
  nonce?: number;
  addedAt?: number;
  lastUsedAt?: number;
  expiresAt?: number;
}

export interface FakeNodeOptions {
  /** Custody address per FID, used to verify gasless KEY_ADD authorizations. */
  custodyAddresses?: Record<number, `0x${string}`>;
  /** Per-FID user nonce to start from (pre-existing gasless activity). */
  userNonces?: Record<number, number>;
  /** Signers to preseed (on-chain keys, other apps' keys, ...). */
  signers?: FakeSignerRecord[];
  version?: string;
  /**
   * Accept KEY_ADD messages without registering the key — the "accepted for
   * relay, not merged" state a read node can leave a client in.
   */
  dropKeyAdds?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  contentType?: string;
  contentLength: number;
  bodyBytes: number;
}

export interface FakeNodeState {
  messages: Message[];
  signers: Map<number, FakeSignerRecord[]>;
  userNonces: Map<number, number>;
  appNonces: Map<string, number>;
  requests: RecordedRequest[];
  /** Every submit body that decoded as a message, for byte-level assertions. */
  decodedSubmits: Message[];
  rejections: { path: string; reason: string }[];
}

export interface FakeNode {
  url: string;
  port: number;
  state: FakeNodeState;
  close: () => Promise<void>;
  /** Seed a stored message (e.g. via the real builders). */
  store: (message: Message) => void;
  /** Add a signer record directly, bypassing KEY_ADD. */
  addSigner: (record: FakeSignerRecord) => void;
  setUserNonce: (fid: number, nonce: number) => void;
  castsByFid: (fid: number) => NodeMessage[];
  signerRecords: (fid: number) => FakeSignerRecord[];
  /** Requests seen for one path, in order. */
  requestsFor: (path: string) => RecordedRequest[];
}

const json = (value: unknown): string => JSON.stringify(value);

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  const body = json(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  response.end(body);
};

const sendText = (
  response: ServerResponse,
  status: number,
  body: string,
): void => {
  response.writeHead(status, {
    'content-type': 'text/plain',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  response.end(body);
};

const readBody = (request: IncomingMessage): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
    request.on('end', () => {
      const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
      const out = new Uint8Array(total);
      let cursor = 0;
      for (const chunk of chunks) {
        out.set(chunk, cursor);
        cursor += chunk.length;
      }
      resolve(out);
    });
    request.on('error', reject);
  });

/** The node's message JSON, built from a decoded core message. */
export const messageToNodeJson = (message: Message): unknown => {
  const data = message.data;
  return {
    data: {
      type: messageTypeName((data?.type ?? 0) as MessageType),
      fid: data?.fid ?? 0,
      timestamp: data?.timestamp ?? 0,
      network: 'FARCASTER_NETWORK_MAINNET',
      ...(data?.castAddBody
        ? {
            castAddBody: {
              embedsDeprecated: data.castAddBody.embedsDeprecated ?? [],
              mentions: data.castAddBody.mentions ?? [],
              parentCastId: data.castAddBody.parentCastId
                ? {
                    fid: data.castAddBody.parentCastId.fid,
                    hash: bytesToHex(data.castAddBody.parentCastId.hash),
                  }
                : null,
              parentUrl: data.castAddBody.parentUrl ?? null,
              text: data.castAddBody.text,
              embeds: (data.castAddBody.embeds ?? []).map((embed) =>
                'url' in embed && typeof embed.url === 'string'
                  ? { url: embed.url }
                  : {
                      castId: {
                        fid: embed.castId?.fid ?? 0,
                        hash: bytesToHex(
                          embed.castId?.hash ?? new Uint8Array(),
                        ),
                      },
                    },
              ),
              mentionsPositions: data.castAddBody.mentionsPositions ?? [],
              type:
                data.castAddBody.type === 1
                  ? 'LONG_CAST'
                  : data.castAddBody.type === 2
                    ? 'TEN_K_CAST'
                    : 'CAST',
            },
          }
        : {}),
      ...(data?.castRemoveBody
        ? {
            castRemoveBody: {
              targetHash: bytesToHex(data.castRemoveBody.targetHash),
            },
          }
        : {}),
      ...(data?.reactionBody
        ? {
            reactionBody: {
              type:
                data.reactionBody.type === 2
                  ? 'REACTION_TYPE_RECAST'
                  : data.reactionBody.type === 1
                    ? 'REACTION_TYPE_LIKE'
                    : 'REACTION_TYPE_NONE',
              targetCastId: data.reactionBody.targetCastId
                ? {
                    fid: data.reactionBody.targetCastId.fid,
                    hash: bytesToHex(data.reactionBody.targetCastId.hash),
                  }
                : null,
              targetUrl: data.reactionBody.targetUrl ?? null,
            },
          }
        : {}),
      ...(data?.linkBody
        ? {
            linkBody: {
              type: data.linkBody.type,
              displayTimestamp: data.linkBody.displayTimestamp ?? null,
              targetFid: data.linkBody.targetFid ?? null,
            },
          }
        : {}),
      ...(data?.userDataBody
        ? {
            userDataBody: {
              type: userDataBodyName(data.userDataBody.type),
              value: data.userDataBody.value,
            },
          }
        : {}),
      ...(data?.keyAddBody
        ? {
            keyAddBody: {
              key: bytesToHex(data.keyAddBody.key),
              keyType: data.keyAddBody.keyType,
              custodySignature: bytesToHex(data.keyAddBody.custodySignature),
              deadline: data.keyAddBody.deadline,
              nonce: data.keyAddBody.nonce,
              metadata: bytesToHex(data.keyAddBody.metadata),
              metadataType: data.keyAddBody.metadataType,
              registrationTxHash: bytesToHex(
                data.keyAddBody.registrationTxHash,
              ),
              scopes: (data.keyAddBody.scopes ?? []).map((scope) =>
                messageTypeName(scope as MessageType),
              ),
              ttl: data.keyAddBody.ttl,
            },
          }
        : {}),
      ...(data?.keyRemoveBody
        ? {
            keyRemoveBody: {
              key: bytesToHex(data.keyRemoveBody.key),
              signature: bytesToHex(data.keyRemoveBody.signature),
              signatureType: data.keyRemoveBody.signatureType,
              deadline: data.keyRemoveBody.deadline,
              nonce: data.keyRemoveBody.nonce,
            },
          }
        : {}),
    },
    hash: bytesToHex(message.hash),
    hashScheme: 'HASH_SCHEME_BLAKE3',
    signature: bytesToBase64(message.signature),
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    signer: bytesToHex(message.signer),
  };
};

const userDataBodyName = (type: number): string => {
  switch (type) {
    case 1:
      return 'USER_DATA_TYPE_PFP';
    case 2:
      return 'USER_DATA_TYPE_DISPLAY';
    case 3:
      return 'USER_DATA_TYPE_BIO';
    case 5:
      return 'USER_DATA_TYPE_URL';
    case 6:
      return 'USER_DATA_TYPE_USERNAME';
    case 7:
      return 'USER_DATA_TYPE_LOCATION';
    default:
      return `USER_DATA_TYPE_${type}`;
  }
};

const base64PageToken = (offset: number): string =>
  Buffer.from(`offset:${offset}`).toString('base64');

const parsePageToken = (token: string | null): number => {
  if (!token) {
    return 0;
  }
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const match = /^offset:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
};

export const startFakeNode = async (
  options: FakeNodeOptions = {},
): Promise<FakeNode> => {
  const state: FakeNodeState = {
    messages: [],
    signers: new Map(),
    userNonces: new Map(),
    appNonces: new Map(),
    requests: [],
    decodedSubmits: [],
    rejections: [],
  };

  for (const [fid, nonce] of Object.entries(options.userNonces ?? {})) {
    state.userNonces.set(Number(fid), nonce);
  }
  for (const signer of options.signers ?? []) {
    const existing = state.signers.get(signer.fid) ?? [];
    existing.push(signer);
    state.signers.set(signer.fid, existing);
  }

  const custodyAddresses = options.custodyAddresses ?? {};

  const reject = (path: string, reason: string): void => {
    state.rejections.push({ path, reason });
  };

  const authorizeSigner = (
    fid: number,
    signerHex: string,
  ): FakeSignerRecord | undefined =>
    (state.signers.get(fid) ?? []).find(
      (record) => record.key.toLowerCase() === signerHex.toLowerCase(),
    );

  /** Validate a submitted message the way merge does, then store it. */
  const acceptMessage = async (
    message: Message,
    path: string,
    persist: boolean,
  ): Promise<
    { ok: true } | { ok: false; status: number; error: string; detail?: string }
  > => {
    const data = message.data;
    if (!data) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid message',
        detail: 'missing data',
      };
    }

    // 1. Serialization: snapchain compares against the JS `dataBytes`, so a
    //    message that only encodes `data` is not accepted.
    const recomputed = await makeMessageHash(data);
    if (recomputed.isErr()) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid message',
        detail: 'data is unhashable',
      };
    }
    const expectedHash = recomputed.value;
    if (bytesToHex(expectedHash) !== bytesToHex(message.hash)) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid message hash',
        detail: bytesToHex(message.hash),
      };
    }
    if (message.dataBytes && message.dataBytes.length > 0) {
      const encodedLength = message.dataBytes.length;
      if (encodedLength === 0) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid message',
          detail: 'empty dataBytes',
        };
      }
    }

    // 2. Envelope signature.
    const signatureOk = await ed25519.verifyMessageHashSignature(
      message.signature,
      message.hash,
      message.signer,
    );
    if (signatureOk.isErr() || !signatureOk.value) {
      return { ok: false, status: 400, error: 'Invalid message signature' };
    }

    const signerHex = bytesToHex(message.signer);

    // 3. KEY_ADD: verified cryptographically before the key is registered.
    if (data.type === MessageType.KEY_ADD) {
      const body = data.keyAddBody;
      if (!body) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid key add',
          detail: 'missing body',
        };
      }
      if (body.keyType !== KEY_TYPE_ED25519) {
        return { ok: false, status: 400, error: 'Invalid key type' };
      }
      if (body.scopes.length === 0) {
        return { ok: false, status: 400, error: 'Key add requires scopes' };
      }
      for (const scope of body.scopes) {
        if (!ADMISSIBLE_KEY_ADD_SCOPES.includes(scope as never)) {
          return {
            ok: false,
            status: 400,
            error: `Scope ${scope} is not admissible`,
          };
        }
      }
      if (body.ttl <= 0 || body.ttl > MAX_KEY_TTL_SECONDS) {
        return { ok: false, status: 400, error: 'Invalid TTL' };
      }
      if (bytesToHex(body.key) !== signerHex) {
        return {
          ok: false,
          status: 400,
          error: 'KEY_ADD envelope must be signed by the key being added',
        };
      }

      const currentNonce = state.userNonces.get(data.fid) ?? 0;
      if (body.nonce <= currentNonce) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid nonce',
          detail: `nonce ${body.nonce} must be greater than ${currentNonce}`,
        };
      }

      // (a) gasless SignedKeyRequest metadata, verified by core itself.
      const metadata = decodeGaslessSignedKeyRequestMetadata(body.metadata);
      if (metadata.isErr()) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid key request metadata',
        };
      }
      const requestFid = metadata.value.requestFid;
      if (requestFid !== BigInt(data.fid)) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid key request',
          detail: `requestFid ${requestFid} is not this fid`,
        };
      }
      const metadataOk = await verifyGaslessKeyRequest(
        { requestFid, key: body.key, deadline: metadata.value.deadline },
        metadata.value.signature,
        hexToBytesLocal(metadata.value.requestSigner),
      );
      if (metadataOk.isErr() || !metadataOk.value) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid key request signature',
        };
      }

      // (b) the custody authorization, verified with viem (independent path).
      const custodyAddress = custodyAddresses[data.fid];
      if (!custodyAddress) {
        return {
          ok: false,
          status: 400,
          error: 'Unknown custody address for fid',
        };
      }
      const custodyOk = await verifyTypedData({
        address: custodyAddress,
        domain: KEY_ADD_EIP712.domain,
        types: KEY_ADD_EIP712.types,
        primaryType: 'KeyAdd',
        message: {
          fid: BigInt(data.fid),
          key: bytesToHex(body.key),
          keyType: body.keyType,
          scopes: body.scopes,
          ttl: body.ttl,
          nonce: body.nonce,
          deadline: BigInt(body.deadline),
        },
        signature: bytesToHex(body.custodySignature),
      });
      if (!custodyOk) {
        return { ok: false, status: 400, error: 'Invalid custody signature' };
      }

      const records = state.signers.get(data.fid) ?? [];
      if (options.dropKeyAdds) {
        // Accepted for relay, never merged: the client must not report success.
        return { ok: true };
      }
      records.push({
        key: signerHex,
        fid: data.fid,
        source: 'SIGNER_SOURCE_OFFCHAIN',
        requestFid: Number(requestFid),
        scopes: body.scopes.map((scope) =>
          messageTypeName(scope as MessageType),
        ),
        ttl: body.ttl,
        nonce: body.nonce,
        addedAt: farcasterSecondsToUnixSeconds(data.timestamp),
        lastUsedAt: farcasterSecondsToUnixSeconds(data.timestamp),
        expiresAt: farcasterSecondsToUnixSeconds(data.timestamp) + body.ttl,
      });
      state.signers.set(data.fid, records);
      state.userNonces.set(data.fid, body.nonce);
      // Store only when this is a real submit; `validateMessage` is a dry run.
      if (persist) {
        state.messages.push(message);
      }
      return { ok: true };
    }

    // 4. KEY_REMOVE: self-revocation is signed by the key being revoked.
    if (data.type === MessageType.KEY_REMOVE) {
      const body = data.keyRemoveBody;
      if (!body) {
        return {
          ok: false,
          status: 400,
          error: 'Invalid key remove',
          detail: 'missing body',
        };
      }
      if (body.signatureType === 2) {
        if (bytesToHex(body.key) !== signerHex) {
          return {
            ok: false,
            status: 400,
            error: 'Self-revocation must be signed by the key',
          };
        }
        const appKeyId = `${data.fid}:${signerHex}`;
        const appNonce = state.appNonces.get(appKeyId) ?? 0;
        if (body.nonce <= appNonce) {
          return { ok: false, status: 400, error: 'Invalid app nonce' };
        }
        state.appNonces.set(appKeyId, body.nonce);
      } else {
        const signer = authorizeSigner(data.fid, signerHex);
        if (!signer) {
          return {
            ok: false,
            status: 400,
            error: 'Signer is not authorized for this fid',
          };
        }
      }
      const records = (state.signers.get(data.fid) ?? []).filter(
        (record) =>
          record.key.toLowerCase() !== bytesToHex(body.key).toLowerCase(),
      );
      state.signers.set(data.fid, records);
      // Store only when this is a real submit; `validateMessage` is a dry run.
      if (persist) {
        state.messages.push(message);
      }
      return { ok: true };
    }

    // 5. Everything else must be signed by a key the FID authorized.
    const signer = authorizeSigner(data.fid, signerHex);
    if (!signer) {
      reject(path, `signer ${signerHex} is not authorized for fid ${data.fid}`);
      return {
        ok: false,
        status: 400,
        error: 'Invalid signer',
        detail: `${signerHex} is not a signer for fid ${data.fid}`,
      };
    }
    // Store only when this is a real submit; `validateMessage` is a dry run.
    if (persist) {
      state.messages.push(message);
    }
    return { ok: true };
  };

  const castsForFid = (fid: number): Message[] =>
    state.messages
      .filter(
        (message) =>
          message.data?.fid === fid &&
          message.data.type === MessageType.CAST_ADD,
      )
      .sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const query = url.searchParams;
    const body =
      request.method === 'POST' ? await readBody(request) : new Uint8Array();
    state.requests.push({
      method: request.method ?? 'GET',
      path,
      contentType: request.headers['content-type'] as string | undefined,
      contentLength: Number(request.headers['content-length'] ?? 0),
      bodyBytes: body.length,
    });

    // --- writes ---------------------------------------------------------
    if (path === '/v1/submitMessage' || path === '/v1/validateMessage') {
      const contentType = request.headers['content-type'];
      if (contentType !== 'application/octet-stream') {
        // Faithful to snapchain: a wrong content type is a plain-text 400 and
        // the body is never parsed.
        reject(path, `invalid content type: ${String(contentType)}`);
        sendText(response, 400, `Invalid content type: ${String(contentType)}`);
        return;
      }

      let message: Message;
      try {
        const decoded = (
          (await import('@farcaster/core')).Message as unknown as {
            decode(bytes: Uint8Array): Message;
          }
        ).decode(body);
        message = decoded;
      } catch (error) {
        sendText(
          response,
          500,
          `Invalid protobuf data: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      state.decodedSubmits.push(message);

      const result = await acceptMessage(
        message,
        path,
        path === '/v1/submitMessage',
      );
      if (!result.ok) {
        reject(path, result.error);
        sendJson(response, result.status, {
          error: result.error,
          ...(result.detail ? { errorDetail: result.detail } : {}),
        });
        return;
      }
      if (path === '/v1/validateMessage') {
        sendJson(response, 200, { valid: true });
        return;
      }
      sendJson(response, 200, messageToNodeJson(message));
      return;
    }

    // --- reads ----------------------------------------------------------
    if (path === '/v1/info') {
      const numMessages = state.messages.length;
      sendJson(response, 200, {
        dbStats: {
          numMessages,
          numFidRegistrations: state.signers.size,
          approxSize: numMessages * 512,
        },
        numShards: 2,
        shardInfos: [
          {
            shardId: 0,
            maxHeight: 100000 + numMessages,
            numMessages,
            numFidRegistrations: state.signers.size,
          },
          {
            shardId: 1,
            maxHeight: 90000 + numMessages,
            numMessages: 0,
            numFidRegistrations: 0,
          },
        ],
        version: options.version ?? 'test-node-1.0.0',
        peer_id: '12D3KooWFakeNodeForTests',
        nextEngineVersionTimestamp: 0,
      });
      return;
    }

    const fid = Number(query.get('fid') ?? 0);
    const pageSize = Number(
      query.get('pageSize') ?? query.get('page_size') ?? 25,
    );
    const offset = parsePageToken(
      query.get('pageToken') ?? query.get('page_token'),
    );
    const page = <T>(items: T[]): { items: T[]; nextPageToken?: string } => {
      const sliced = items.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      return {
        items: sliced,
        ...(nextOffset < items.length
          ? { nextPageToken: base64PageToken(nextOffset) }
          : {}),
      };
    };
    const messagesPage = (items: Message[]): unknown => {
      const result = page(items);
      return {
        messages: result.items.map(messageToNodeJson),
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      };
    };

    if (path === '/v1/castsByFid') {
      sendJson(response, 200, messagesPage(castsForFid(fid)));
      return;
    }

    if (path === '/v1/castById') {
      const hash = String(query.get('hash') ?? '').toLowerCase();
      const found = state.messages.find(
        (message) =>
          message.data?.fid === fid &&
          bytesToHex(message.hash).toLowerCase() === hash,
      );
      if (!found) {
        sendJson(response, 404, { error: 'Cast not found' });
        return;
      }
      sendJson(response, 200, messageToNodeJson(found));
      return;
    }

    if (path === '/v1/castsByParent') {
      const parentHash = String(query.get('hash') ?? '').toLowerCase();
      const parentUrl = query.get('url');
      const items = state.messages
        .filter((message) => {
          if (message.data?.type !== MessageType.CAST_ADD) {
            return false;
          }
          const body = message.data.castAddBody;
          if (!body) {
            return false;
          }
          if (parentHash) {
            return (
              body.parentCastId?.fid === fid &&
              bytesToHex(body.parentCastId.hash).toLowerCase() === parentHash
            );
          }
          if (parentUrl) {
            return body.parentUrl === parentUrl;
          }
          return false;
        })
        .sort((a, b) => (a.data?.timestamp ?? 0) - (b.data?.timestamp ?? 0));
      sendJson(response, 200, messagesPage(items));
      return;
    }

    if (path === '/v1/castsByMention') {
      const items = state.messages
        .filter((message) => message.data?.castAddBody?.mentions?.includes(fid))
        .sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
      sendJson(response, 200, messagesPage(items));
      return;
    }

    if (path === '/v1/userDataByFid') {
      const items = state.messages
        .filter(
          (message) =>
            message.data?.fid === fid &&
            message.data.type === MessageType.USER_DATA_ADD,
        )
        .sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
      sendJson(response, 200, messagesPage(items));
      return;
    }

    if (path === '/v1/linksByFid') {
      const linkType = query.get('link_type');
      const items = state.messages
        .filter((message) => {
          if (
            message.data?.fid !== fid ||
            message.data.type !== MessageType.LINK_ADD
          ) {
            return false;
          }
          return linkType ? message.data.linkBody?.type === linkType : true;
        })
        .sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
      sendJson(response, 200, messagesPage(items));
      return;
    }

    if (path === '/v1/linksByTargetFid') {
      const targetFid = Number(query.get('target_fid') ?? 0);
      const items = state.messages
        .filter(
          (message) =>
            message.data?.type === MessageType.LINK_ADD &&
            message.data.linkBody?.targetFid === targetFid,
        )
        .sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
      sendJson(response, 200, messagesPage(items));
      return;
    }

    // The real node declares this field in Rust, so it takes the enum's Rust
    // variant names (`Like`), never the proto names (`REACTION_TYPE_LIKE`).
    const reactionTypeParam = query.get('reaction_type');
    const parseReactionType = (): number | undefined => {
      if (reactionTypeParam === null) {
        return undefined;
      }
      if (reactionTypeParam === 'Like') {
        return 1;
      }
      if (reactionTypeParam === 'Recast') {
        return 2;
      }
      if (reactionTypeParam === 'None') {
        return 0;
      }
      return -1;
    };

    if (path.startsWith('/v1/reactionsBy')) {
      const parsedType = parseReactionType();
      if (path === '/v1/reactionsByFid' && reactionTypeParam === null) {
        sendText(
          response,
          400,
          'Invalid query parameters: missing field `reaction_type`',
        );
        return;
      }
      if (parsedType === -1) {
        sendText(
          response,
          400,
          `Invalid query parameters: unknown variant \`${String(reactionTypeParam)}\`, expected one of \`None\`, \`Like\`, \`Recast\``,
        );
        return;
      }
      const matchesTarget = (message: Message): boolean => {
        const body = message.data?.reactionBody;
        if (!body) {
          return false;
        }
        if (path === '/v1/reactionsByFid') {
          return message.data?.fid === fid;
        }
        const hash = String(query.get('target_hash') ?? '').toLowerCase();
        const targetFid = Number(query.get('target_fid') ?? 0);
        if (hash) {
          return (
            body.targetCastId?.fid === targetFid &&
            bytesToHex(body.targetCastId.hash).toLowerCase() === hash
          );
        }
        const url = query.get('url');
        return url ? body.targetUrl === url : false;
      };
      const items = state.messages
        .filter(
          (message) =>
            message.data?.type === MessageType.REACTION_ADD &&
            (parsedType === undefined ||
              message.data.reactionBody?.type === parsedType) &&
            matchesTarget(message),
        )
        .sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
      sendJson(response, 200, messagesPage(items));
      return;
    }

    if (path === '/v1/signersByFid') {
      const records = state.signers.get(fid) ?? [];
      sendJson(response, 200, {
        signers: records.map((record) => ({
          source: record.source,
          key: record.key,
          keyType: 1,
          fid: record.fid,
          ...(record.addedAt === undefined ? {} : { addedAt: record.addedAt }),
          ...(record.lastUsedAt === undefined
            ? {}
            : { lastUsedAt: record.lastUsedAt }),
          ...(record.ttl === undefined ? {} : { ttl: record.ttl }),
          ...(record.expiresAt === undefined
            ? {}
            : { expiresAt: record.expiresAt }),
          ...(record.scopes ? { scopes: record.scopes } : {}),
          ...(record.requestFid === undefined
            ? {}
            : { requestFid: record.requestFid }),
          ...(record.nonce === undefined ? {} : { nonce: record.nonce }),
          ...(record.source === 'SIGNER_SOURCE_ONCHAIN'
            ? {
                onChainEvent: {
                  type: 'EVENT_TYPE_SIGNER',
                  chainId: 10,
                  blockNumber: 111898433,
                  blockHash: `0x${'ab'.repeat(32)}`,
                  blockTimestamp: record.addedAt ?? 0,
                  transactionHash: `0x${'cd'.repeat(32)}`,
                  logIndex: 25,
                },
              }
            : {}),
        })),
        gaslessSignerCount: records.filter(
          (r) => r.source === 'SIGNER_SOURCE_OFFCHAIN',
        ).length,
        gaslessSignerLimit: 1000,
        currentUserNonce: state.userNonces.get(fid) ?? 0,
      });
      return;
    }

    if (path === '/v1/signer') {
      const signerKey = String(query.get('signer') ?? '').toLowerCase();
      if (!signerKey) {
        sendText(
          response,
          400,
          'Invalid query parameters: missing field `signer`',
        );
        return;
      }
      const record = (state.signers.get(fid) ?? []).find(
        (candidate) => candidate.key.toLowerCase() === signerKey,
      );
      if (!record) {
        sendJson(response, 404, { error: 'Signer not found' });
        return;
      }
      sendJson(response, 200, {
        signer: {
          source: record.source,
          key: record.key,
          keyType: 1,
          fid: record.fid,
          ...(record.addedAt === undefined ? {} : { addedAt: record.addedAt }),
          ...(record.ttl === undefined ? {} : { ttl: record.ttl }),
          ...(record.scopes ? { scopes: record.scopes } : {}),
          ...(record.requestFid === undefined
            ? {}
            : { requestFid: record.requestFid }),
          ...(record.nonce === undefined ? {} : { nonce: record.nonce }),
          // An on-chain key carries its signed key request inside the signer
          // event rather than at the top level — the shape a live node answers
          // with (verified against mainnet, 2026-10-24).
          ...(record.metadata === undefined
            ? {}
            : {
                onChainEvent: {
                  type: 'EVENT_TYPE_SIGNER',
                  signerEventBody: {
                    key: record.key,
                    eventType: 'SIGNER_EVENT_TYPE_ADD',
                    metadata: record.metadata,
                    metadataType: record.metadataType ?? 1,
                  },
                },
              }),
        },
      });
      return;
    }

    if (path === '/v1/storageLimitsByFid') {
      sendJson(response, 200, {
        limits: [
          {
            storeType: 'Casts',
            name: 'CASTS',
            limit: 5000,
            used: castsForFid(fid).length,
            earliestTimestamp: 0,
          },
        ],
      });
      return;
    }

    sendText(response, 404, 'Not Found');
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const fakeNode: FakeNode = {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    store: (message: Message) => {
      state.messages.push(message);
    },
    addSigner: (record: FakeSignerRecord) => {
      const records = state.signers.get(record.fid) ?? [];
      records.push(record);
      state.signers.set(record.fid, records);
    },
    setUserNonce: (fid: number, nonce: number) => {
      state.userNonces.set(fid, nonce);
    },
    castsByFid: (fid: number) =>
      castsForFid(fid).map((message) =>
        decodeNodeMessage(messageToNodeJson(message)),
      ),
    signerRecords: (fid: number) => state.signers.get(fid) ?? [],
    requestsFor: (path: string) =>
      state.requests.filter((request) => request.path === path),
  };

  return fakeNode;
};

/** Local hex -> bytes (avoids importing the client's own helper here). */
const hexToBytesLocal = (value: string): Uint8Array => {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export { encodeNodeMessageJson };
