/**
 * Registering a Farcaster ID on Optimism, from this device.
 *
 * WHAT THIS IS
 *
 * A Farcaster account is an FID: a number the IdRegistry hands out to whoever
 * pays the registration fee on Optimism. The fee is small (measured 2026-10-21:
 * `price()` on the IdGateway answered 81_402_795_512_410 wei ≈ $0.20 at the
 * time, and this client re-reads it rather than hard-coding a number), and the
 * account it creates belongs to the address that paid — here, the address
 * derived from the recovery phrase this device generated. The phrase never
 * leaves the browser and is never sent anywhere; only a signed transaction does.
 *
 * WHY IT IS WRITTEN THIS WAY
 *
 * The whole flow is one JSON-RPC conversation with an Optimism endpoint the
 * reader can change. No viem client, no chain object, no wallet extension
 * required: `eth_call` reads the price and the FID, `eth_getBalance` reads the
 * balance, and `eth_sendRawTransaction` carries a transaction this device signed
 * itself. That keeps the flow testable without a network (every call takes an
 * injected `fetchImpl`) and keeps it honest about what it does — one transaction,
 * to one contract, for a price read from that contract.
 *
 * The guards below are not decoration. A hostile or broken RPC that answers
 * "the fee is 4 ETH" would otherwise be obeyed by a client that signs whatever
 * it is told; refusing to sign an absurd fee is the difference between a bug and
 * a loss.
 */

import { encodeFunctionData } from 'viem';

/** Where an FID is registered on Optimism (chain 10). */
export const OPTIMISM_CHAIN_ID = 10;

/** `IdGateway.register(recovery, extraStorage)` — the contract that mints the FID. */
export const ID_GATEWAY_ADDRESS =
  '0x00000000fc25870c6ed6b6c7e41fb078b7656f69' as const;

/** `IdRegistry.idOf(address)` — read back which FID an address owns. */
export const ID_REGISTRY_ADDRESS =
  '0x00000000fc6c5f01fc30151999387bb99a9f489b' as const;

/** The endpoint used unless the reader names another one in Advanced. */
export const DEFAULT_OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';

/**
 * The most this client will pay to register, in wei (0.02 ETH).
 *
 * MEASURED 2026-10-21: the live price was 81_402_795_512_410 wei, ~245× under
 * this cap, so the cap does not interfere with a normal registration. It exists
 * so a wrong or hostile RPC cannot talk this device into signing a large
 * transfer.
 */
export const MAX_REGISTRATION_PRICE_WEI = 20_000_000_000_000_000n;

/** The most this client will pay per unit of gas, in wei (10 gwei). The live
 *  gas price on 2026-10-21 was 0.001 gwei. */
export const MAX_FEE_PER_GAS_WEI = 10_000_000_000n;

/** Gas-limit ceiling: a registration costs ~200k, so anything near this is wrong. */
export const MAX_REGISTRATION_GAS = 2_000_000n;

/** The headroom added to the estimate, so a moved base fee still fits. */
const GAS_HEADROOM_NUMERATOR = 13n;
const GAS_HEADROOM_DENOMINATOR = 10n;

const ID_GATEWAY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'payable',
    inputs: [
      { name: 'recovery', type: 'address' },
      { name: 'extraStorage', type: 'uint256' },
    ],
    outputs: [
      { name: 'fid', type: 'uint256' },
      { name: 'overpayment', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'price',
    stateMutability: 'view',
    inputs: [{ name: 'extraStorage', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ID_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'idOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** What this module needs from an account to sign a transaction: an address and
 *  a signature. Both kinds of key this client holds (a phrase-derived one, or a
 *  wallet the reader connected) can answer that. */
export interface RegistrationSigner {
  address: `0x${string}`;
  signTransaction: (transaction: unknown) => Promise<`0x${string}`>;
}

/** Raised with a sentence a person can read. */
export class OptimismRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimismRegistrationError';
  }
}

type JsonRpcResponse = {
  result?: string;
  error?: { code?: number; message?: string };
};

/**
 * One JSON-RPC call. Every read and the send go through here, so a test can
 * hand in its own transport and no network is touched.
 */
const rpc = async ({
  rpcUrl,
  method,
  params,
  fetchImpl = fetch,
}: {
  rpcUrl: string;
  method: string;
  params: unknown[];
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  let response: Response;

  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    throw new OptimismRegistrationError(
      "we couldn't reach the Optimism endpoint - check your connection, or the endpoint in Advanced",
    );
  }

  if (!response.ok) {
    throw new OptimismRegistrationError(
      `the Optimism endpoint answered ${response.status} - try again, or pick another endpoint in Advanced`,
    );
  }

  const body = (await response.json().catch(() => undefined)) as
    | JsonRpcResponse
    | undefined;

  if (typeof body?.result !== 'string' || body.result.length === 0) {
    throw new OptimismRegistrationError(
      "the Optimism endpoint didn't answer that request - try again in a moment",
    );
  }

  return body.result;
};

const call = async ({
  rpcUrl,
  to,
  data,
  fetchImpl,
  what,
}: {
  rpcUrl: string;
  to: string;
  data: string;
  fetchImpl?: typeof fetch;
  what: string;
}): Promise<string> => {
  const result = await rpc({
    rpcUrl,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
    fetchImpl,
  });

  if (!/^0x[0-9a-f]*$/i.test(result)) {
    throw new OptimismRegistrationError(
      `the Optimism endpoint sent back something that is not a ${what}`,
    );
  }

  return result;
};

const hexToBigInt = (value: string): bigint =>
  value === '0x' || value.length <= 2 ? 0n : BigInt(value);

/** The chain this endpoint really serves. Registration is Optimism-only. */
export const readChainId = async ({
  rpcUrl,
  fetchImpl,
}: {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<number> =>
  Number(
    hexToBigInt(
      await rpc({ rpcUrl, method: 'eth_chainId', params: [], fetchImpl }),
    ),
  );

/** What the contract charges right now, in wei. Read, never assumed. */
export const readRegistrationPrice = async ({
  rpcUrl,
  fetchImpl,
}: {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<bigint> => {
  const data = encodeFunctionData({
    abi: ID_GATEWAY_ABI,
    functionName: 'price',
    args: [0n],
  });

  const price = hexToBigInt(
    await call({
      rpcUrl,
      to: ID_GATEWAY_ADDRESS,
      data,
      fetchImpl,
      what: 'price',
    }),
  );

  if (price <= 0n) {
    throw new OptimismRegistrationError(
      "the Optimism endpoint answered with a fee of zero - that endpoint can't be trusted for a registration",
    );
  }

  if (price > MAX_REGISTRATION_PRICE_WEI) {
    throw new OptimismRegistrationError(
      'the registration fee that endpoint quoted is far higher than it should be - check the endpoint in Advanced',
    );
  }

  return price;
};

/** The address's balance on Optimism, in wei. */
export const readOptimismBalance = async ({
  rpcUrl,
  address,
  fetchImpl,
}: {
  rpcUrl: string;
  address: string;
  fetchImpl?: typeof fetch;
}): Promise<bigint> =>
  hexToBigInt(
    await rpc({
      rpcUrl,
      method: 'eth_getBalance',
      params: [address, 'latest'],
      fetchImpl,
    }),
  );

/** The FID this address already owns, or 0 when it owns none. */
export const readFidOf = async ({
  rpcUrl,
  address,
  fetchImpl,
}: {
  rpcUrl: string;
  address: string;
  fetchImpl?: typeof fetch;
}): Promise<number> => {
  const data = encodeFunctionData({
    abi: ID_REGISTRY_ABI,
    functionName: 'idOf',
    args: [address as `0x${string}`],
  });

  return Number(
    hexToBigInt(
      await call({
        rpcUrl,
        to: ID_REGISTRY_ADDRESS,
        data,
        fetchImpl,
        what: 'FID',
      }),
    ),
  );
};

/** The transfer a registration is: to the IdGateway, paying the fee, naming the
 *  recovery address. Kept as one value so the preview, the test and the signing
 *  step cannot disagree about what is being signed. */
export interface RegistrationRequest {
  to: typeof ID_GATEWAY_ADDRESS;
  chainId: number;
  /** The FID's recovery address. This client names the account's own custody
   *  address: the phrase IS the recovery, and it stays on this device. */
  recovery: `0x${string}`;
  /** wei */
  value: bigint;
  data: `0x${string}`;
}

export const buildRegistrationRequest = ({
  recovery,
  value,
}: {
  recovery: `0x${string}`;
  value: bigint;
}): RegistrationRequest => ({
  to: ID_GATEWAY_ADDRESS,
  chainId: OPTIMISM_CHAIN_ID,
  recovery,
  value,
  data: encodeFunctionData({
    abi: ID_GATEWAY_ABI,
    functionName: 'register',
    args: [recovery, 0n],
  }),
});

/**
 * Sign the registration on this device and hand back the raw transaction.
 *
 * Fees are read, sanity-checked against the caps above, and only then used — so
 * the amount signed is one this client can defend, not one an endpoint asserted.
 */
export const signRegistrationTransaction = async ({
  request,
  signer,
  rpcUrl,
  fetchImpl,
}: {
  request: RegistrationRequest;
  signer: RegistrationSigner;
  rpcUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<`0x${string}`> => {
  const [nonceHex, gasHex, gasPriceHex, tipHex] = await Promise.all([
    rpc({
      rpcUrl,
      method: 'eth_getTransactionCount',
      params: [signer.address, 'latest'],
      fetchImpl,
    }),
    rpc({
      rpcUrl,
      method: 'eth_estimateGas',
      params: [
        {
          from: signer.address,
          to: request.to,
          data: request.data,
          value: `0x${request.value.toString(16)}`,
        },
      ],
      fetchImpl,
    }),
    rpc({ rpcUrl, method: 'eth_gasPrice', params: [], fetchImpl }),
    rpc({
      rpcUrl,
      method: 'eth_maxPriorityFeePerGas',
      params: [],
      fetchImpl,
    }).catch(
      // Not every endpoint implements the tip call; a zero tip is a valid bid.
      () => '0x0',
    ),
  ]);

  const gas = hexToBigInt(gasHex);
  const gasPrice = hexToBigInt(gasPriceHex);
  const tip = hexToBigInt(tipHex);
  const maxFeePerGas = gasPrice * 2n + tip;
  const gasLimit = (gas * GAS_HEADROOM_NUMERATOR) / GAS_HEADROOM_DENOMINATOR;

  if (
    maxFeePerGas <= 0n ||
    maxFeePerGas > MAX_FEE_PER_GAS_WEI ||
    gasLimit <= 0n ||
    gasLimit > MAX_REGISTRATION_GAS
  ) {
    throw new OptimismRegistrationError(
      'that endpoint quoted gas fees this client will not sign - check the endpoint in Advanced',
    );
  }

  return signer.signTransaction({
    chainId: request.chainId,
    type: 'eip1559',
    to: request.to,
    data: request.data,
    value: request.value,
    nonce: Number(hexToBigInt(nonceHex)),
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: tip <= maxFeePerGas ? tip : maxFeePerGas,
  });
};

/** Send a transaction this device already signed. Returns its hash. */
export const sendRawTransaction = async ({
  rpcUrl,
  raw,
  fetchImpl,
}: {
  rpcUrl: string;
  raw: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  const hash = await rpc({
    rpcUrl,
    method: 'eth_sendRawTransaction',
    params: [raw],
    fetchImpl,
  });

  if (!/^0x[0-9a-f]{64}$/i.test(hash)) {
    throw new OptimismRegistrationError(
      "the Optimism endpoint didn't send back a transaction id - check the endpoint in Advanced",
    );
  }

  return hash;
};

/**
 * Read the price, sign the registration, send it. Returns what was sent.
 *
 * WHO ENDS UP OWNING THE FID, EXACTLY. The registrar this calls is the live
 * `IdGateway`, and its own source settles it: `register(recovery, extraStorage)`
 * mints the FID to `msg.sender` and merely records `recovery` as the recovery
 * address (`idRegistry.register(msg.sender, recovery)`). So the address that
 * SIGNS is the address that OWNS — which is why a held wallet signing for itself
 * is how an account the person signed up with comes to hold its number
 * (`~/lib/heldWallet`, and `docs/CLIENT-ACCOUNT-OWNERSHIP.md`).
 *
 * A different signer here would therefore become the owner, not a sponsor that
 * leaves `custody` in charge: the payer≠owner split is a different call
 * (`IdGateway.registerFor(to, recovery, deadline, sig, extraStorage)`, against
 * `to`'s own EIP-712 signature). Nothing here passes one today; this says so out
 * loud because the comment used to claim the opposite.
 */
export const registerFid = async ({
  rpcUrl,
  signer,
  recovery,
  fetchImpl,
}: {
  rpcUrl: string;
  signer: RegistrationSigner;
  /** Defaults to the signer: the payer and the owner are usually the same. */
  recovery?: `0x${string}`;
  fetchImpl?: typeof fetch;
}): Promise<{
  txHash: string;
  price: bigint;
  request: RegistrationRequest;
}> => {
  const price = await readRegistrationPrice({ rpcUrl, fetchImpl });
  const request = buildRegistrationRequest({
    recovery: recovery ?? signer.address,
    value: price,
  });
  const raw = await signRegistrationTransaction({
    request,
    signer,
    rpcUrl,
    fetchImpl,
  });
  const txHash = await sendRawTransaction({ rpcUrl, raw, fetchImpl });

  return { txHash, price, request };
};
