/**
 * The connect service a copy of Fiddy answers for itself, held to its contract
 * with a stubbed network and REAL signatures.
 *
 * WHY THIS IS A TEST AND NOT A SCREEN
 *
 * The half of this feature a person sees is the same sheet that shipped for
 * fiddy.fun (`~/components/fiddy/accounts/ConnectSheet`) — it is not touched
 * here. What is new is the half that does the asking: minting a key, signing
 * Farcaster's `SignedKeyRequest` with the instance's own account, reading the
 * answer, deciding whether the approval belongs to the person who asked, and
 * handing over a key the browser can sign with. Three of those cost real trust
 * if they are wrong, so all three are checked here against the real crypto:
 *
 *   1. the request Farcaster receives is signed by the account this instance
 *      says it is, over the exact payload in the request — verified with EIP-712
 *      recovery, not with a string compare;
 *   2. an identity is adopted only when Farcaster's answer AND this instance's
 *      own node agree about which account it is — never for another account, and
 *      never for the instance's own account;
 *   3. the key handed to the browser IS the key Farcaster was asked to register:
 *      the public half is derived back out of the private hex with the same
 *      library the browser signs with, and compared.
 *
 * The node is a real HTTP stub rather than a mock — the service speaks the
 * node's own `/v1/*` JSON, and the point of the second check is that the answer
 * is read as the node really writes it.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';

import { appKeyFromPrivateKeyHex } from 'farcaster-node-client';
import { type Hex, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { describe, expect, it } from 'vitest';

import {
  createInstanceConnectService,
  createMemoryStore,
  generatePostingKey,
  readInstanceConfig,
  verifyBindingProof,
} from '../../server/instance/connect.mjs';

const APP_FID = 3356372;
const APP_ACCOUNT_KEY = generatePrivateKey();
const APP_ACCOUNT = privateKeyToAccount(APP_ACCOUNT_KEY);
const PERSON_FID = 4242;
const HOST = 'localhost:5173';

const SIGNED_KEY_REQUEST_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10,
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553',
} as const;

const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' },
] as const;

type StubNode = {
  url: string;
  signers: { key: string }[];
  close: () => Promise<void>;
};

/** The two reads the service makes of the node, over real HTTP. */
const startNodeStub = async (): Promise<StubNode> => {
  const state: StubNode = {
    url: '',
    signers: [],
    close: async () => undefined,
  };

  const server: Server = createServer((request: IncomingMessage, response) => {
    const url = request.url ?? '';
    const answer = (body: unknown) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };

    if (url.startsWith('/v1/signersByFid')) {
      answer({
        signers: state.signers,
        gaslessSignerCount: 0,
        gaslessSignerLimit: 1000,
        currentUserNonce: 1,
      });
      return;
    }

    if (url.startsWith('/v1/userDataByFid')) {
      answer({
        messages: [{ data: { userDataBody: { type: 6, value: 'tester' } } }],
      });
      return;
    }

    response.statusCode = 404;
    response.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return state;
};

/** Farcaster's client API: what the service asks, and what it answers. */
const createClientApiStub = () => {
  const created: Record<string, unknown>[] = [];
  const state = { completed: false, userFid: PERSON_FID };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith('/v2/signed-key-requests') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      created.push(body);
      return new Response(
        JSON.stringify({
          result: {
            signedKeyRequest: {
              token: '0xtoken',
              deeplinkUrl: 'farcaster://signed-key-request?token=0xtoken',
              key: body.key,
              state: 'pending',
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        result: {
          signedKeyRequest: {
            token: '0xtoken',
            key: created[0]?.key,
            state: state.completed ? 'completed' : 'pending',
            ...(state.completed ? { userFid: state.userFid } : {}),
          },
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  return { created, state, fetchImpl };
};

const serviceFor = ({
  nodeUrl = null,
  api,
  env = {},
}: {
  nodeUrl?: string | null;
  api: ReturnType<typeof createClientApiStub>;
  env?: Record<string, string>;
}) =>
  createInstanceConnectService({
    config: {
      appFid: APP_FID,
      appKeyRaw: APP_ACCOUNT_KEY,
      clientApi: 'https://api.farcaster.xyz',
      nodeUrl,
      // The default for a service built by hand in a test: ask nobody, which is
      // what an unconfigured instance did before it could borrow a signature.
      // `env` may override it where the borrowed-signer path is under test.
      remoteSigner: null,
      ...env,
    },
    store: createMemoryStore(),
    // Farcaster's API and the node are separate services: the stub answers only
    // for the API, and the node reads go to the real HTTP stub.
    fetchImpl: api.fetchImpl,
    nodeFetchImpl: fetch,
    now: () => 1_800_000_000_000,
  });

describe('the key this instance mints', () => {
  it('is a key the browser can sign with, and the one Farcaster is asked about', async () => {
    const minted = generatePostingKey();
    // The browser reads this hex shape with `appKeyFromPrivateKeyHex`, and
    // signs messages with it: derive the public half back out of it exactly as
    // the client will, and compare it with what the request names.
    const derived = await appKeyFromPrivateKeyHex(minted.privateKeyHex);
    expect(derived.publicKeyHex).toBe(minted.publicKeyHex);
    expect(minted.privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reads the instance’s own account off the environment, and nothing else', () => {
    const configured = readInstanceConfig({
      FIDDY_INSTANCE_APP_FID: '3356372',
      FIDDY_INSTANCE_APP_KEY: APP_ACCOUNT_KEY,
      SNAPCHAIN_HTTP_URL: 'http://127.0.0.1:3381',
    });
    expect(configured.appFid).toBe(APP_FID);
    expect(configured.nodeUrl).toBe('http://127.0.0.1:3381');

    const bare = readInstanceConfig({});
    expect(bare.appFid).toBeNull();
    expect(bare.appKeyRaw).toBeNull();
    expect(bare.clientApi).toBe('https://api.farcaster.xyz');
    // With no account of its own, what it asks instead: the project's signer by
    // default, anything the operator names, or nobody at all (an empty value is
    // a deliberate refusal, not an unset one).
    expect(bare.remoteSigner).toBe(
      'https://fiddy.fun/api/fiddy/signer-request',
    );
    expect(
      readInstanceConfig({ FIDDY_SIGNER_REQUEST_URL: '' }).remoteSigner,
    ).toBeNull();
    expect(
      readInstanceConfig({
        FIDDY_SIGNER_REQUEST_URL: 'http://127.0.0.1:5199/sign/',
      }).remoteSigner,
    ).toBe('http://127.0.0.1:5199/sign');
  });
});

describe('the instance connect service', () => {
  it('refuses in a sentence when this copy of Fiddy has no account of its own', async () => {
    const api = createClientApiStub();
    const service = createInstanceConnectService({
      config: {
        appFid: null,
        appKeyRaw: null,
        clientApi: 'https://api.farcaster.xyz',
        nodeUrl: null,
        remoteSigner: null,
      },
      store: createMemoryStore(),
      fetchImpl: api.fetchImpl,
    });

    const begun = await service.begin({ handle: undefined, host: HOST });
    expect(begun.status).toBe(501);
    expect(begun.body.code).toBe('CONNECT_UNAVAILABLE');
    expect(String(begun.body.message)).toContain('FIDDY_INSTANCE_APP_FID');
    // Nothing was asked of Farcaster, and nothing is claimed about a key.
    expect(api.created).toHaveLength(0);

    const read = await service.read({ handle: undefined });
    expect(read.status).toBe(200);
    expect(read.body.state).toBe('none');
  });

  it('borrows the project’s signature when it has no account of its own, unchanged', async () => {
    const api = createClientApiStub();
    const askerFid = 3356372;
    const borrowed = {
      requestFid: askerFid,
      // A signature this test does not have to produce: what matters is that it
      // crosses untouched and is what Farcaster is told.
      signature: `0x${'ab'.repeat(65)}`,
      deadline: 1_800_000_060,
    };
    const asked: { key?: string }[] = [];
    const signerUrl = 'https://fiddy.fun/api/fiddy/signer-request';
    const logs: string[] = [];

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === signerUrl) {
        asked.push(JSON.parse(String(init?.body ?? '{}')) as { key?: string });
        return new Response(JSON.stringify({ ok: true, ...borrowed }), {
          status: 200,
        });
      }
      return api.fetchImpl(input as string, init);
    }) as unknown as typeof fetch;

    const service = createInstanceConnectService({
      config: {
        appFid: null,
        appKeyRaw: null,
        clientApi: 'https://api.farcaster.xyz',
        nodeUrl: null,
        remoteSigner: signerUrl,
      },
      store: createMemoryStore(),
      fetchImpl,
      log: (message: string) => logs.push(message),
    });

    const begun = await service.begin({ handle: undefined, host: HOST });
    expect(begun.status).toBe(200);
    expect(begun.body.state).toBe('waiting');
    expect(begun.body.postingKey).toBeNull();

    // It asked for a signature over the key IT minted, and for nothing else.
    expect(asked).toHaveLength(1);
    expect(api.created).toHaveLength(1);
    expect(asked[0]?.key).toBe((api.created[0] as { key?: string }).key);

    // What Farcaster is told is the borrowed signature and the borrowed deadline,
    // verbatim: the request Farcaster checks is the one that was signed.
    expect(api.created[0]).toMatchObject({
      requestFid: askerFid,
      signature: borrowed.signature,
      deadline: borrowed.deadline,
    });
    // And the log says who asked, so an operator reading it is not misled.
    expect(
      logs.some(
        (line) => line.includes('asked Farcaster') && line.includes(signerUrl),
      ),
    ).toBe(true);
  });

  it('reports the project’s refusal rather than leaving a dead button', async () => {
    const api = createClientApiStub();
    const signerUrl = 'https://fiddy.fun/api/fiddy/signer-request';
    const refusal =
      'This deployment has no Farcaster account of its own to ask with (missing FIDDY_CONNECT_APP_FID).';

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === signerUrl) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'SIGNER_REQUEST_NOT_CONFIGURED',
            message: refusal,
          }),
          {
            status: 503,
          },
        );
      }
      return api.fetchImpl(input as string, init);
    }) as unknown as typeof fetch;

    const service = createInstanceConnectService({
      config: {
        appFid: null,
        appKeyRaw: null,
        clientApi: 'https://api.farcaster.xyz',
        nodeUrl: null,
        remoteSigner: signerUrl,
      },
      store: createMemoryStore(),
      fetchImpl,
    });

    const begun = await service.begin({ handle: undefined, host: HOST });
    expect(begun.status).toBe(502);
    expect(begun.body.code).toBe('CONNECT_SIGNER_REFUSED');
    expect(String(begun.body.message)).toContain(refusal);
    // Nothing was asked of Farcaster, so there is no half-made request anywhere.
    expect(api.created).toHaveLength(0);
  });

  it('asks Farcaster with a request signed by the instance’s own account', async () => {
    const api = createClientApiStub();
    const service = serviceFor({ api });

    const begun = await service.begin({ handle: undefined, host: HOST });
    expect(begun.status).toBe(200);
    expect(begun.body.state).toBe('waiting');
    expect(begun.body.reused).toBe(false);
    // No key is handed over before a person has approved anything.
    expect(begun.body.postingKey).toBeNull();
    // A phone camera resolves an https link; the `farcaster://` form is not one.
    expect(String(begun.body.approvalUrl)).toMatch(
      /^https:\/\/client\.farcaster\.xyz\/deeplinks\/signed-key-request\?token=/,
    );

    expect(api.created).toHaveLength(1);
    const request = api.created[0] as {
      key: Hex;
      requestFid: number;
      signature: Hex;
      deadline: number;
    };
    expect(request.requestFid).toBe(APP_FID);
    expect(request.key).toMatch(/^0x[0-9a-f]{64}$/);

    // The real check: the signature proves the FID it claims, over THIS key.
    const valid = await verifyTypedData({
      address: APP_ACCOUNT.address,
      domain: SIGNED_KEY_REQUEST_DOMAIN,
      types: { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
      primaryType: 'SignedKeyRequest',
      message: {
        requestFid: BigInt(request.requestFid),
        key: request.key,
        deadline: BigInt(request.deadline),
      },
      signature: request.signature,
    });
    expect(valid).toBe(true);

    // And it is nobody else's signature.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const fromStranger = await verifyTypedData({
      address: stranger.address,
      domain: SIGNED_KEY_REQUEST_DOMAIN,
      types: { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
      primaryType: 'SignedKeyRequest',
      message: {
        requestFid: BigInt(request.requestFid),
        key: request.key,
        deadline: BigInt(request.deadline),
      },
      signature: request.signature,
    });
    expect(fromStranger).toBe(false);
  });

  it('hands a second press the same link instead of a second request', async () => {
    const api = createClientApiStub();
    const service = serviceFor({ api });

    const first = await service.begin({ handle: undefined, host: HOST });
    const second = await service.begin({ handle: first.handle, host: HOST });

    expect(second.status).toBe(200);
    expect(second.body.state).toBe('waiting');
    expect(second.body.reused).toBe(true);
    expect(second.body.approvalUrl).toBe(first.body.approvalUrl);
    expect(api.created).toHaveLength(1);
  });

  it('waits for the instance’s own node to list the key before it says connected', async () => {
    const node = await startNodeStub();
    const api = createClientApiStub();
    const service = serviceFor({ nodeUrl: node.url, api });

    try {
      const begun = await service.begin({
        handle: undefined,
        forFid: PERSON_FID,
        host: HOST,
      });
      expect(begun.body.state).toBe('waiting');

      api.state.completed = true;

      // Farcaster says the on-chain addition is confirmed; this node has not
      // indexed the key yet, so the service does NOT claim it landed.
      const beforeNode = await service.read({ handle: begun.handle });
      expect(beforeNode.body.state).toBe('waiting');
      expect(beforeNode.body.approvalUrl).toBe(begun.body.approvalUrl);
      expect(beforeNode.body.postingKey).toBeNull();

      // The node catches up: now there are two answers that agree.
      const key = (api.created[0] as { key: string }).key;
      node.signers = [{ key }];

      const afterNode = await service.read({ handle: begun.handle });
      expect(afterNode.body.state).toBe('connected');
      expect(afterNode.body.fid).toBe(PERSON_FID);
      expect(afterNode.body.username).toBe('tester');
      expect(afterNode.body.approvalUrl).toBeNull();

      // The key crosses to the browser, and it is the one Farcaster registered.
      const handed = await appKeyFromPrivateKeyHex(
        String(afterNode.body.postingKey),
      );
      expect(handed.publicKeyHex).toBe(key);
    } finally {
      await node.close();
    }
  });

  it('never adopts an approval that belongs to another account', async () => {
    const api = createClientApiStub();
    const service = serviceFor({ api });

    const begun = await service.begin({
      handle: undefined,
      forFid: PERSON_FID,
      host: HOST,
    });
    api.state.completed = true;
    api.state.userFid = 9999;

    const read = await service.read({ handle: begun.handle });
    expect(read.body.state).toBe('wrong_account');
    expect(read.body.refused).toBe('other_account');
    expect(read.body.fid).toBe(9999);
    // A refusal never carries a key.
    expect(read.body.postingKey).toBeNull();
  });

  it('never adopts the instance’s own account as the person’s', async () => {
    const api = createClientApiStub();
    const service = serviceFor({ api });

    const begun = await service.begin({ handle: undefined, host: HOST });
    api.state.completed = true;
    api.state.userFid = APP_FID;

    const read = await service.read({ handle: begun.handle });
    expect(read.body.state).toBe('wrong_account');
    expect(read.body.refused).toBe('app_account');
    expect(read.body.postingKey).toBeNull();
  });

  it('expects the sign-in proof to be this host’s, and this account’s', async () => {
    const node = await startNodeStub();
    const api = createClientApiStub();
    const service = serviceFor({ nodeUrl: node.url, api });
    const account = privateKeyToAccount(generatePrivateKey());

    const messageFor = (domain: string, fid: number) =>
      createSiweMessage({
        address: account.address,
        chainId: 10,
        domain,
        nonce: 'abc123def456',
        uri: `https://${domain}`,
        version: '1',
        resources: [`farcaster://fid/${fid}`],
      });

    try {
      const good = messageFor(HOST, PERSON_FID);
      const checked = await verifyBindingProof({
        proof: {
          message: good,
          signature: await account.signMessage({ message: good }),
        },
        forFid: PERSON_FID,
        host: HOST,
      });
      expect(checked.ok).toBe(true);

      // A proof that names a different account is refused before any request.
      const otherFid = messageFor(HOST, 7777);
      const refused = await service.begin({
        handle: undefined,
        forFid: PERSON_FID,
        proof: {
          message: otherFid,
          signature: await account.signMessage({ message: otherFid }),
        },
        host: HOST,
      });
      expect(refused.body.state).toBe('wrong_account');
      expect(refused.body.refused).toBe('other_account');
      expect(api.created).toHaveLength(0);

      // A proof signed for somebody else's app is not a proof here.
      const otherHost = messageFor('evil.example', PERSON_FID);
      const foreign = await verifyBindingProof({
        proof: {
          message: otherHost,
          signature: await account.signMessage({ message: otherHost }),
        },
        forFid: PERSON_FID,
        host: HOST,
      });
      expect(foreign.ok).toBe(false);

      // And a tampered signature is not one either. The byte flipped is inside
      // `r`, NOT the trailing recovery byte: measured on this viem version, a
      // mangled recovery byte still recovers the honest address (the pair (r,s)
      // is what proves the signer), so a test that flipped only that byte would
      // assert nothing.
      const signature = await account.signMessage({ message: good });
      const tampered = `${signature.slice(0, 10)}${
        signature[10] === 'a' ? 'b' : 'a'
      }${signature.slice(11)}` as Hex;
      const forged = await verifyBindingProof({
        proof: { message: good, signature: tampered },
        forFid: PERSON_FID,
        host: HOST,
      });
      expect(forged.ok).toBe(false);
    } finally {
      await node.close();
    }
  });

  it('forgets everything when the person turns it off', async () => {
    const node = await startNodeStub();
    const api = createClientApiStub();
    const service = serviceFor({ nodeUrl: node.url, api });

    try {
      const begun = await service.begin({
        handle: undefined,
        forFid: PERSON_FID,
        host: HOST,
      });
      const key = (api.created[0] as { key: string }).key;
      api.state.completed = true;
      node.signers = [{ key }];
      await service.read({ handle: begun.handle });

      const off = await service.remove({ handle: begun.handle });
      expect(off.body.state).toBe('revoked');
      expect(off.body.postingKey).toBeNull();

      const read = await service.read({ handle: begun.handle });
      expect(read.body.state).toBe('none');
      expect(read.body.postingKey).toBeNull();
    } finally {
      await node.close();
    }
  });
});
