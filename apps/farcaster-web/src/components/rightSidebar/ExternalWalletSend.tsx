import { useQueryClient } from '@tanstack/react-query';
import React, { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Address,
  Chain,
  formatEther,
  formatUnits,
  Hash,
  isAddress,
  zeroAddress,
} from 'viem';
import { base } from 'viem/chains';
import { useWaitForTransactionReceipt } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useWallet } from '~/contexts/WalletProvider';
import {
  refreshLifiWallet,
  useLifiAsset,
  useLifiTransferReader,
  useLifiWalletTokens,
} from '~/hooks/useLifiWallet';
import {
  PreparedBaseTransfer,
  prepareEvmTransfer,
  submitEvmTransfer,
} from '~/utils/baseWalletTransfer';
import { truncateAddress } from '~/utils/ethereumUtils';

export function ExternalWalletSend({
  address,
  chain = base,
}: {
  address: Address;
  chain?: Chain;
}) {
  const { provider } = useWallet();
  const reader = useLifiTransferReader(chain);
  const queryClient = useQueryClient();
  const {
    data,
    isError: tokensError,
    isPending: tokensPending,
  } = useLifiWalletTokens(address, chain);
  const [showHidden, setShowHidden] = useState(false);
  const [token, setToken] = useState('native');
  const [customToken, setCustomToken] = useState('');
  const selectedAddress =
    token === 'native' ? zeroAddress : token === 'custom' ? customToken : token;
  const tokenBalance = useLifiAsset(
    address,
    isAddress(selectedAddress) ? selectedAddress : undefined,
    chain,
  );
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [prepared, setPrepared] = useState<PreparedBaseTransfer>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [hash, setHash] = useState<Hash>();
  const [replacementReason, setReplacementReason] = useState<string>();
  const operation = useRef(0);
  const locked = useRef(false);
  const identity = useRef({ address, provider, chainId: chain.id });
  identity.current = { address, provider, chainId: chain.id };

  useEffect(() => {
    operation.current += 1;
    setPrepared(undefined);
    return () => {
      operation.current += 1;
    };
  }, [address, provider, chain.id]);

  const { data: receipt, isError: receiptError } = useWaitForTransactionReceipt(
    {
      hash,
      chainId: chain.id,
      timeout: 60_000,
      onReplaced: (replacement) => setReplacementReason(replacement.reason),
    },
  );
  const balanceText = !isAddress(selectedAddress)
    ? `Enter a ${chain.name} contract to load its balance.`
    : tokenBalance.isError
      ? `Could not load balance on ${chain.name}. Try refreshing.`
      : tokenBalance.data
        ? `Available on ${chain.name}: ${formatUnits(tokenBalance.data.balance, tokenBalance.data.decimals)} ${tokenBalance.data.symbol}`
        : `Loading balance on ${chain.name}…`;
  const receiptHash = receipt?.transactionHash;
  useEffect(() => {
    if (receiptHash) {
      void refreshLifiWallet(queryClient, address, chain.id);
    }
  }, [receiptHash, queryClient, address, chain.id]);

  const tokens = (data?.tokens ?? []).filter(
    (position) =>
      position.address !== zeroAddress &&
      (showHidden || position.verificationStatus === 'verified'),
  );
  const edit = () => {
    operation.current += 1;
    setPrepared(undefined);
    setError(undefined);
  };

  const review = async (event: FormEvent) => {
    event.preventDefault();
    if (!reader || locked.current) {
      return;
    }
    locked.current = true;
    const version = ++operation.current;
    setBusy(true);
    setPrepared(undefined);
    setError(undefined);
    setHash(undefined);
    setReplacementReason(undefined);
    try {
      if (!isAddress(selectedAddress)) {
        throw new Error('Choose a valid token.');
      }
      const next = await prepareEvmTransfer(
        reader,
        {
          address,
          recipient,
          amount,
          tokenAddress:
            selectedAddress === zeroAddress ? undefined : selectedAddress,
        },
        chain,
      );
      if (version === operation.current) {
        setPrepared(next);
      }
    } catch (failure) {
      if (version === operation.current) {
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not prepare the transfer.',
        );
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const send = async () => {
    if (!provider || !reader || !prepared || locked.current) {
      return;
    }
    locked.current = true;
    const version = operation.current;
    const isCurrent = () =>
      version === operation.current &&
      identity.current.address === address &&
      identity.current.provider === provider &&
      identity.current.chainId === chain.id;
    setBusy(true);
    setError(undefined);
    try {
      const transactionHash = await submitEvmTransfer({
        provider,
        reader,
        prepared,
        isCurrent,
      });
      // A wallet may already have broadcast the transaction even if the view
      // changed while its prompt was open. Never retry a submitted request.
      if (
        identity.current.address === address &&
        identity.current.chainId === chain.id
      ) {
        setHash(transactionHash);
      }
      setPrepared(undefined);
    } catch (failure) {
      if (isCurrent()) {
        setError(
          failure instanceof Error
            ? failure.message
            : 'Transfer was not submitted.',
        );
      }
      setPrepared(undefined);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const receiptStatus =
    replacementReason === 'cancelled'
      ? 'Transaction cancelled.'
      : replacementReason === 'replaced'
        ? `Transaction replaced. Check ${chain.blockExplorers?.default.name ?? 'the block explorer'} for the replacement details.`
        : receipt
          ? receipt.status === 'success'
            ? `Transaction confirmed on ${chain.name}.`
            : `Transaction reverted on ${chain.name}.`
          : receiptError
            ? `Confirmation unavailable. Check ${chain.blockExplorers?.default.name ?? 'the block explorer'} before sending again.`
            : 'Transaction submitted. Waiting for confirmation…';
  const explorer = chain.blockExplorers?.default;

  return (
    <div className="flex flex-col gap-4 pt-4">
      <p className="text-sm text-muted">
        Send {chain.nativeCurrency.symbol} or an ERC-20 token on {chain.name}.
        Token transfers do not require an allowance approval.
      </p>
      <form className="flex flex-col gap-4" onSubmit={review}>
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm text-default">
            Asset
            <select
              className="w-full rounded-xl border px-3 py-2 bg-app border-default"
              value={token}
              onChange={(event) => {
                edit();
                setToken(event.target.value);
              }}
            >
              <option value="native">
                {chain.nativeCurrency.symbol} — native asset
              </option>
              {tokens.map((position) => (
                <option key={position.address} value={position.address}>
                  {position.symbol ?? position.name ?? 'Unknown token'} —{' '}
                  {truncateAddress(position.address!, 4)}
                </option>
              ))}
              <option value="custom">Enter token contract…</option>
            </select>
          </label>
          {token === 'custom' && (
            <label className="flex flex-col gap-2 text-sm text-default">
              {chain.name} token contract
              <input
                className="rounded-xl border px-3 py-2 bg-app border-default"
                placeholder="0x…"
                value={customToken}
                onChange={(event) => {
                  edit();
                  setCustomToken(event.target.value.trim());
                }}
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => {
                edit();
                setShowHidden(event.target.checked);
                setToken('native');
              }}
            />
            Include unverified tokens
          </label>
          {showHidden && (
            <p className="text-xs text-muted">
              Unverified tokens may include spam. Verify the contract; token
              names are not a safety guarantee.
            </p>
          )}
          {tokensPending && (
            <p className="text-xs text-muted">
              Loading token choices… {chain.nativeCurrency.symbol} is available
              now.
            </p>
          )}
          {tokensError && (
            <p className="text-xs text-muted">
              LI.FI token list unavailable. {chain.nativeCurrency.symbol} sends
              remain available.
            </p>
          )}
          <div className="flex flex-col gap-2 text-sm text-muted">
            <p className="break-all" aria-live="polite">
              {balanceText}
            </p>
            <button
              type="button"
              className="self-start underline"
              disabled={
                !reader ||
                !isAddress(selectedAddress) ||
                tokenBalance.isFetching
              }
              onClick={() => void tokenBalance.refetch()}
            >
              Refresh balance
            </button>
            <p className="text-xs">
              Keep {chain.nativeCurrency.symbol} on {chain.name} for network
              fees. Balance is checked again before sending.
            </p>
          </div>
          <label className="flex flex-col gap-2 text-sm text-default">
            Recipient
            <input
              className="rounded-xl border px-3 py-2 bg-app border-default"
              placeholder="0x…"
              value={recipient}
              onChange={(event) => {
                edit();
                setRecipient(event.target.value.trim());
              }}
            />
          </label>
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
          <DefaultButton type="submit" disabled={!reader || busy}>
            {busy
              ? 'Checking wallet…'
              : prepared
                ? 'Refresh review'
                : 'Review send'}
          </DefaultButton>
        </fieldset>
      </form>
      {prepared && (
        <section
          aria-label={`Review ${chain.name} transfer`}
          className="flex flex-col gap-3 rounded-xl p-4 text-sm bg-elevated-nohover text-default"
        >
          <div className="font-semibold">Review send on {chain.name}</div>
          <div className="break-all">
            Amount: {formatUnits(prepared.units, prepared.decimals)}{' '}
            {prepared.symbol}
          </div>
          <div className="break-all">From: {prepared.input.address}</div>
          <div className="break-all">To: {prepared.input.recipient}</div>
          {prepared.input.tokenAddress && (
            <div className="break-all">
              Token contract: {prepared.input.tokenAddress}
            </div>
          )}
          <div>
            Live balance: {formatUnits(prepared.balance, prepared.decimals)}{' '}
            {prepared.symbol}
          </div>
          <div>
            {chain.id === base.id ? 'Estimated fee (L1 + L2)' : 'Estimated fee'}
            : {formatEther(prepared.estimatedFee)} {chain.nativeCurrency.symbol}
          </div>
          <p className="text-xs text-muted">
            We check a 20% fee buffer, but this is not a fee cap. Final fees may
            differ. Review expires after 60 seconds. Your wallet may request a
            switch to {chain.name}.
          </p>
          <p className="text-xs text-muted">
            For unusual tokens, transfer taxes or restrictions may change what
            the recipient receives.
          </p>
          <DefaultButton
            type="button"
            disabled={busy || !provider}
            onClick={() => void send()}
          >
            {busy ? 'Waiting for wallet…' : 'Confirm in wallet'}
          </DefaultButton>
        </section>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-red-50 p-3 text-sm text-red-600"
        >
          {error}
        </p>
      )}
      {hash && (
        <div role="status" className="flex flex-col gap-2 text-sm text-default">
          <p>{receiptStatus}</p>
          {explorer && (
            <a
              className="text-accent-primary hover:underline"
              href={`${explorer.url}/tx/${receipt?.transactionHash ?? hash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View transaction on {explorer.name}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
