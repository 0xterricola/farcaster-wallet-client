import { Provider } from 'ox';
import {
  Address,
  Chain,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  Hex,
  isAddress,
  parseUnits,
  PublicClient,
  toHex,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import { estimateTotalFee } from 'viem/op-stack';

import { ensureEvmWalletAccount } from '~/utils/sendBaseNativeToken';

export type BaseTransferInput = {
  address: Address;
  recipient: string;
  amount: string;
  tokenAddress?: Address;
};
type TransferCall = {
  account: Address;
  to: Address;
  value: bigint;
  data?: Hex;
};
export type BaseTransferReader = {
  nativeBalance: (address: Address) => Promise<bigint>;
  tokenDetails: (
    token: Address,
    address: Address,
  ) => Promise<{ symbol: string; decimals: number; balance: bigint }>;
  simulateToken: (call: TransferCall) => Promise<void>;
  estimateFee: (call: TransferCall) => Promise<bigint>;
};
export type PreparedBaseTransfer = {
  input: BaseTransferInput;
  call: TransferCall;
  units: bigint;
  decimals: number;
  symbol: string;
  balance: bigint;
  estimatedFee: bigint;
  preparedAt: number;
  chain: Pick<Chain, 'id' | 'name' | 'nativeCurrency'>;
};

export function createBaseTransferReader(
  client: PublicClient,
): BaseTransferReader {
  if (client.chain?.id !== base.id) {
    throw new Error('Base RPC is required.');
  }
  return {
    nativeBalance: (address) => client.getBalance({ address }),
    tokenDetails: async (token, address) => {
      const [symbol, decimals, balance] = await Promise.all([
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'symbol',
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }),
      ]);
      return { symbol, decimals, balance };
    },
    simulateToken: async (call) => {
      const response = await client.call(call);
      // Some widely used ERC-20 contracts return no value. Explicit false or
      // malformed return data must not be mistaken for a successful transfer.
      if (response.data && response.data !== '0x') {
        const success = decodeFunctionResult({
          abi: erc20Abi,
          functionName: 'transfer',
          data: response.data,
        });
        if (!success) {
          throw new Error('Token transfer simulation returned false.');
        }
      }
    },
    // This installed viem version estimates L1 data + L2 execution fees.
    // It is an estimate, not a guaranteed final fee or support for sponsored gas.
    estimateFee: (call) => estimateTotalFee(client, { ...call, chain: base }),
  };
}

export function parseTransferAmount(amount: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Token decimals are invalid.');
  }
  const normalized = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('Enter a positive decimal amount.');
  }
  if ((normalized.split('.')[1]?.length ?? 0) > decimals) {
    throw new Error(`This asset supports at most ${decimals} decimal places.`);
  }
  const units = parseUnits(normalized, decimals);
  if (units <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return units;
}

export async function prepareBaseTransfer(
  reader: BaseTransferReader,
  input: BaseTransferInput,
): Promise<PreparedBaseTransfer> {
  return prepareEvmTransfer(reader, input, base);
}

export async function prepareEvmTransfer(
  reader: BaseTransferReader,
  input: BaseTransferInput,
  chain: Pick<Chain, 'id' | 'name' | 'nativeCurrency'>,
): Promise<PreparedBaseTransfer> {
  const recipient = input.recipient.trim();
  if (!isAddress(recipient) || recipient.toLowerCase() === zeroAddress) {
    throw new Error('Enter a valid, non-zero recipient address.');
  }
  const tokenAddress = input.tokenAddress;
  if (
    tokenAddress &&
    (!isAddress(tokenAddress) ||
      tokenAddress.toLowerCase() === zeroAddress ||
      tokenAddress.toLowerCase() ===
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
  ) {
    throw new Error(`Choose a valid ${chain.name} ERC-20 contract.`);
  }
  const nativeBalance = await reader.nativeBalance(input.address);
  const details = tokenAddress
    ? await reader.tokenDetails(tokenAddress, input.address)
    : {
        symbol: chain.nativeCurrency.symbol,
        decimals: chain.nativeCurrency.decimals,
        balance: nativeBalance,
      };
  const units = parseTransferAmount(input.amount, details.decimals);
  if (units > details.balance) {
    throw new Error(
      `Insufficient ${details.symbol} balance. Available: ${formatUnits(details.balance, details.decimals)} ${details.symbol} on ${chain.name}.`,
    );
  }
  const call: TransferCall = {
    account: input.address,
    to: tokenAddress ?? getAddress(recipient),
    value: tokenAddress ? 0n : units,
    ...(tokenAddress
      ? {
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [getAddress(recipient), units],
          }),
        }
      : {}),
  };
  if (tokenAddress) {
    await reader.simulateToken(call);
  }
  const estimatedFee = await reader.estimateFee(call);
  if (estimatedFee < 0n) {
    throw new Error('Invalid network fee estimate.');
  }
  const feeReserve = (estimatedFee * 120n + 99n) / 100n;
  if (nativeBalance < call.value + feeReserve) {
    throw new Error(
      `Not enough ${chain.nativeCurrency.symbol} on ${chain.name} for this send and estimated gas (including a 20% fee buffer).`,
    );
  }
  return {
    input: { ...input, recipient: getAddress(recipient) },
    call,
    units,
    decimals: details.decimals,
    symbol: details.symbol,
    balance: details.balance,
    estimatedFee,
    preparedAt: Date.now(),
    chain,
  };
}

export async function submitBaseTransfer({
  provider,
  reader,
  prepared,
  isCurrent = () => true,
}: {
  provider: Pick<Provider.Provider, 'request'>;
  reader: BaseTransferReader;
  prepared: PreparedBaseTransfer;
  isCurrent?: () => boolean;
}) {
  return submitEvmTransfer({ provider, reader, prepared, isCurrent });
}

export async function submitEvmTransfer({
  provider,
  reader,
  prepared,
  isCurrent = () => true,
}: {
  provider: Pick<Provider.Provider, 'request'>;
  reader: BaseTransferReader;
  prepared: PreparedBaseTransfer;
  isCurrent?: () => boolean;
}) {
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error('Wallet or form changed. Review the send again.');
    }
    if (Date.now() - prepared.preparedAt > 60_000) {
      throw new Error('Review expired. Refresh the review before sending.');
    }
  };
  assertCurrent();
  await ensureEvmWalletAccount(
    provider,
    prepared.input.address,
    prepared.chain,
  );
  assertCurrent();
  const fresh = await prepareEvmTransfer(
    reader,
    prepared.input,
    prepared.chain,
  );
  if (
    fresh.units !== prepared.units ||
    fresh.decimals !== prepared.decimals ||
    fresh.call.to !== prepared.call.to ||
    fresh.call.data !== prepared.call.data ||
    fresh.call.value !== prepared.call.value
  ) {
    throw new Error('Token details changed. Review the send again.');
  }
  // A miniapp may have changed networks while the live checks were running.
  await ensureEvmWalletAccount(
    provider,
    prepared.input.address,
    prepared.chain,
    false,
  );
  assertCurrent();
  return provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: prepared.input.address,
        to: fresh.call.to,
        value: toHex(fresh.call.value),
        ...(fresh.call.data ? { data: fresh.call.data } : {}),
        chainId: toHex(prepared.chain.id),
      },
    ],
  });
}
