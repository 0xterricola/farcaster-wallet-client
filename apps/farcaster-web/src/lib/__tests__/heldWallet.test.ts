/**
 * The held wallet's signing, as the rest of the client meets it.
 *
 * Four claims are pinned here rather than left to a browser: the transaction
 * this asks the provider to sign is the one the registrar would have signed
 * itself, the EIP-712 payload carries the domain type the RPC method demands,
 * nothing that is not a signature is ever returned as one, and a provider that
 * refuses is a sentence rather than a stack trace.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  eip712DomainType,
  ETH_SIGN_TRANSACTION,
  ETH_SIGN_TYPED_DATA_V4,
  heldWalletCustody,
  HeldWalletSigningError,
  signTransactionParams,
  signTypedDataParams,
} from '~/lib/heldWallet';
import { nameProofTypedData } from '~/snapchain/accounts/username';

const HELD = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063' as `0x${string}`;

const RAW_TRANSACTION = `0x02${'ab'.repeat(60)}` as `0x${string}`;
const SIGNATURE = `0x${'cd'.repeat(65)}` as `0x${string}`;

/** A provider that answers with whatever it was told to, and records the asks. */
const providerFor = (answers: Record<string, unknown>) => {
  const calls: { method: string; params?: unknown[] }[] = [];

  return {
    calls,
    request: async (args: { method: string; params?: unknown[] }) => {
      calls.push(args);
      const answer = answers[args.method];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    },
  };
};

describe('the transaction a held wallet is asked to sign', () => {
  it('names the sender, the chain and the type, in hex', () => {
    const [request] = signTransactionParams({
      from: HELD,
      transaction: {
        chainId: 10,
        to: '0x00000000fc25870c6ed6b6c7e41fb078b7656f69',
        data: '0xdeadbeef',
        value: 81_402_795_512_410n,
        nonce: 7,
        gas: 200_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      },
    });

    expect(request).toEqual({
      from: HELD,
      to: '0x00000000fc25870c6ed6b6c7e41fb078b7656f69',
      chainId: 10,
      type: 2,
      data: '0xdeadbeef',
      value: `0x${81_402_795_512_410n.toString(16)}`,
      nonce: '0x7',
      // `gasLimit`, not `gas`: that is this RPC's own name for it.
      gasLimit: '0x30d40',
      maxFeePerGas: '0x77359400',
      maxPriorityFeePerGas: '0x3b9aca00',
    });
  });

  it('leaves out what the caller did not decide', () => {
    const [request] = signTransactionParams({
      from: HELD,
      transaction: { chainId: 10, to: '0xabc' },
    });

    expect(Object.keys(request).sort()).toEqual([
      'chainId',
      'from',
      'to',
      'type',
    ]);
  });
});

describe('the typed data a held wallet is asked to sign', () => {
  it('describes the domain it is given, in the standard order, and nothing else', () => {
    expect(
      eip712DomainType({
        verifyingContract: '0xe3be01d99baa8db9905b33a3ca391238234b79d1',
        name: 'Farcaster name verification',
        version: '1',
        chainId: 1,
      }),
    ).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);

    // A domain with no name is a domain with no name: no field is invented.
    expect(eip712DomainType({ chainId: 10 })).toEqual([
      { name: 'chainId', type: 'uint256' },
    ]);
  });

  it('hands over the address and one JSON payload the RPC method can read', () => {
    const typedData = nameProofTypedData({
      name: 'probe',
      timestamp: 1_700_000_000,
      owner: HELD,
    });

    const [address, payload] = signTypedDataParams(HELD, typedData);
    const parsed = JSON.parse(payload) as {
      types: Record<string, unknown>;
      primaryType: string;
      domain: Record<string, unknown>;
      message: Record<string, unknown>;
    };

    expect(address).toBe(HELD);
    expect(parsed.primaryType).toBe('UserNameProof');
    expect(parsed.message).toEqual({
      name: 'probe',
      timestamp: 1_700_000_000,
      owner: HELD,
    });
    expect(parsed.domain).toEqual(typedData.domain);
    expect(parsed.types.UserNameProof).toEqual(typedData.types.UserNameProof);
    expect(parsed.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
  });

  it('carries a message whose numbers are BigInts, which JSON cannot hold', () => {
    // The shape the node's own gasless KEY_ADD builds (`buildKeyAddMessage` in
    // `farcaster-node-client` hands the signer `fid` as a BigInt). Before this
    // was converted, JSON.stringify threw, the provider was never asked, and
    // the person was told their sign-up "would not sign that".
    const typedData = {
      domain: {
        name: 'Farcaster SignedKeyRequest',
        version: '1',
        chainId: 10,
        verifyingContract: '0x00000000fc9ab05c4b19ab0b47cd8ee7ae0d4c5a',
      },
      types: {
        SignedKeyRequest: [
          { name: 'requestFid', type: 'uint256' },
          { name: 'key', type: 'bytes' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'SignedKeyRequest',
      message: {
        requestFid: 21088n,
        key: `0x02${'ff'.repeat(32)}`,
        deadline: 1_700_000_000n,
      },
    } as const;

    const [, payload] = signTypedDataParams(HELD, typedData);
    const parsed = JSON.parse(payload) as { message: Record<string, unknown> };

    expect(parsed.message).toEqual({
      // A quantity over this RPC is a hex string; the wallet hashes the same
      // uint256 a locally held key would have hashed.
      requestFid: `0x${21088n.toString(16)}`,
      key: `0x02${'ff'.repeat(32)}`,
      deadline: `0x${1_700_000_000n.toString(16)}`,
    });
  });
});

describe('an account whose words are held for it', () => {
  it('signs a transaction without sending it, so this client still broadcasts it', async () => {
    const provider = providerFor({ [ETH_SIGN_TRANSACTION]: RAW_TRANSACTION });
    const custody = heldWalletCustody({
      address: HELD,
      provider,
      label: 'your Google sign-up',
    });

    await expect(
      custody.signTransaction({
        chainId: 10,
        to: '0x00000000fc25870c6ed6b6c7e41fb078b7656f69',
        value: 1n,
      }),
    ).resolves.toBe(RAW_TRANSACTION);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.method).toBe(ETH_SIGN_TRANSACTION);
    expect(provider.calls[0]?.params).toHaveLength(1);
  });

  it('signs typed data and hands back a 65-byte signature', async () => {
    const provider = providerFor({ [ETH_SIGN_TYPED_DATA_V4]: SIGNATURE });
    const custody = heldWalletCustody({ address: HELD, provider });

    const signed = await custody.signTypedData(
      nameProofTypedData({ name: 'probe', timestamp: 1, owner: HELD }),
    );

    expect(signed).toBe(SIGNATURE);
    expect(provider.calls[0]?.method).toBe(ETH_SIGN_TYPED_DATA_V4);
  });

  it('refuses to hand back anything that is not a signature', async () => {
    const provider = providerFor({ [ETH_SIGN_TYPED_DATA_V4]: '0xdead' });
    const custody = heldWalletCustody({
      address: HELD,
      provider,
      label: 'your Google sign-up',
    });

    await expect(custody.signTypedData({})).rejects.toThrow(
      HeldWalletSigningError,
    );
    await expect(custody.signTypedData({})).rejects.toThrow(
      /your Google sign-up answered with something that is not a signature/,
    );
  });

  it('says which window refused, in a sentence, when the provider throws', async () => {
    const provider = providerFor({
      [ETH_SIGN_TRANSACTION]: new Error('user rejected'),
    });
    const custody = heldWalletCustody({
      address: HELD,
      provider,
      label: 'your X sign-up',
    });

    await expect(custody.signTransaction({})).rejects.toThrow(
      /your X sign-up would not sign that\. Nothing was sent/,
    );
  });

  it('is the registrar’s own signer, with the address the FID will belong to', async () => {
    const provider = providerFor({ [ETH_SIGN_TRANSACTION]: RAW_TRANSACTION });
    const custody = heldWalletCustody({ address: HELD, provider });

    // The shape `registerFid` takes: an address and a raw transaction.
    expect(custody.address).toBe(HELD);
    expect(typeof custody.signTransaction).toBe('function');
    expect(vi.isMockFunction(custody.signTransaction)).toBe(false);
  });
});
