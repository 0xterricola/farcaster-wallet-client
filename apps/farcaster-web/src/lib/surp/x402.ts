/**
 * Paying Surp from the wallet the owner already has.
 *
 * Surp's wallet rail is x402 v2 on Base: an unpaid request is answered with a
 * 402 whose `accepts[0]` says the network, the USDC contract, the amount in
 * atomic units, who to pay and for how long the offer stands. Measured against
 * the live service on 2026-10-21, that answer for a chat request was
 * `eip155:8453`, asset `0x8335…2913` (USDC on Base), amount `10000` (a cent),
 * `payTo 0x2f95…c2c8`, 600 seconds.
 *
 * This module does exactly one job: turn that live offer into the EIP-3009
 * `TransferWithAuthorization` the owner's wallet is asked to sign. It does not
 * sign, it does not send, and it holds no key — the signature is the owner
 * pressing a button in their own wallet, and the request that spends it is a
 * separate, deliberate step. That separation is the whole safety story here:
 * nothing in this file can move money on its own, and every function that
 * returns a signable object also returns the sentence the owner reads first.
 *
 * The EIP-712 domain comes from the offer where the offer carries it. Surp's
 * chat 402 does not name the token in `extra` (its studio 402 does, and names
 * it "USD Coin" version "2"), so the fallback below is the domain that token
 * really uses — verified against Surp's own verification code path, not chosen
 * here. A signature over the wrong domain is rejected by the facilitator, so
 * this is a fact worth writing down: name `USD Coin`, version `2`, chain
 * `eip155:8453`.
 */

import { asRecord, num, str, surpJson } from './transport';

/** Base mainnet, as CAIP-2 — the chain this rail settles on. */
export const BASE_CAIP2 = 'eip155:8453';

/** USDC on Base. The asset Surp quotes; the domain fallback binds to it. */
export const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** What that token's own EIP-712 domain says, when the offer omits it. */
export const USDC_BASE_DOMAIN = {
  name: 'USD Coin',
  version: '2',
} as const;

export interface X402Offer {
  scheme: string;
  /** CAIP-2, e.g. `eip155:8453`. */
  network: string;
  /** The asset contract, e.g. USDC on Base. */
  asset: `0x${string}`;
  /** Atomic units, as a string: 6 decimals for USDC, so 10000 = $0.01. */
  amount: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  /** Scheme extras, which may carry the token's EIP-712 name and version. */
  extra: Record<string, unknown>;
  /** Anything Surp said about what this pays for. */
  description: string | null;
}

export interface X402Challenge {
  x402Version: number;
  resource: string | null;
  offers: X402Offer[];
}

/** An address, checked. A malformed one is a refusal, not a payment. */
const hexAddress = (value: unknown): `0x${string}` | null =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as `0x${string}`)
    : null;

/** Parse a 402 body. Anything unrecognised is refused, never guessed at. */
export const parseX402Challenge = (payload: unknown): X402Challenge | null => {
  const body = asRecord(payload);
  if (!body) return null;
  const rows = Array.isArray(body.accepts) ? body.accepts : [];
  const offers: X402Offer[] = [];
  for (const row of rows) {
    const offer = asRecord(row);
    if (!offer) continue;
    const network = str(offer.network);
    const asset = hexAddress(offer.asset);
    const amount = str(offer.amount);
    const payTo = hexAddress(offer.payTo);
    const scheme = str(offer.scheme);
    if (!network || !asset || !amount || !payTo || !scheme) continue;
    const extra = asRecord(offer.extra) ?? {};
    offers.push({
      scheme,
      network,
      asset,
      amount,
      payTo,
      maxTimeoutSeconds: num(offer.maxTimeoutSeconds) ?? 0,
      extra,
      description: str(extra.description),
    });
  }
  if (offers.length === 0) return null;
  return {
    x402Version: num(body.x402Version) ?? 0,
    resource: str(body.resource),
    offers,
  };
};

/** The offer this client can actually satisfy: an exact USDC amount on Base. */
export const selectBaseOffer = (
  challenge: X402Challenge,
): X402Offer | null =>
  challenge.offers.find(
    (offer) =>
      offer.scheme === 'exact' &&
      offer.network === BASE_CAIP2 &&
      offer.asset.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase(),
  ) ?? null;

export const atomicToUsd = (amount: string, decimals = 6): number => {
  const value = Number(amount);
  return Number.isFinite(value) ? value / 10 ** decimals : NaN;
};

export const formatUsd = (value: number): string =>
  Number.isFinite(value)
    ? `$${value.toFixed(value < 0.01 ? 4 : 2)}`
    : 'an unknown amount';

/** One fresh 32-byte nonce, hex. EIP-3009 requires a never-reused value. */
export const freshNonce = (): `0x${string}` => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * The EIP-3009 authorization, exactly as a wallet should be asked to sign it.
 * Shape and field order come from the x402 EVM mechanism's own
 * `TransferWithAuthorization` type; the numbers come from the live offer.
 */
export interface PreparedPayment {
  /** What the owner reads before pressing anything. */
  ownerLine: string;
  /** Who is paying. */
  from: string;
  /** Who is being paid, and how much, from the live offer. */
  to: string;
  usd: number;
  /** The exact typed data to hand to the wallet's `signTypedData`. */
  typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: `0x${string}`;
    };
    types: {
      TransferWithAuthorization: {
        name: string;
        type: string;
      }[];
    };
    primaryType: 'TransferWithAuthorization';
    message: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
}

const chainIdFrom = (network: string): number | null => {
  const [, id] = network.split(':');
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export interface PreparePaymentInput {
  offer: X402Offer;
  /** The owner's address, from the wallet this client is connected to. */
  from: string;
  /** When the offer was received, in seconds. */
  nowSeconds: number;
  nonce?: `0x${string}`;
}

/**
 * Build the authorization. No signature, no network call, no key — the return
 * value is a request for the owner's wallet to sign, and nothing else.
 */
export const preparePayment = ({
  offer,
  from,
  nowSeconds,
  nonce = freshNonce(),
}: PreparePaymentInput): PreparedPayment | null => {
  const chainId = chainIdFrom(offer.network);
  if (chainId === null) return null;
  const usd = atomicToUsd(offer.amount);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  // The offer's own timeout decides how long the authorization stands; a
  // missing or absurd value falls back to the ten minutes the live service
  // quotes rather than to something open-ended.
  const window = offer.maxTimeoutSeconds > 0 ? offer.maxTimeoutSeconds : 600;
  const validAfter = '0';
  const validBefore = String(nowSeconds + window);
  const name = str(offer.extra.name) ?? USDC_BASE_DOMAIN.name;
  const version = str(offer.extra.version) ?? USDC_BASE_DOMAIN.version;
  return {
    ownerLine: `Pay ${formatUsd(usd)} from your wallet for one request. Your wallet will ask you to approve it.`,
    from,
    to: offer.payTo,
    usd,
    typedData: {
      domain: {
        name,
        version,
        chainId,
        verifyingContract: offer.asset,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from,
        to: offer.payTo,
        value: offer.amount,
        validAfter,
        validBefore,
        nonce,
      },
    },
  };
};

/**
 * The x402 payment payload a request carries once the owner has signed: the
 * signature, the authorization it covers, and the exact requirement it answers.
 * Encoded to base64 for the header Surp's own 402 asks for (`X-Payment`; the
 * reference client uses `PAYMENT-SIGNATURE` — both are the same JSON).
 */
export interface SignedPaymentInput {
  challenge: X402Challenge;
  offer: X402Offer;
  prepared: PreparedPayment;
  signature: `0x${string}`;
}

export const encodePaymentHeader = ({
  challenge,
  offer,
  prepared,
  signature,
}: SignedPaymentInput): string => {
  const payload = {
    x402Version: challenge.x402Version,
    accepted: {
      scheme: offer.scheme,
      network: offer.network,
      asset: offer.asset,
      amount: offer.amount,
      payTo: offer.payTo,
      maxTimeoutSeconds: offer.maxTimeoutSeconds,
      extra: offer.extra,
    },
    payload: {
      signature,
      authorization: prepared.typedData.message,
    },
  };
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The header Surp's 402 names, and the one the reference client sends. */
export const PAYMENT_HEADERS = ['X-Payment', 'PAYMENT-SIGNATURE'] as const;

/**
 * Ask Surp for the live price of a request an agent would make, and hand back
 * the offer it answers with. Costs nothing: an unpaid probe is how the price is
 * asked for. (The request in `x402.ts` is the only one in this folder that
 * makes the service answer a 402, and `allow402` below is what keeps a refusal
 * from being mistaken for a failure.)
 */
export const fetchPaymentOffer = async (
  tokens: number,
  combo = 'surp/value',
): Promise<{ challenge: X402Challenge; offer: X402Offer } | null> => {
  const payload = await surpJson<unknown>(
    {
      path: '/v1/chat/completions',
      method: 'POST',
      body: {
        model: combo,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: Math.max(1, Math.round(tokens)),
      },
    },
    { allow402: true },
  );
  const challenge = parseX402Challenge(payload);
  if (!challenge) return null;
  const offer = selectBaseOffer(challenge);
  return offer ? { challenge, offer } : null;
};