import { FormEvent, useCallback, useState } from 'react';
import {
  Address,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  Hash,
  isAddress,
  parseUnits,
} from 'viem';
import { usePublicClient } from 'wagmi';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { useWallet } from '~/contexts/WalletProvider';
import { truncateAddress } from '~/utils/ethereumUtils';

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = '0x2105';
const NATIVE_TOKEN_ADDRESS =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;

type TokenDetails = {
  address: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
  isNative: boolean;
};

type QuoteToken = {
  address: Address;
  symbol: string;
  decimals: number;
};

type LiFiQuote = {
  tool: string;
  action: {
    fromAmount: string;
    fromToken: QuoteToken;
    toToken: QuoteToken;
  };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: Address;
  };
  transactionRequest: {
    to: Address;
    data: `0x${string}`;
    value?: `0x${string}`;
    gasLimit?: `0x${string}`;
    gasPrice?: `0x${string}`;
  };
};

type LiFiError = {
  message?: string;
  errors?: { message?: string }[];
};

function ExternalWalletSwap() {
  const { address, provider } = useWallet();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const [fromTokenInput, setFromTokenInput] = useState('ETH');
  const [toTokenInput, setToTokenInput] = useState('');
  const [amount, setAmount] = useState('');
  const [fromToken, setFromToken] = useState<TokenDetails>();
  const [toToken, setToToken] = useState<TokenDetails>();
  const [quote, setQuote] = useState<LiFiQuote>();
  const [isQuoting, setIsQuoting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [transactionHash, setTransactionHash] = useState<Hash>();

  const clearQuote = () => {
    setQuote(undefined);
    setStatus(undefined);
    setError(undefined);
    setTransactionHash(undefined);
  };

  const resolveToken = useCallback(
    async (input: string): Promise<TokenDetails> => {
      if (!address || !publicClient) {
        throw new Error('Wallet or Base provider is unavailable.');
      }

      if (input.trim().toUpperCase() === 'ETH') {
        return {
          address: NATIVE_TOKEN_ADDRESS,
          symbol: 'ETH',
          decimals: 18,
          balance: await publicClient.getBalance({ address }),
          isNative: true,
        };
      }

      if (!isAddress(input.trim())) {
        throw new Error('Enter ETH or a valid Base token contract address.');
      }

      const tokenAddress = getAddress(input.trim());
      try {
        const [symbol, decimals, balance] = await Promise.all([
          publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: 'symbol',
          }),
          publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: 'decimals',
          }),
          publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          }),
        ]);

        return {
          address: tokenAddress,
          symbol,
          decimals,
          balance,
          isNative: false,
        };
      } catch {
        throw new Error('This address is not a readable ERC-20 token on Base.');
      }
    },
    [address, publicClient],
  );

  const requestQuote = useCallback(
    async (
      resolvedFromToken: TokenDetails,
      resolvedToToken: TokenDetails,
      fromAmount: bigint,
    ) => {
      if (!address) {
        throw new Error('Connect a wallet before requesting a quote.');
      }

      const params = new URLSearchParams({
        fromChain: String(BASE_CHAIN_ID),
        toChain: String(BASE_CHAIN_ID),
        fromToken: resolvedFromToken.address,
        toToken: resolvedToToken.address,
        fromAmount: fromAmount.toString(),
        fromAddress: address,
        toAddress: address,
        slippage: '0.005',
        order: 'CHEAPEST',
        integrator: 'farcaster-wallet-client',
      });
      const response = await fetch(`https://li.quest/v1/quote?${params}`);
      const body = (await response.json()) as LiFiQuote | LiFiError;

      if (!response.ok) {
        const apiError = body as LiFiError;
        throw new Error(
          apiError.message ||
            apiError.errors?.[0]?.message ||
            'No swap route is available for these tokens.',
        );
      }

      return body as LiFiQuote;
    },
    [address],
  );

  const resolveForm = useCallback(async () => {
    const [resolvedFromToken, resolvedToToken] = await Promise.all([
      resolveToken(fromTokenInput),
      resolveToken(toTokenInput),
    ]);

    if (
      resolvedFromToken.address.toLowerCase() ===
      resolvedToToken.address.toLowerCase()
    ) {
      throw new Error('Choose two different tokens.');
    }

    let fromAmount: bigint;
    try {
      fromAmount = parseUnits(amount, resolvedFromToken.decimals);
    } catch {
      throw new Error('Enter a valid token amount.');
    }

    if (fromAmount <= 0n) {
      throw new Error('Amount must be greater than zero.');
    }
    if (fromAmount > resolvedFromToken.balance) {
      throw new Error(`Insufficient ${resolvedFromToken.symbol} balance.`);
    }

    setFromToken(resolvedFromToken);
    setToToken(resolvedToToken);
    return { resolvedFromToken, resolvedToToken, fromAmount };
  }, [amount, fromTokenInput, resolveToken, toTokenInput]);

  const handleQuote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setStatus(undefined);
    setTransactionHash(undefined);
    setQuote(undefined);
    setIsQuoting(true);

    try {
      const { resolvedFromToken, resolvedToToken, fromAmount } =
        await resolveForm();
      setQuote(
        await requestQuote(resolvedFromToken, resolvedToToken, fromAmount),
      );
    } catch (quoteError) {
      setError(
        quoteError instanceof Error
          ? quoteError.message
          : 'Could not create a swap quote.',
      );
    } finally {
      setIsQuoting(false);
    }
  };

  const sendApproval = async (
    token: TokenDetails,
    approvalAddress: Address,
    approvalAmount: bigint,
  ) => {
    if (!address || !provider || !publicClient || token.isNative) {
      return;
    }

    const allowance = await publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [address, approvalAddress],
    });
    if (allowance >= approvalAmount) {
      return;
    }

    setStatus(`Approve ${token.symbol} in your wallet…`);
    const approvalHash = (await provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: address,
          to: token.address,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [approvalAddress, approvalAmount],
          }),
        },
      ],
    })) as Hash;
    setStatus('Waiting for token approval…');
    await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  };

  const handleSwap = async () => {
    if (!address || !provider || !publicClient || !quote || !fromToken) {
      return;
    }

    setError(undefined);
    setStatus(undefined);
    setTransactionHash(undefined);
    setIsExecuting(true);

    try {
      const currentChainId = await provider.request({ method: 'eth_chainId' });
      if (Number(currentChainId) !== BASE_CHAIN_ID) {
        setStatus('Switch to Base in your wallet…');
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: BASE_CHAIN_ID_HEX }],
        });
      }

      const approvalAmount = BigInt(quote.action.fromAmount);
      if (quote.estimate.approvalAddress) {
        await sendApproval(
          fromToken,
          quote.estimate.approvalAddress,
          approvalAmount,
        );
      }

      // LI.FI quotes expire quickly, so refresh after a possible approval.
      const refreshedQuote = await requestQuote(
        fromToken,
        toToken!,
        approvalAmount,
      );
      if (refreshedQuote.estimate.approvalAddress) {
        await sendApproval(
          fromToken,
          refreshedQuote.estimate.approvalAddress,
          approvalAmount,
        );
      }

      const transaction = refreshedQuote.transactionRequest;
      setStatus('Review the swap in your wallet…');
      const hash = (await provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: address,
            to: transaction.to,
            data: transaction.data,
            value: transaction.value,
            gas: transaction.gasLimit,
            gasPrice: transaction.gasPrice,
          },
        ],
      })) as Hash;

      setTransactionHash(hash);
      setStatus('Swap submitted');
      setQuote(undefined);
    } catch (swapError) {
      setStatus(undefined);
      setError(
        swapError instanceof Error ? swapError.message : 'Swap was not sent.',
      );
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="rounded-xl p-3 text-xs text-muted bg-elevated-nohover">
        Base only. Enter <span className="font-semibold">ETH</span> or paste a
        Base ERC-20 contract address. Verify contracts before approving them.
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleQuote}>
        <TokenInput
          label="Sell token"
          value={fromTokenInput}
          token={fromToken}
          onChange={(value) => {
            setFromTokenInput(value);
            setFromToken(undefined);
            clearQuote();
          }}
        />
        <label className="flex flex-col gap-2 text-sm text-default">
          Amount
          <input
            className="rounded-xl border px-3 py-2 bg-app border-default"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              clearQuote();
            }}
          />
        </label>
        <TokenInput
          label="Buy token"
          value={toTokenInput}
          token={toToken}
          onChange={(value) => {
            setToTokenInput(value);
            setToToken(undefined);
            clearQuote();
          }}
        />

        {!quote && (
          <DefaultButton type="submit" isLoading={isQuoting}>
            Get quote
          </DefaultButton>
        )}
      </form>

      {quote && toToken && (
        <div className="rounded-xl p-4 bg-elevated-nohover">
          <div className="text-xs text-muted">Estimated receive</div>
          <div className="mt-1 text-xl font-semibold text-default">
            {formatTokenAmount(quote.estimate.toAmount, toToken)}
          </div>
          <div className="mt-1 text-xs text-muted">
            Minimum {formatTokenAmount(quote.estimate.toAmountMin, toToken)} ·
            Route: {quote.tool}
          </div>
          <DefaultButton
            className="mt-4 w-full"
            isLoading={isExecuting}
            onClick={handleSwap}
          >
            Review swap
          </DefaultButton>
        </div>
      )}

      {status && (
        <div className="rounded-xl p-3 text-sm bg-elevated-nohover text-default">
          {status}
        </div>
      )}
      {error && (
        <div className="rounded-xl bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}
      {transactionHash && (
        <a
          className="text-accent-primary text-sm hover:underline"
          href={`https://basescan.org/tx/${transactionHash}`}
          target="_blank"
          rel="noreferrer"
        >
          View {truncateAddress(transactionHash, 8)} on BaseScan
        </a>
      )}
    </div>
  );
}

function TokenInput({
  label,
  value,
  token,
  onChange,
}: {
  label: string;
  value: string;
  token?: TokenDetails;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm text-default">
      {label}
      <input
        className="rounded-xl border px-3 py-2 bg-app border-default"
        autoCapitalize="none"
        autoCorrect="off"
        placeholder="ETH or 0x…"
        value={value}
        onChange={(event) => onChange(event.target.value.trim())}
      />
      {token && (
        <span className="text-xs text-muted">
          {token.symbol} balance: {formatTokenAmount(token.balance, token)}
        </span>
      )}
    </label>
  );
}

function formatTokenAmount(amount: string | bigint, token: TokenDetails) {
  const formatted = Number(
    formatUnits(BigInt(amount), token.decimals),
  ).toLocaleString(undefined, { maximumFractionDigits: 6 });
  return `${formatted} ${token.symbol}`;
}

export { ExternalWalletSwap };
