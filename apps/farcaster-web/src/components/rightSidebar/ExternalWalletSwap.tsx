import { useQueryClient } from '@tanstack/react-query';
import React, { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Address,
  Chain,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  Hash,
  toHex,
  zeroAddress,
} from 'viem';
import { arbitrum, base, bsc } from 'viem/chains';
import { usePublicClient, useWaitForTransactionReceipt } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useWallet } from '~/contexts/WalletProvider';
import {
  fetchFreshLifiAsset,
  refreshLifiWallet,
  useLifiAsset,
  useLifiWalletTokens,
} from '~/hooks/useLifiWallet';
import { parseTransferAmount } from '~/utils/baseWalletTransfer';
import { truncateAddress } from '~/utils/ethereumUtils';
import { fetchLifiQuote, LifiQuote } from '~/utils/lifiSwap';
import { LifiAsset, LifiToken, normalizeLifiAddress } from '~/utils/lifiWallet';
import { readConfirmedAllowance } from '~/utils/readConfirmedAllowance';
import { ensureEvmWalletAccount } from '~/utils/sendBaseNativeToken';

type Review = {
  quote: LifiQuote;
  from: LifiAsset;
  to: LifiAsset;
  units: bigint;
  allowance?: bigint;
};

// Default USDC contracts for the token picker. Base, Ethereum and Arbitrum use
// Circle-issued native USDC. BNB Smart Chain uses verified Binance-Peg USDC,
// because Circle does not issue native USDC on BSC. Balances, metadata and
// quotes still use the shared LI.FI/RPC path.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// https://bscscan.com/token/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d
const DEFAULT_USDC: ReadonlyMap<number, LifiToken> = new Map([
  [
    base.id,
    {
      chainId: base.id,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [
    1,
    {
      chainId: 1,
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [
    arbitrum.id,
    {
      chainId: arbitrum.id,
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [
    bsc.id,
    {
      chainId: bsc.id,
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 18,
    },
  ],
]);

function isDefaultUsdc(token: LifiToken, defaultUsdc?: LifiToken) {
  return (
    defaultUsdc !== undefined &&
    token.chainId === defaultUsdc.chainId &&
    token.address.toLowerCase() === defaultUsdc.address.toLowerCase()
  );
}

function defaultUsdcLabel(chain: Chain) {
  return chain.id === bsc.id
    ? `Binance-Peg USDC on ${chain.name}`
    : `native USDC on ${chain.name}`;
}

export function ExternalWalletSwap({ chain = base }: { chain?: Chain }) {
  const { address, provider } = useWallet();
  const queryClient = useQueryClient();
  const client = usePublicClient({ chainId: chain.id });
  const defaultUsdc = DEFAULT_USDC.get(chain.id);
  const [fromInput, setFromInput] = useState(chain.nativeCurrency.symbol);
  const [toInput, setToInput] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<Hash>();
  const [replacement, setReplacement] = useState<string>();
  const [showUnverified, setShowUnverified] = useState(false);
  const generation = useRef(0);
  const locked = useRef(false);
  const {
    data: walletTokens,
    isPending: tokensPending,
    isError: tokensError,
    isFetching: tokensFetching,
    refetch: refetchTokens,
  } = useLifiWalletTokens(address, chain);
  const allTokens = (walletTokens?.tokens ?? [])
    .filter(
      (token) => token.chainId === chain.id && token.address !== zeroAddress,
    )
    .map((token) => (isDefaultUsdc(token, defaultUsdc) ? defaultUsdc! : token));
  const unverifiedCount = allTokens.filter(
    (token) =>
      !isDefaultUsdc(token, defaultUsdc) &&
      token.verificationStatus !== 'verified',
  ).length;
  const tokenOptions = allTokens.filter(
    (token) =>
      isDefaultUsdc(token, defaultUsdc) ||
      showUnverified ||
      token.verificationStatus === 'verified',
  );
  const buyTokenOptions = [
    ...(defaultUsdc ? [defaultUsdc] : []),
    ...tokenOptions.filter((token) => !isDefaultUsdc(token, defaultUsdc)),
  ];
  const fromBalance = useLifiAsset(
    address,
    inputAddress(fromInput, chain),
    chain,
  );
  const toBalance = useLifiAsset(address, inputAddress(toInput, chain), chain);
  const { data: receipt, isError: receiptError } = useWaitForTransactionReceipt(
    {
      hash,
      chainId: chain.id,
      timeout: 60_000,
      onReplaced: (transaction) => setReplacement(transaction.reason),
    },
  );
  useEffect(() => {
    generation.current += 1;
    setReview(undefined);
    setStatus(undefined);
    return () => {
      generation.current += 1;
    };
  }, [address, provider, chain.id]);
  const receiptHash = receipt?.transactionHash;
  useEffect(() => {
    if (address && receiptHash) {
      void refreshLifiWallet(queryClient, address, chain.id);
    }
  }, [receiptHash, address, queryClient, chain.id]);

  const edit = () => {
    generation.current += 1;
    setReview(undefined);
    setStatus(undefined);
    setError(undefined);
  };
  const load = async (token: Address) => {
    if (!address || !client) {
      throw new Error(`Connect a wallet with a ${chain.name} connection.`);
    }
    return fetchFreshLifiAsset(queryClient, client, address, token, chain);
  };
  const checkBalance = (asset: LifiAsset, units: bigint) => {
    if (asset.balance < units) {
      throw new Error(
        `Insufficient ${asset.symbol} balance. Available: ${formatUnits(asset.balance, asset.decimals)} ${asset.symbol} on ${chain.name}.`,
      );
    }
  };

  const getQuote = async (event: FormEvent) => {
    event.preventDefault();
    if (!address || locked.current) {
      return;
    }
    locked.current = true;
    const version = generation.current;
    setBusy(true);
    setError(undefined);
    setReview(undefined);
    setStatus(undefined);
    try {
      const fromAddress = normalizeLifiAddress(
        fromInput,
        chain.nativeCurrency.symbol,
      );
      const toAddress = normalizeLifiAddress(
        toInput,
        chain.nativeCurrency.symbol,
      );
      if (fromAddress === toAddress) {
        throw new Error('Choose two different tokens.');
      }
      const [from, to] = await Promise.all([
        load(fromAddress),
        load(toAddress),
      ]);
      const units = parseTransferAmount(amount, from.decimals);
      checkBalance(from, units);
      const quote = await fetchLifiQuote(address, from, to, units, chain);
      if (version !== generation.current) {
        return;
      }
      let allowance: bigint | undefined;
      if (from.address !== zeroAddress) {
        const spender = quote.estimate.approvalAddress;
        if (!client || !spender) {
          throw new Error('Cannot check token approval for this quote.');
        }
        setStatus('Checking token approval…');
        allowance = await client.readContract({
          address: from.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, spender],
        });
      }
      if (version === generation.current) {
        setReview({ quote, from, to, units, allowance });
        setStatus(undefined);
      }
    } catch (failure) {
      if (version === generation.current) {
        setStatus(undefined);
        setError(
          failure instanceof Error ? failure.message : 'Could not get a quote.',
        );
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const needsApproval = Boolean(
    review &&
    review.from.address !== zeroAddress &&
    (review.allowance === undefined || review.allowance < review.units),
  );

  const swap = async () => {
    if (!address || !provider || !client || !review || locked.current) {
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    setHash(undefined);
    setReplacement(undefined);
    const version = generation.current;
    const assertCurrent = () => {
      if (version !== generation.current) {
        throw new Error('Wallet or form changed. Get a new quote.');
      }
    };
    try {
      await ensureEvmWalletAccount(provider, address, chain);
      assertCurrent();
      const from = await load(review.from.address);
      assertCurrent();
      if (from.decimals !== review.from.decimals) {
        throw new Error('Token decimals changed. Get a new quote.');
      }
      checkBalance(from, review.units);
      let quote = await fetchLifiQuote(
        address,
        from,
        review.to,
        review.units,
        chain,
      );
      assertCurrent();
      const checkChanges = (next: LifiQuote) => {
        if (
          BigInt(next.estimate.toAmountMin) <
            BigInt(review.quote.estimate.toAmountMin) ||
          next.estimate.approvalAddress?.toLowerCase() !==
            review.quote.estimate.approvalAddress?.toLowerCase()
        ) {
          throw new Error(
            'Quote changed. Get a new quote and review it before swapping.',
          );
        }
      };
      checkChanges(quote);
      if (from.address !== zeroAddress) {
        const spender = quote.estimate.approvalAddress;
        if (!spender) {
          throw new Error('LI.FI did not supply an approval address.');
        }
        const allowance = await client.readContract({
          address: from.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, spender],
        });
        assertCurrent();
        if (allowance < review.units) {
          // Never turn a "Review swap" click into a new approval prompt.
          if (!needsApproval) {
            setReview({ ...review, quote, allowance });
            setStatus(
              'Allowance changed. Review the token approval before swapping.',
            );
            return;
          }
          await ensureEvmWalletAccount(provider, address, chain, false);
          assertCurrent();
          setStatus(
            `Approve exactly ${formatUnits(review.units, from.decimals)} ${from.symbol} in your wallet…`,
          );
          const approvalHash = (await provider.request({
            method: 'eth_sendTransaction',
            params: [
              {
                chainId: toHex(chain.id),
                from: address,
                to: from.address,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [spender, review.units],
                }),
              },
            ],
          })) as Hash;
          assertCurrent();
          setStatus('Waiting for token approval…');
          const approvalReceipt = await client.waitForTransactionReceipt({
            hash: approvalHash,
          });
          assertCurrent();
          if (approvalReceipt.status !== 'success') {
            throw new Error('Token approval reverted. Swap was not sent.');
          }
          setStatus(
            'Approval confirmed. Checking allowance and refreshing the swap…',
          );
          quote = await fetchLifiQuote(
            address,
            from,
            review.to,
            review.units,
            chain,
          );
          assertCurrent();
          checkChanges(quote);
          const approved = await readConfirmedAllowance({
            read: () =>
              client.readContract({
                address: from.address,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [address, spender],
                // Keep every retry pinned to the confirmed approval block.
                blockNumber: approvalReceipt.blockNumber,
              }),
            assertCurrent,
            onRetry: () =>
              setStatus(
                `Approval confirmed. Waiting for ${chain.name} RPC to catch up…`,
              ),
            chainName: chain.name,
          });
          assertCurrent();
          if (approved < review.units) {
            throw new Error(
              'Token allowance is still insufficient. Swap was not sent.',
            );
          }
          setReview({ ...review, quote, allowance: approved });
          setStatus('Approval confirmed. Ready to review swap.');
          return;
        }
        if (needsApproval) {
          setReview({ ...review, quote, allowance });
          setStatus('Already approved. Ready to review swap.');
          return;
        }
      }
      const latest = await load(from.address);
      const native =
        from.address === zeroAddress ? latest : await load(zeroAddress);
      assertCurrent();
      if (latest.decimals !== from.decimals) {
        throw new Error('Token decimals changed. Get a new quote.');
      }
      checkBalance(latest, review.units);
      const tx = quote.transactionRequest;
      if (native.balance < BigInt(tx.value ?? '0')) {
        throw new Error(
          `Insufficient ${chain.nativeCurrency.symbol} on ${chain.name} for the swap value.`,
        );
      }
      await ensureEvmWalletAccount(provider, address, chain, false);
      assertCurrent();
      setStatus('Review swap and network fees in your wallet…');
      const transactionHash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            chainId: toHex(chain.id),
            from: address,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gas: tx.gasLimit,
            gasPrice: tx.gasPrice,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          },
        ],
      })) as Hash;
      setHash(transactionHash);
      setStatus('Swap submitted. Waiting for confirmation…');
      setReview(undefined);
      void refreshLifiWallet(queryClient, address, chain.id);
    } catch (failure) {
      if (version === generation.current) {
        setError(
          failure instanceof Error ? failure.message : 'Swap was not sent.',
        );
        setStatus(undefined);
        setReview(undefined);
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const transactionStatus =
    replacement === 'cancelled'
      ? 'Swap transaction cancelled.'
      : replacement === 'replaced'
        ? `Transaction replaced. Check ${chain.blockExplorers?.default.name ?? 'the block explorer'}.`
        : receipt
          ? receipt.status === 'success'
            ? `Swap confirmed on ${chain.name}.`
            : `Swap reverted on ${chain.name}.`
          : receiptError
            ? `Confirmation unavailable. Check ${chain.blockExplorers?.default.name ?? 'the block explorer'} before trying again.`
            : 'Swap submitted. Waiting for confirmation…';
  const explorer = chain.blockExplorers?.default;

  return (
    <div className="flex flex-col gap-4 pt-4">
      <p className="rounded-xl p-3 text-xs text-muted bg-elevated-nohover">
        {chain.name} only. LI.FI supplies token data and swap routes. Choose a
        wallet token or enter {chain.nativeCurrency.symbol} / a {chain.name}{' '}
        contract. Verify contracts before approving.
      </p>
      <form className="flex flex-col gap-4" onSubmit={getQuote}>
        <fieldset className="flex min-w-0 flex-col gap-4" disabled={busy}>
          {unverifiedCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={showUnverified}
                onChange={(event) => setShowUnverified(event.target.checked)}
              />
              Show unverified tokens ({unverifiedCount})
            </label>
          )}
          {showUnverified && (
            <p className="text-xs text-muted">
              Unverified tokens may include spam. Check the contract before
              approving; names and verification labels are not a safety
              guarantee.
            </p>
          )}
          {tokensPending && (
            <p className="text-xs text-muted">
              Loading wallet token choices… You can still enter a contract.
            </p>
          )}
          {tokensError && (
            <p className="text-xs text-muted">
              LI.FI token list unavailable. Retry or enter a contract below.
            </p>
          )}
          <button
            type="button"
            className="self-start text-xs text-muted underline"
            disabled={tokensFetching}
            onClick={() => void refetchTokens()}
          >
            {tokensFetching ? 'Refreshing token list…' : 'Refresh token list'}
          </button>
          <TokenInput
            label="Sell token"
            tokens={tokenOptions}
            value={fromInput}
            asset={fromBalance.isError ? undefined : fromBalance.data}
            error={fromBalance.isError}
            onChange={(value) => {
              edit();
              setFromInput(value);
            }}
            chain={chain}
            defaultUsdc={defaultUsdc}
          />
          <label className="flex flex-col gap-2 text-sm text-default">
            Amount
            <input
              className="rounded-xl border px-3 py-2 bg-app border-default"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              maxLength={100}
              onChange={(event) => {
                edit();
                setAmount(event.target.value);
              }}
            />
          </label>
          <TokenInput
            label="Buy token"
            tokens={buyTokenOptions}
            value={toInput}
            asset={toBalance.isError ? undefined : toBalance.data}
            error={toBalance.isError}
            onChange={(value) => {
              edit();
              setToInput(value);
            }}
            chain={chain}
            defaultUsdc={defaultUsdc}
          />
          <DefaultButton type="submit" disabled={busy || !address || !client}>
            {busy ? 'Checking wallet…' : review ? 'Refresh quote' : 'Get quote'}
          </DefaultButton>
        </fieldset>
      </form>
      {review && (
        <section
          aria-label={`Review ${chain.name} swap`}
          className="rounded-xl p-4 bg-elevated-nohover"
        >
          <div className="text-xs text-muted">Estimated receive</div>
          <div className="mt-1 break-all text-xl font-semibold text-default">
            {formatUnits(
              BigInt(review.quote.estimate.toAmount),
              review.to.decimals,
            )}{' '}
            {review.to.symbol}
          </div>
          <div className="mt-1 break-all text-xs text-muted">
            Minimum{' '}
            {formatUnits(
              BigInt(review.quote.estimate.toAmountMin),
              review.to.decimals,
            )}{' '}
            {review.to.symbol} · Route: {review.quote.tool}
          </div>
          <div aria-label="Token approval" className="mt-3 text-xs text-muted">
            {review.from.address === zeroAddress ? (
              <p>
                Native {chain.nativeCurrency.symbol} does not need token
                approval.
              </p>
            ) : (
              <>
                <p>
                  Approved:{' '}
                  {formatUnits(review.allowance ?? 0n, review.from.decimals)}{' '}
                  {review.from.symbol}
                  {' · '}Required:{' '}
                  {formatUnits(review.units, review.from.decimals)}{' '}
                  {review.from.symbol}
                </p>
                <p className="break-all">
                  {chain.name} spender: {review.quote.estimate.approvalAddress}
                </p>
                <p>
                  {needsApproval
                    ? 'Approve the exact sell amount, wait for confirmation, then review the swap.'
                    : 'Sufficient approval. Allowance will be checked again before swapping.'}
                </p>
              </>
            )}
          </div>
          <DefaultButton
            type="button"
            className="mt-4 w-full"
            disabled={busy}
            onClick={() => void swap()}
          >
            {busy
              ? 'Working…'
              : needsApproval
                ? `Approve ${review.from.symbol}`
                : 'Review swap'}
          </DefaultButton>
        </section>
      )}
      {(status || hash) && (
        <p
          role="status"
          className="rounded-xl p-3 text-sm bg-elevated-nohover text-default"
        >
          {hash ? transactionStatus : status}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-3 text-sm text-red-600"
        >
          {error}
        </p>
      )}
      {hash && explorer && (
        <a
          className="text-accent-primary text-sm hover:underline"
          href={`${explorer.url}/tx/${receipt?.transactionHash ?? hash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View {truncateAddress(hash, 8)} on {explorer.name}
        </a>
      )}
    </div>
  );
}

function inputAddress(input: string, chain: Chain) {
  try {
    return normalizeLifiAddress(input, chain.nativeCurrency.symbol);
  } catch {
    return undefined;
  }
}

function TokenInput({
  label,
  tokens,
  value,
  asset,
  error,
  onChange,
  chain,
  defaultUsdc,
}: {
  label: string;
  tokens: LifiToken[];
  value: string;
  asset?: LifiAsset;
  error: boolean;
  onChange: (value: string) => void;
  chain: Chain;
  defaultUsdc?: LifiToken;
}) {
  const address = inputAddress(value, chain);
  const selected =
    address === zeroAddress
      ? chain.nativeCurrency.symbol
      : (tokens.find(
          (token) => token.address.toLowerCase() === address?.toLowerCase(),
        )?.address ?? 'custom');
  return (
    <div className="flex flex-col gap-2 text-sm text-default">
      <label className="flex flex-col gap-2">
        {label === 'Sell token' ? 'Choose sell asset' : 'Choose buy asset'}
        <select
          className="w-full rounded-xl border px-3 py-2 bg-app border-default"
          value={selected}
          onChange={(event) =>
            onChange(event.target.value === 'custom' ? '' : event.target.value)
          }
        >
          <option value={chain.nativeCurrency.symbol}>
            {chain.nativeCurrency.symbol} — native asset
          </option>
          {tokens.map((token) => (
            <option key={token.address} value={token.address}>
              {token.symbol} —{' '}
              {isDefaultUsdc(token, defaultUsdc)
                ? defaultUsdcLabel(chain)
                : truncateAddress(token.address, 4)}
              {!isDefaultUsdc(token, defaultUsdc) &&
              token.verificationStatus !== 'verified'
                ? ' (unverified)'
                : ''}
            </option>
          ))}
          <option value="custom">Enter a contract below…</option>
        </select>
      </label>
      <label className="flex flex-col gap-2">
        {label}
        <input
          className="rounded-xl border px-3 py-2 bg-app border-default"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={`${chain.nativeCurrency.symbol} or 0x…`}
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
        />
      </label>
      <span className="break-all text-xs text-muted">
        {error
          ? 'Balance unavailable. Check the contract or refresh.'
          : asset
            ? `Available on ${chain.name}: ${formatUnits(asset.balance, asset.decimals)} ${asset.symbol}`
            : inputAddress(value, chain)
              ? `Loading balance on ${chain.name}…`
              : 'Enter a token contract.'}
      </span>
    </div>
  );
}
