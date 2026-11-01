import { useQueryClient } from '@tanstack/react-query';
import { hyperevm, robinhood } from 'farcaster-client-data';
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
import { arbitrum, base, bsc, celo, monad } from 'viem/chains';
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
import {
  fetchLifiQuote,
  fetchLifiTransferStatus,
  lifiMoveErrorMessage,
  LifiMoveState,
  LifiQuote,
  readLifiQuoteCost,
  toLifiSwapAsset,
} from '~/utils/lifiSwap';
import {
  createLifiNativeToken,
  fetchLifiToken,
  isNativeWalletAsset,
  LifiAsset,
  LifiToken,
  normalizeLifiAddress,
} from '~/utils/lifiWallet';
import { readConfirmedAllowance } from '~/utils/readConfirmedAllowance';
import { ensureEvmWalletAccount } from '~/utils/sendBaseNativeToken';
import {
  recordPendingWalletActivity,
  settleLocalWalletActivity,
} from '~/utils/walletActivity';
import { MOVE_DESTINATION_CHAINS } from '~/utils/walletNetwork';

type Review = {
  quote: LifiQuote;
  from: LifiAsset;
  to: LifiAsset;
  units: bigint;
  allowance?: bigint;
};

// A move that has not landed yet. `unfinished` is where the polling stops
// without an answer — the honest end of "we do not know", never a guess.
type Move = {
  toChainId: number;
  toChainName: string;
  state: LifiMoveState | 'unfinished';
  sendingTxHash?: Hash;
  receivingTxHash?: Hash;
};

// How often a sent move asks whether it arrived, and for how long. Ten minutes
// is past every route this sheet quotes; after that the explorer link is the
// only honest answer left.
const MOVE_POLL_MS = 10_000;
const MOVE_POLL_ATTEMPTS = 60;

// Money in the words the sheet uses. A sub-cent number is "under $0.01", never a
// rounded-up claim about a cent nobody reported.
const usdCopy = (value: number, prefix = 'about ') =>
  value < 0.01
    ? 'under $0.01'
    : `${prefix}${value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}`;

const arrivalCopy = (seconds: number) =>
  seconds <= 90 ? 'about a minute' : `about ${Math.ceil(seconds / 60)} minutes`;

// Default stablecoin contracts for the token picker. Base, Ethereum, Arbitrum,
// Celo and HyperEVM use Circle-issued native USDC. BNB Smart Chain uses verified
// Binance-Peg USDC because Circle does not issue native USDC on BSC. Monad uses
// the verified USDC configured by the Farcaster client. Robinhood Chain uses
// the canonical USDG contract published in its official documentation.
// Balances, metadata and quotes still use the shared LI.FI/RPC path.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// https://bscscan.com/token/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d
// https://docs.robinhood.com/chain/contracts/
const DEFAULT_STABLECOIN: ReadonlyMap<number, LifiToken> = new Map([
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
  [
    celo.id,
    {
      chainId: celo.id,
      address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [
    monad.id,
    {
      chainId: monad.id,
      address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [
    hyperevm.id,
    {
      chainId: hyperevm.id,
      address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  [
    robinhood.id,
    {
      chainId: robinhood.id,
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      symbol: 'USDG',
      name: 'USDG',
      decimals: 6,
    },
  ],
]);

function isDefaultStablecoin(token: LifiToken, defaultStablecoin?: LifiToken) {
  return (
    defaultStablecoin !== undefined &&
    token.chainId === defaultStablecoin.chainId &&
    token.address.toLowerCase() === defaultStablecoin.address.toLowerCase()
  );
}

function defaultStablecoinLabel(chain: Chain) {
  if (chain.id === bsc.id) {
    return `Binance-Peg USDC on ${chain.name}`;
  }
  if (chain.id === robinhood.id) {
    return `canonical USDG on ${chain.name}`;
  }
  return `native USDC on ${chain.name}`;
}

export function ExternalWalletSwap({
  chain = base,
  initialBuyTokenAddress,
}: {
  chain?: Chain;
  initialBuyTokenAddress?: Address;
}) {
  const { address, provider } = useWallet();
  const queryClient = useQueryClient();
  const client = usePublicClient({ chainId: chain.id });
  const defaultStablecoin = DEFAULT_STABLECOIN.get(chain.id);
  const [toChainId, setToChainId] = useState(chain.id);
  const toChain = MOVE_DESTINATION_CHAINS.get(toChainId) ?? chain;
  const destinationStablecoin = DEFAULT_STABLECOIN.get(toChain.id);
  const crossing = toChain.id !== chain.id;
  const [fromInput, setFromInput] = useState(chain.nativeCurrency.symbol);
  const [toInput, setToInput] = useState(initialBuyTokenAddress ?? '');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<Hash>();
  const [move, setMove] = useState<Move>();
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
  // What this wallet already holds where the move would land. Read only when the
  // move has a destination, and never used as a sell balance.
  const { data: destinationTokens } = useLifiWalletTokens(
    crossing ? address : undefined,
    toChain,
  );
  const allTokens = (walletTokens?.tokens ?? [])
    .filter(
      (token) =>
        token.chainId === chain.id &&
        !isNativeWalletAsset(token.address, chain.id),
    )
    .map((token) =>
      isDefaultStablecoin(token, defaultStablecoin)
        ? defaultStablecoin!
        : token,
    );
  const unverifiedCount = allTokens.filter(
    (token) =>
      !isDefaultStablecoin(token, defaultStablecoin) &&
      token.verificationStatus !== 'verified',
  ).length;
  const tokenOptions = allTokens.filter(
    (token) =>
      isDefaultStablecoin(token, defaultStablecoin) ||
      showUnverified ||
      token.verificationStatus === 'verified',
  );
  const buyTokenOptions = [
    ...(defaultStablecoin ? [defaultStablecoin] : []),
    ...tokenOptions.filter(
      (token) => !isDefaultStablecoin(token, defaultStablecoin),
    ),
  ];
  // A move lands on a chain this wallet may hold nothing on — that is the whole
  // point of a move — so the destination picker offers the chain's own coin
  // (always the first option in the picker below), its usual stablecoin, and
  // whatever is already held there. Any other contract can still be typed in.
  const destinationBuyOptions = [
    ...(destinationStablecoin ? [destinationStablecoin] : []),
    ...(destinationTokens?.tokens ?? []).filter(
      (token) =>
        token.chainId === toChain.id &&
        !isNativeWalletAsset(token.address, toChain.id) &&
        token.verificationStatus === 'verified' &&
        !isDefaultStablecoin(token, destinationStablecoin),
    ),
  ];
  const buyChoices = crossing ? destinationBuyOptions : buyTokenOptions;
  const fromBalance = useLifiAsset(
    address,
    inputAddress(fromInput, chain),
    chain,
  );
  // A destination token has no balance to read on this chain: what the sheet
  // shows for it is what the move says it will deliver.
  const toBalance = useLifiAsset(
    address,
    crossing ? undefined : inputAddress(toInput, toChain),
    chain,
  );
  const { data: receipt, isError: receiptError } = useWaitForTransactionReceipt(
    {
      hash,
      chainId: chain.id,
      timeout: 60_000,
      onReplaced: (transaction) => setReplacement(transaction.reason),
    },
  );
  const moveConfirmed = receipt?.status === 'success';
  useEffect(() => {
    generation.current += 1;
    setReview(undefined);
    setStatus(undefined);
    setMove(undefined);
    setToChainId(chain.id);
    return () => {
      generation.current += 1;
    };
  }, [address, provider, chain.id]);
  const receiptHash = receipt?.transactionHash;
  useEffect(() => {
    if (address && receiptHash && hash && receipt) {
      settleLocalWalletActivity(
        address,
        chain.id,
        hash,
        receipt.status === 'success' ? 'confirmed' : 'failed',
        receiptHash,
      );
      void refreshLifiWallet(queryClient, address, chain.id);
    }
  }, [receiptHash, receipt, hash, address, queryClient, chain.id]);

  // A move finishes on another chain, so the send-side receipt is only the
  // halfway point: once it lands, ask LI.FI whether the money arrived, and keep
  // asking until it says so, or until the window closes and the sheet says it
  // could not tell.
  const moveToChainId = move?.toChainId;
  const moveState = move?.state;
  useEffect(() => {
    if (!hash || moveState !== 'waiting' || moveToChainId === undefined) {
      return;
    }
    if (!moveConfirmed) {
      return;
    }
    let live = true;
    let timer: number | undefined;
    const poll = async (attempt: number) => {
      try {
        const progress = await fetchLifiTransferStatus(
          hash,
          chain.id,
          moveToChainId,
        );
        if (!live) {
          return;
        }
        if (progress.state !== 'waiting') {
          setMove((current) =>
            current ? { ...current, ...progress } : current,
          );
          return;
        }
      } catch {
        // LI.FI could not say where the move is. Keep asking until the window
        // closes, then say so; the explorer link stays on screen throughout.
      }
      if (!live) {
        return;
      }
      if (attempt + 1 >= MOVE_POLL_ATTEMPTS) {
        setMove((current) =>
          current ? { ...current, state: 'unfinished' } : current,
        );
        return;
      }
      timer = window.setTimeout(() => void poll(attempt + 1), MOVE_POLL_MS);
    };
    void poll(0);
    return () => {
      live = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [chain.id, hash, moveConfirmed, moveState, moveToChainId]);

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
  const chooseDestination = (chainId: number) => {
    edit();
    setToChainId(chainId);
    setToInput(
      chainId === chain.id
        ? (initialBuyTokenAddress ?? '')
        : (DEFAULT_STABLECOIN.get(chainId)?.address ?? ''),
    );
  };
  // The bought asset when it lives on another chain: metadata comes from the
  // destination list, or from LI.FI's token endpoint for a contract typed in by
  // hand. Its balance is zero because this wallet holds it there, not here.
  const destinationAsset = async (token: Address): Promise<LifiAsset> => {
    if (token === zeroAddress) {
      return { ...createLifiNativeToken(toChain), balance: 0n };
    }
    const known =
      destinationStablecoin &&
      destinationStablecoin.address.toLowerCase() === token.toLowerCase()
        ? destinationStablecoin
        : destinationTokens?.tokens.find(
            (entry) => entry.address.toLowerCase() === token.toLowerCase(),
          );
    return {
      ...(known ??
        (await fetchLifiToken(
          token,
          undefined,
          toChain.id,
          toChain.nativeCurrency.symbol,
        ))),
      balance: 0n,
    };
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
        toChain.nativeCurrency.symbol,
      );
      // The same contract address on two chains is two different assets, so only
      // a same-chain swap is asked for two distinct tokens.
      if (!crossing && fromAddress === toAddress) {
        throw new Error('Choose two different tokens.');
      }
      const [loadedFrom, loadedTo] = await Promise.all([
        load(fromAddress),
        crossing ? destinationAsset(toAddress) : load(toAddress),
      ]);
      const from = toLifiSwapAsset(loadedFrom, chain);
      const to = toLifiSwapAsset(loadedTo, toChain);
      const units = parseTransferAmount(amount, from.decimals);
      checkBalance(from, units);
      // A same-chain swap keeps the single-chain request shape; a move names the
      // chain it lands on.
      const quote = crossing
        ? await fetchLifiQuote(address, from, to, units, chain, toChain)
        : await fetchLifiQuote(address, from, to, units, chain);
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
        const message =
          failure instanceof Error ? failure.message : 'Could not get a quote.';
        setError(
          crossing ? lifiMoveErrorMessage(message, toChain.name) : message,
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
      const from = toLifiSwapAsset(await load(review.from.address), chain);
      assertCurrent();
      if (from.decimals !== review.from.decimals) {
        throw new Error('Token decimals changed. Get a new quote.');
      }
      checkBalance(from, review.units);
      // Submit the exact route and minimum the user reviewed. Refetching here
      // can create an endless review loop when prices move between clicks.
      // Balance, allowance and the on-chain preflight below still protect a
      // stale route before any swap transaction reaches the wallet.
      const quote = review.quote;
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
          recordPendingWalletActivity({
            chainId: chain.id,
            address,
            hash: approvalHash,
            type: 'approval',
            fromAsset: {
              symbol: from.symbol,
              value: review.units.toString(),
              decimals: from.decimals,
              address: from.address,
            },
          });
          assertCurrent();
          setStatus('Waiting for token approval…');
          const approvalReceipt = await client.waitForTransactionReceipt({
            hash: approvalHash,
          });
          assertCurrent();
          if (approvalReceipt.status !== 'success') {
            settleLocalWalletActivity(
              address,
              chain.id,
              approvalHash,
              'failed',
              approvalReceipt.transactionHash,
            );
            throw new Error('Token approval reverted. Swap was not sent.');
          }
          settleLocalWalletActivity(
            address,
            chain.id,
            approvalHash,
            'confirmed',
            approvalReceipt.transactionHash,
          );
          setStatus('Approval confirmed. Checking token allowance…');
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
      setStatus(`Simulating swap on ${chain.name}…`);
      try {
        const simulation = {
          account: address,
          to: tx.to,
          data: tx.data,
          ...(tx.value ? { value: BigInt(tx.value) } : {}),
          ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
        };
        if (tx.gasPrice) {
          await client.call({
            ...simulation,
            type: 'legacy',
            gasPrice: BigInt(tx.gasPrice),
          });
        } else if (tx.maxFeePerGas && tx.maxPriorityFeePerGas) {
          await client.call({
            ...simulation,
            type: 'eip1559',
            maxFeePerGas: BigInt(tx.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
          });
        } else {
          await client.call(simulation);
        }
      } catch {
        throw new Error(
          `The selected route failed a ${chain.name} preflight simulation. No transaction was submitted. Get a new quote before trying again.`,
        );
      }
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
      recordPendingWalletActivity({
        chainId: chain.id,
        address,
        hash: transactionHash,
        type: 'swap',
        fromAsset: {
          symbol: review.from.symbol,
          value: review.units.toString(),
          decimals: review.from.decimals,
          ...(review.from.address !== zeroAddress
            ? { address: review.from.address }
            : {}),
        },
        toAsset: {
          symbol: review.to.symbol,
          value: quote.estimate.toAmount,
          decimals: review.to.decimals,
          ...(review.to.address !== zeroAddress
            ? { address: review.to.address }
            : {}),
        },
      });
      setHash(transactionHash);
      if (crossing) {
        setMove({
          toChainId: toChain.id,
          toChainName: toChain.name,
          state: 'waiting',
        });
      }
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
  // A move's states, in plain words. Nothing here says a move landed unless
  // LI.FI said it did, and the in-between state names the chain it is heading
  // for.
  const moveStatus =
    move === undefined
      ? undefined
      : receiptError
        ? `Confirmation unavailable. Check ${chain.blockExplorers?.default.name ?? 'the block explorer'} before trying again.`
        : !receipt
          ? 'Waiting for the network…'
          : receipt.status !== 'success'
            ? `The move failed on ${chain.name}. Nothing left this wallet.`
            : move.state === 'arrived'
              ? `Arrived on ${move.toChainName}.`
              : move.state === 'failed'
                ? 'The move reported a problem. Check the transaction on the explorer before trying again.'
                : move.state === 'unfinished'
                  ? 'Still waiting. Check the transaction on the explorer.'
                  : `Sent. Waiting for it to arrive on ${move.toChainName}…`;
  const cost = review ? readLifiQuoteCost(review.quote) : undefined;
  const explorer = chain.blockExplorers?.default;
  const arrivalExplorer = toChain.blockExplorers?.default;
  const arrivalHash =
    move?.state === 'arrived' ? move.receivingTxHash : undefined;

  return (
    <div className="flex flex-col gap-4 pt-4">
      <p className="rounded-xl p-3 text-xs text-muted bg-elevated-nohover">
        {crossing
          ? `${chain.name} to ${toChain.name}, in one step. You get ${
              toChain.nativeCurrency.symbol
            } or a token you already hold on ${toChain.name}; check the destination before you approve.`
          : `${chain.name} only. LI.FI supplies token data and swap routes. Choose a wallet token or enter ${chain.nativeCurrency.symbol} / a ${chain.name} contract. Verify contracts before approving.`}
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
            defaultStablecoin={defaultStablecoin}
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
          <label className="flex flex-col gap-2 text-sm text-default">
            Move to
            <select
              className="w-full rounded-xl border px-3 py-2 bg-app border-default"
              value={toChainId}
              onChange={(event) =>
                chooseDestination(Number(event.target.value))
              }
            >
              <option value={chain.id}>Stay on {chain.name}</option>
              {[...MOVE_DESTINATION_CHAINS.values()]
                .filter((option) => option.id !== chain.id)
                .map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
            </select>
          </label>
          <TokenInput
            label="Buy token"
            tokens={buyChoices}
            value={toInput}
            asset={toBalance.isError ? undefined : toBalance.data}
            error={toBalance.isError}
            onChange={(value) => {
              edit();
              setToInput(value);
            }}
            chain={toChain}
            defaultStablecoin={
              crossing ? destinationStablecoin : defaultStablecoin
            }
            note={crossing ? `Arrives on ${toChain.name}` : undefined}
          />
          <DefaultButton type="submit" disabled={busy || !address || !client}>
            {busy ? 'Checking wallet…' : review ? 'Refresh quote' : 'Get quote'}
          </DefaultButton>
        </fieldset>
      </form>
      {review && (
        <section
          aria-label={
            crossing
              ? `Review move to ${toChain.name}`
              : `Review ${chain.name} swap`
          }
          className="rounded-xl p-4 bg-elevated-nohover"
        >
          <div className="text-xs text-muted">
            {crossing ? `You get on ${toChain.name}` : 'Estimated receive'}
          </div>
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
            {review.to.symbol} · Route: {cost?.tool ?? review.quote.tool}
          </div>
          {/* Only what LI.FI actually reported: no "$0.00" and no "~0 seconds"
              standing in for a number nobody gave us. */}
          {cost?.fromUsd !== undefined && cost.toUsd !== undefined && (
            <div className="mt-1 text-xs text-muted">
              {usdCopy(cost.fromUsd)} in, {usdCopy(cost.toUsd)} out
            </div>
          )}
          {cost?.feesUsd !== undefined && (
            <div className="mt-1 text-xs text-muted">
              Network and route fees {usdCopy(cost.feesUsd, '')}
            </div>
          )}
          {crossing && cost?.seconds !== undefined && cost.seconds > 0 && (
            <div className="mt-1 text-xs text-muted">
              Arrives in {arrivalCopy(cost.seconds)}
            </div>
          )}
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
                : crossing
                  ? `Move to ${toChain.name}`
                  : 'Review swap'}
          </DefaultButton>
        </section>
      )}
      {(status || hash) && (
        <p
          role="status"
          className="rounded-xl p-3 text-sm bg-elevated-nohover text-default"
        >
          {hash ? (moveStatus ?? transactionStatus) : status}
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
      {arrivalHash && arrivalExplorer && (
        <a
          className="text-accent-primary text-sm hover:underline"
          href={`${arrivalExplorer.url}/tx/${arrivalHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View the arrival on {arrivalExplorer.name}
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
  defaultStablecoin,
  note,
}: {
  label: string;
  tokens: LifiToken[];
  value: string;
  asset?: LifiAsset;
  error: boolean;
  onChange: (value: string) => void;
  chain: Chain;
  defaultStablecoin?: LifiToken;
  note?: string;
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
              {isDefaultStablecoin(token, defaultStablecoin)
                ? defaultStablecoinLabel(chain)
                : truncateAddress(token.address, 4)}
              {!isDefaultStablecoin(token, defaultStablecoin) &&
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
              ? (note ?? `Loading balance on ${chain.name}…`)
              : 'Enter a token contract.'}
      </span>
    </div>
  );
}
