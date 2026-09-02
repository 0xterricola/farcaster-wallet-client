import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, LoaderCircleIcon } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useSolanaBalance } from '~/hooks/useSolanaBalance';
import { useSolanaTokenPortfolio } from '~/hooks/useSolanaTokenPortfolio';
import {
  formatSolanaFee,
  PreparedSolanaTransfer,
  prepareSolanaTransfer,
  solanaTransactionUrl,
  submitSignedSolanaTransaction,
  waitForSolanaConfirmation,
} from '~/utils/solanaTransfer';
import { formatSolanaTokenAmount } from '~/utils/solanaWallet';

type SendStatus = 'editing' | 'preparing' | 'review' | 'signing' | 'confirming';

export function ExternalSolanaWalletSend({
  address,
  onBack,
  signTransaction,
}: {
  address: string;
  onBack: () => void;
  signTransaction: (transaction: Uint8Array) => Promise<Uint8Array>;
}) {
  const queryClient = useQueryClient();
  const balance = useSolanaBalance(address);
  const portfolio = useSolanaTokenPortfolio(address);
  const [assetMint, setAssetMint] = useState('SOL');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [prepared, setPrepared] = useState<PreparedSolanaTransfer>();
  const [status, setStatus] = useState<SendStatus>('editing');
  const [error, setError] = useState<string>();
  const [signature, setSignature] = useState<string>();
  const tokens = useMemo(
    () => (portfolio.data ?? []).filter((asset) => asset.recognized),
    [portfolio.data],
  );
  const asset = tokens.find((token) => token.mint === assetMint);
  const available = asset
    ? `${formatSolanaTokenAmount(asset)} ${asset.symbol}`
    : balance.data === undefined
      ? 'Unavailable'
      : `${balance.data / 1_000_000_000} SOL`;
  const pending = ['preparing', 'signing', 'confirming'].includes(status);

  const prepare = async (): Promise<PreparedSolanaTransfer> => {
    if (balance.data === undefined) {
      throw new Error('SOL balance is unavailable. Refresh and try again.');
    }
    return prepareSolanaTransfer({
      amount,
      asset,
      recipient,
      sender: address,
      solBalanceLamports: balance.data,
    });
  };

  const review = async () => {
    setStatus('preparing');
    setError(undefined);
    setSignature(undefined);
    try {
      const next = await prepare();
      setPrepared(next);
      setStatus('review');
    } catch (failure) {
      setStatus('editing');
      setError(message(failure));
    }
  };

  const send = async () => {
    setStatus('signing');
    setError(undefined);
    try {
      // Rebuild immediately before signing so the blockhash stays fresh.
      const next = await prepare();
      setPrepared(next);
      const signed = await signTransaction(next.transaction);
      const nextSignature = await submitSignedSolanaTransaction(signed);
      setSignature(nextSignature);
      setStatus('confirming');
      await waitForSolanaConfirmation(nextSignature);
      await queryClient.invalidateQueries({
        queryKey: ['solana-wallet', address],
      });
      setStatus('editing');
      setAmount('');
    } catch (failure) {
      setStatus('review');
      setError(message(failure));
    }
  };

  const setMaximum = () => {
    if (asset) {
      setAmount(formatSolanaTokenAmount(asset));
      return;
    }
    if (balance.data !== undefined) {
      // Leave a conservative fee buffer; final validation uses the RPC quote.
      setAmount(
        Math.max(0, balance.data - 10_000)
          .toString()
          .padStart(10, '0')
          .replace(/(\d+)(\d{9})$/, '$1.$2')
          .replace(/^0+([1-9])/, '$1')
          .replace(/\.?0+$/, ''),
      );
    }
  };

  const changeAsset = (mint: string) => {
    setAssetMint(mint);
    setAmount('');
    setPrepared(undefined);
    setStatus('editing');
    setError(undefined);
  };

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          aria-label="Back to Solana wallet"
          className="flex size-8 items-center justify-center rounded-full hover:bg-overlay-light"
          onClick={onBack}
          type="button"
        >
          <ArrowLeftIcon className="size-5" />
        </button>
        <div className="font-semibold text-default">Send on Solana</div>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm font-medium text-default">
          Asset
          <select
            className="rounded-xl border px-3 py-2.5 bg-app border-default"
            disabled={pending || status === 'review'}
            onChange={(event) => changeAsset(event.target.value)}
            value={assetMint}
          >
            <option value="SOL">SOL</option>
            {tokens.map((token) => (
              <option key={token.mint} value={token.mint}>
                {token.symbol}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-default">
          Recipient
          <input
            autoComplete="off"
            className="font-mono rounded-xl border px-3 py-2.5 text-sm bg-app border-default"
            disabled={pending || status === 'review'}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="Solana wallet address"
            spellCheck={false}
            value={recipient}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium text-default">
          <span className="flex items-center justify-between gap-2">
            <span>Amount</span>
            <button
              className="text-xs font-semibold text-accent hover:underline"
              disabled={pending || status === 'review'}
              onClick={setMaximum}
              type="button"
            >
              Max
            </button>
          </span>
          <input
            autoComplete="off"
            className="rounded-xl border px-3 py-2.5 tabular-nums bg-app border-default"
            disabled={pending || status === 'review'}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
            value={amount}
          />
          <span className="text-xs font-normal text-muted">
            Available: {available}
          </span>
        </label>

        {prepared && status === 'review' && (
          <div className="rounded-xl border p-3 text-sm bg-elevated-nohover border-default">
            <div className="font-semibold text-default">Review transfer</div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-muted">Sending</dt>
              <dd className="text-right font-medium text-default">
                {amount} {asset?.symbol ?? 'SOL'}
              </dd>
              <dt className="text-muted">Network fee</dt>
              <dd className="text-right font-medium text-default">
                {formatSolanaFee(prepared.feeLamports)}
              </dd>
              {prepared.rentLamports > 0 && (
                <>
                  <dt className="text-muted">Recipient token account</dt>
                  <dd className="text-right font-medium text-default">
                    {formatSolanaFee(prepared.rentLamports)}
                  </dd>
                </>
              )}
              {prepared.recipientMinimumLamports > 0 && (
                <>
                  <dt className="text-muted">New-account minimum</dt>
                  <dd className="text-right font-medium text-default">
                    {formatSolanaFee(prepared.recipientMinimumLamports)}
                    {' (included in amount)'}
                  </dd>
                </>
              )}
              <dt className="text-muted">Recipient</dt>
              <dd className="font-mono break-all text-right text-default">
                {recipient}
              </dd>
            </dl>
          </div>
        )}

        {error && (
          <div
            className="rounded-xl bg-red-50 p-3 text-sm text-red-600"
            role="alert"
          >
            {error}
          </div>
        )}

        {signature && (
          <a
            className="rounded-xl p-3 text-center text-sm font-semibold text-accent bg-elevated-nohover hover:underline"
            href={solanaTransactionUrl(signature)}
            rel="noopener noreferrer"
            target="_blank"
          >
            View transaction on Solana Explorer
          </a>
        )}

        {status === 'review' ? (
          <div className="grid grid-cols-2 gap-3">
            <DefaultButton
              disabled={pending}
              onClick={() => {
                setPrepared(undefined);
                setStatus('editing');
              }}
              type="button"
              variant="secondary"
            >
              Edit
            </DefaultButton>
            <DefaultButton
              disabled={pending}
              onClick={() => void send()}
              type="button"
            >
              Send
            </DefaultButton>
          </div>
        ) : (
          <DefaultButton
            disabled={pending || !amount || !recipient}
            onClick={() => void review()}
            type="button"
          >
            {pending && (
              <LoaderCircleIcon className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" />
            )}
            {status === 'preparing'
              ? 'Preparing…'
              : status === 'signing'
                ? 'Check your wallet…'
                : status === 'confirming'
                  ? 'Confirming…'
                  : 'Review transfer'}
          </DefaultButton>
        )}
      </div>
    </div>
  );
}

function message(error: unknown): string {
  if (error instanceof Error) {
    if (/reject|denied|cancel/i.test(error.message)) {
      return 'Transaction rejected in your wallet.';
    }
    return error.message;
  }
  return 'Solana transfer failed. Please try again.';
}
