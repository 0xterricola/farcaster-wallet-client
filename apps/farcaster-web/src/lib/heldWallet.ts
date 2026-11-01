/**
 * The words a sign-up is holding, used the way an account's own key would be.
 *
 * WHY THIS MODULE EXISTS. A person who signed up with Google or X has a real
 * Ethereum wallet — held for them, it is just kept inside the sign-up provider's own
 * secure window instead of being written on paper (`~/lib/socialAccount` maps it
 * to this device's account book). Everything this client does with an account's
 * own key is therefore something a held wallet must be able to do too: sign the
 * registration that creates its Farcaster number, and sign the EIP-712
 * authorisation that lets this device post for it. Nothing else — a held wallet
 * never needs to move money, and nothing here can.
 *
 * WHAT THE PROVIDER IS ASKED FOR, AND WHY THOSE TWO THINGS. Privy's browser
 * window is EIP-1193-shaped and supports a deliberately small set of methods
 * (`SUPPORTED_ETHEREUM_RPC_METHODS` in `@privy-io/react-auth`): the signing
 * ones, because the private key only exists inside its iframe. Two of them are
 * what this needs:
 *
 *   `eth_signTransaction`     — returns the SIGNED raw transaction, not a hash.
 *                               That matters: the client then broadcasts it
 *                               through its own configured Optimism endpoint, so
 *                               every guard it already applies (the fee cap, the
 *                               gas cap, the nonce and gas it read and checked)
 *                               stays in force. The provider signs; this client
 *                               still decides what is being spent and where it
 *                               goes.
 *   `eth_signTypedData_v4`    — the EIP-712 signature the node's gasless KEY_ADD
 *                               requires from the account's owner. No gas, no
 *                               transaction, just a signature.
 *
 * THE ONE THING THAT IS NOT A PASS-THROUGH: EIP-712's domain. A viem account
 * takes `{domain, types, primaryType, message}` and works out the domain type
 * itself; the RPC method takes the whole thing as JSON and will refuse a payload
 * whose `types` does not describe `EIP712Domain`. So the domain type is derived
 * here from the domain actually present, in EIP-712's canonical field order —
 * a field that is absent is a field that does not belong in the hash, and
 * inventing one would produce a signature over something else entirely.
 *
 * WHAT IT REFUSES TO DO. It never returns a "signature" that is not one: both
 * methods check the shape they were handed (a raw transaction, or 65 bytes of
 * signature) and raise a sentence a person can read instead. A silent empty
 * signature is how an account ends up unable to post for reasons nobody can see.
 */

import type { CustodyAccount } from '~/snapchain/accounts/phrase';

/** The provider method that signs a transaction without sending it. */
export const ETH_SIGN_TRANSACTION = 'eth_signTransaction';

/** The provider method that signs EIP-712 typed data. */
export const ETH_SIGN_TYPED_DATA_V4 = 'eth_signTypedData_v4';

/** The little of EIP-1193 this module needs, and nothing more. */
export type HeldWalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/** Raised with a sentence a person can read. */
export class HeldWalletSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeldWalletSigningError';
  }
}

/** 32 bytes of entropy, spelled the way a transaction is spelled. */
const hexQuantity = (value: bigint | number): string =>
  `0x${BigInt(value).toString(16)}`;

const isRawTransaction = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{4,}$/.test(value.trim());

const isSignature = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value.trim());

/**
 * A transaction this client built, in the shape it builds it
 * (`~/snapchain/accounts/optimism` signs exactly these fields).
 */
export type HeldUnsignedTransaction = {
  chainId: number;
  to: string;
  data?: string;
  value?: bigint;
  nonce?: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

/**
 * The request the provider is handed for `eth_signTransaction`.
 *
 * `gasLimit`, not `gas`: that is the name in this RPC's own parameter object.
 * Every quantity goes over as hex so nothing depends on how a JSON bridge
 * treats a bigint, and the sender is named explicitly rather than left to the
 * provider's own idea of which wallet is answering.
 */
export const signTransactionParams = ({
  from,
  transaction,
}: {
  from: string;
  transaction: HeldUnsignedTransaction;
}): [Record<string, unknown>] => [
  {
    from,
    to: transaction.to,
    chainId: transaction.chainId,
    type: 2,
    ...(transaction.data === undefined ? {} : { data: transaction.data }),
    ...(transaction.value === undefined
      ? {}
      : { value: hexQuantity(transaction.value) }),
    ...(transaction.nonce === undefined
      ? {}
      : { nonce: hexQuantity(transaction.nonce) }),
    ...(transaction.gas === undefined
      ? {}
      : { gasLimit: hexQuantity(transaction.gas) }),
    ...(transaction.maxFeePerGas === undefined
      ? {}
      : { maxFeePerGas: hexQuantity(transaction.maxFeePerGas) }),
    ...(transaction.maxPriorityFeePerGas === undefined
      ? {}
      : {
          maxPriorityFeePerGas: hexQuantity(transaction.maxPriorityFeePerGas),
        }),
  },
];

/** EIP-712's domain fields, in the order the standard fixes them. */
const DOMAIN_FIELDS: readonly [string, string][] = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

/**
 * The same payload, in a shape `JSON.stringify` can carry.
 *
 * WHY THIS IS NOT OPTIONAL. EIP-712 messages are built with BigInts — the node's
 * own gasless KEY_ADD carries `fid` as one (`buildKeyAddMessage`, in
 * `farcaster-node-client`) — and `JSON.stringify` THROWS on a BigInt ("Do not
 * know how to serialize a BigInt"). The throw happens before the provider is
 * asked anything, so the person is told their sign-up "would not sign that" when
 * in fact nobody was ever asked. MEASURED 2026-10-23 in the acceptance probe's
 * stage G: the call count showed only `eth_signTransaction`.
 *
 * A quantity goes over as a hex string, which is the shape every EIP-712
 * implementation on the other side of an RPC accepts (eth-sig-util's
 * `numberToBN`, viem's encoder, ethers' `BigNumberish`), and which the wallet
 * hashes as the same uint256 a locally held key would have hashed.
 */
export const jsonSafe = (value: unknown): unknown => {
  if (typeof value === 'bigint') {
    return hexQuantity(value);
  }

  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        jsonSafe(entry),
      ]),
    );
  }

  return value;
};

/** The domain type for the domain that is actually there. */
export const eip712DomainType = (
  domain: Record<string, unknown> = {},
): { name: string; type: string }[] =>
  DOMAIN_FIELDS.filter(([name]) => domain[name] !== undefined).map(
    ([name, type]) => ({ name, type }),
  );

/** Typed data in the shape a locally held key is handed it. */
export type TypedDataLike = {
  domain?: Record<string, unknown>;
  /** Readonly on purpose: the app declares its payloads `as const`. */
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * The parameters for `eth_signTypedData_v4`: the address, then the whole payload
 * as JSON with the domain type included.
 */
export const signTypedDataParams = (
  address: string,
  typedData: TypedDataLike,
): [string, string] => [
  address,
  JSON.stringify({
    types: {
      EIP712Domain: eip712DomainType(typedData.domain),
      ...typedData.types,
    },
    primaryType: typedData.primaryType,
    domain: jsonSafe(typedData.domain ?? {}),
    message: jsonSafe(typedData.message),
  }),
];

/**
 * The account's own signing, answered by the window that holds its words.
 *
 * The result satisfies `CustodyAccount` (`~/snapchain/accounts/phrase`), which
 * is the interface everything downstream already takes — the registration, the
 * gasless KEY_ADD, the name claim — so nothing downstream needs to know where
 * the key lives. `signTransaction` also satisfies the registrar's
 * `RegistrationSigner`, which asks for an address and a signature.
 */
export const heldWalletCustody = ({
  address,
  provider,
  label = 'your sign-up',
}: {
  address: `0x${string}`;
  provider: HeldWalletProvider;
  /** How the provider is named when it refuses ("your Google sign-up"). */
  label?: string;
}): CustodyAccount => ({
  address,

  signTransaction: async (transaction: unknown) => {
    let signed: unknown;

    try {
      signed = await provider.request({
        method: ETH_SIGN_TRANSACTION,
        params: signTransactionParams({
          from: address,
          transaction: transaction as HeldUnsignedTransaction,
        }),
      });
    } catch {
      throw new HeldWalletSigningError(
        `${label} would not sign that. Nothing was sent — try again, or use another way in.`,
      );
    }

    if (!isRawTransaction(signed)) {
      throw new HeldWalletSigningError(
        `${label} answered with something that is not a signed transaction. Nothing was sent.`,
      );
    }

    return signed;
  },

  signTypedData: async (typedData: unknown) => {
    let signature: unknown;

    try {
      signature = await provider.request({
        method: ETH_SIGN_TYPED_DATA_V4,
        params: signTypedDataParams(address, typedData as TypedDataLike),
      });
    } catch {
      throw new HeldWalletSigningError(
        `${label} would not sign that. Nothing was changed — try again.`,
      );
    }

    if (!isSignature(signature)) {
      throw new HeldWalletSigningError(
        `${label} answered with something that is not a signature. Nothing was changed.`,
      );
    }

    return signature;
  },
});
