/**
 * The wallet rail, against a real 402.
 *
 * `chat-402.json` is Surp's own answer to an unpaid chat request, captured
 * 2026-10-21: `eip155:8453`, USDC on Base, amount 10000 (a cent), payTo
 * 0x2f95…c2c8, 600 seconds.
 *
 * What must be true of everything below: it prepares a payment and cannot make
 * one. There is no signature in this module, no key, no broadcast — the test
 * that matters most is the one asserting the prepared object still needs the
 * owner's wallet, and that a signature only becomes a header when the owner has
 * produced one.
 */

import { describe, expect, it } from 'vitest';

import {
  atomicToUsd,
  BASE_CAIP2,
  encodePaymentHeader,
  freshNonce,
  parseX402Challenge,
  PAYMENT_HEADERS,
  preparePayment,
  selectBaseOffer,
  toJsonRpcTypedData,
  USDC_BASE_ADDRESS,
  USDC_BASE_DOMAIN,
} from '~/lib/surp/x402';

import chat402 from './fixtures/chat-402.json';

const challenge = parseX402Challenge(chat402)!;
const offer = selectBaseOffer(challenge)!;
const FROM = '0x1111111111111111111111111111111111111111';

describe('reading the live offer', () => {
  it('reads the chain, the token, the amount and the recipient', () => {
    expect(challenge.x402Version).toBe(2);
    expect(offer.network).toBe(BASE_CAIP2);
    expect(offer.asset.toLowerCase()).toBe(USDC_BASE_ADDRESS.toLowerCase());
    expect(offer.amount).toBe('10000');
    expect(atomicToUsd(offer.amount)).toBeCloseTo(0.01, 9);
    expect(offer.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(offer.maxTimeoutSeconds).toBe(600);
  });

  it('refuses an offer it cannot satisfy rather than paying the wrong rail', () => {
    const other = parseX402Challenge({
      x402Version: 2,
      accepts: [
        { ...chat402.accepts[0], network: 'eip155:84532' },
        {
          ...chat402.accepts[0],
          asset: '0x0000000000000000000000000000000000000001',
        },
      ],
    })!;
    expect(selectBaseOffer(other)).toBeNull();
  });

  it('refuses a body with no usable acceptance', () => {
    expect(parseX402Challenge({ accepts: [{ scheme: 'exact' }] })).toBeNull();
    expect(parseX402Challenge({ error: 'payment-required' })).toBeNull();
  });
});

describe('preparing the payment the owner signs', () => {
  const prepared = preparePayment({
    offer,
    from: FROM,
    nowSeconds: 1_800_000_000,
  })!;

  it('builds the EIP-3009 authorization from the offer, not from a constant', () => {
    const { domain, message, types, primaryType } = prepared.typedData;
    expect(primaryType).toBe('TransferWithAuthorization');
    expect(domain.chainId).toBe(8453);
    expect(domain.verifyingContract).toBe(offer.asset);
    expect(message.to).toBe(offer.payTo);
    expect(message.value).toBe(offer.amount);
    expect(message.from).toBe(FROM);
    expect(message.validAfter).toBe('0');
    expect(message.validBefore).toBe(String(1_800_000_000 + 600));
    expect(types.TransferWithAuthorization.map((field) => field.name)).toEqual([
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
    ]);
  });

  it('names the token the way the token does when the offer is silent', () => {
    // Surp's chat 402 does not carry extra.name/version; its studio 402 does.
    expect(offer.extra.name).toBeUndefined();
    expect(prepared.typedData.domain.name).toBe(USDC_BASE_DOMAIN.name);
    expect(prepared.typedData.domain.version).toBe(USDC_BASE_DOMAIN.version);
  });

  it('takes the token name from the offer when the offer carries it', () => {
    const named = preparePayment({
      offer: {
        ...offer,
        extra: { ...offer.extra, name: 'Bridged USDC', version: '1' },
      },
      from: FROM,
      nowSeconds: 1_800_000_000,
    })!;
    expect(named.typedData.domain.name).toBe('Bridged USDC');
    expect(named.typedData.domain.version).toBe('1');
  });

  it('says what will be paid, in the owner’s words, before anything is signed', () => {
    expect(prepared.ownerLine).toContain('$0.01');
    expect(prepared.ownerLine).toContain('your wallet');
    expect(prepared.usd).toBeCloseTo(0.01, 9);
  });

  it('uses a fresh nonce every time, because EIP-3009 forbids reuse', () => {
    const nonces = new Set(Array.from({ length: 8 }, () => freshNonce()));
    expect(nonces.size).toBe(8);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('carries no signature of its own', () => {
    const serialised = JSON.stringify(prepared);
    expect(serialised).not.toContain('signature');
    // The only thing the wallet still has to produce is the signature itself:
    // everything else the authorization needs is already here.
    expect(Object.keys(prepared.typedData.message).sort()).toEqual(
      ['from', 'nonce', 'to', 'validAfter', 'validBefore', 'value'].sort(),
    );
  });

  it('refuses an offer whose chain or amount makes no sense', () => {
    expect(
      preparePayment({
        offer: { ...offer, network: 'eip155:notachain' },
        from: FROM,
        nowSeconds: 0,
      }),
    ).toBeNull();
    expect(
      preparePayment({
        offer: { ...offer, amount: '0' },
        from: FROM,
        nowSeconds: 0,
      }),
    ).toBeNull();
    expect(
      preparePayment({
        offer: { ...offer, amount: 'free' },
        from: FROM,
        nowSeconds: 0,
      }),
    ).toBeNull();
  });

  it('falls back to the ten minutes the live service quotes', () => {
    const noWindow = preparePayment({
      offer: { ...offer, maxTimeoutSeconds: 0 },
      from: FROM,
      nowSeconds: 1_000,
    })!;
    expect(noWindow.typedData.message.validBefore).toBe('1600');
  });
});

describe('the request header, once the owner has signed', () => {
  const prepared = preparePayment({
    offer,
    from: FROM,
    nowSeconds: 1_800_000_000,
    nonce: `0x${'ab'.repeat(32)}`,
  })!;
  const signature = `0x${'cd'.repeat(65)}` as const;

  it('encodes the payload Surp asks for, and nothing else', () => {
    const header = encodePaymentHeader({
      challenge,
      offer,
      prepared,
      signature,
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.network).toBe(offer.network);
    expect(decoded.accepted.amount).toBe(offer.amount);
    expect(decoded.accepted.payTo).toBe(offer.payTo);
    expect(decoded.payload.signature).toBe(signature);
    expect(decoded.payload.authorization).toEqual(prepared.typedData.message);
  });

  it('names the headers Surp accepts, so a caller picks a real one', () => {
    expect(PAYMENT_HEADERS).toContain('X-Payment');
  });
});

describe('the same authorization, asked for over the wire', () => {
  const prepared = preparePayment({
    offer,
    from: FROM,
    nowSeconds: 1_800_000_000,
    nonce: `0x${'ab'.repeat(32)}`,
  })!;

  it('carries the domain among the types, which a direct wallet needs', () => {
    const asked = JSON.parse(toJsonRpcTypedData(prepared.typedData));
    expect(asked.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect(asked.types.TransferWithAuthorization).toEqual(
      prepared.typedData.types.TransferWithAuthorization,
    );
  });

  it('is the same authorization as the object form, field for field', () => {
    const asked = JSON.parse(toJsonRpcTypedData(prepared.typedData));
    expect(asked.domain).toEqual(prepared.typedData.domain);
    expect(asked.primaryType).toBe('TransferWithAuthorization');
    expect(asked.message).toEqual(prepared.typedData.message);
  });
});
