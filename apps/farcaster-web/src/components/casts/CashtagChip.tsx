/**
 * A `$cashtag` with its price on it.
 *
 * Three rules decide the shape:
 *
 * 1. **Nothing is fetched until the chip is actually looked at.** A feed can hold
 *    a dozen cashtags; each chip asks only when it scrolls into view (or is
 *    hovered), and the price module itself is `import()`ed at that moment, so a
 *    reader who never looks at a cashtag pays nothing for this feature.
 * 2. **The price is not fattened.** One number, the market it came from in the
 *    title, and `—` when there is none: a chip that invents a number is worse
 *    than a chip with no number.
 * 3. **The chip is not a button.** It lives inside whatever link the cast body
 *    already renders, so it adds no tab stop, no click target and no second way
 *    to navigate. Its state is exposed as `data-price-state` for the probes.
 */
/* The chip's rules travel with the chip, not with the sealed surfaces: a cashtag
   in an ordinary feed must look like a chip even when no sealed cast is near. */
import '~/styles/fiddy-cashtag.css';

import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { loadTokenPrice } from '~/components/sealed/sealedModules';

export interface CashtagChipProps {
  /** The ticker as it was written, with or without its `$`. */
  ticker: string;
  /** A contract address from the cast's token mention, when it had one. */
  address?: string;
  chain?: string;
}

type ChipState =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'priced'; label: string; title: string }
  | { status: 'unavailable'; reason: string };

const CashtagChip: FC<CashtagChipProps> = ({ ticker, address, chain }) => {
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  const asked = useRef(false);
  const [state, setState] = useState<ChipState>({ status: 'idle' });

  const symbol = ticker.startsWith('$') ? ticker : `$${ticker}`;

  const ask = useCallback(async () => {
    if (asked.current) {
      return;
    }

    asked.current = true;
    setState({ status: 'asking' });

    try {
      const price = await loadTokenPrice();
      const result = await price.lookupTokenPrice({ ticker, address, chain });

      if (result.price !== null) {
        const label = price.formatUsdPrice(result.price.usd);

        setState({
          status: 'priced',
          label,
          title: `${symbol} — ${label}${
            result.price.chainId ? ` on ${result.price.chainId}` : ''
          }${result.price.url ? ` (${result.price.url})` : ''}`,
        });

        return;
      }

      setState({
        status: 'unavailable',
        reason: result.reason ?? `no price for ${symbol}`,
      });
    } catch {
      setState({
        status: 'unavailable',
        reason: `the price for ${symbol} could not be loaded`,
      });
    }
  }, [address, chain, symbol, ticker]);

  useEffect(() => {
    const node = nodeRef.current;

    if (node === null || asked.current) {
      return undefined;
    }

    /* No IntersectionObserver (a very old browser, or a test): the hover and
       tap paths below still work, so the chip degrades rather than breaking. */
    if (typeof IntersectionObserver === 'undefined') {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void ask();
        }
      },
      { rootMargin: '120px' },
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [ask]);

  const title =
    state.status === 'priced'
      ? state.title
      : state.status === 'unavailable'
        ? state.reason
        : `${symbol} — price loads when it is looked at`;

  return (
    <span
      ref={nodeRef}
      className="fiddy-cashtag"
      data-cashtag={symbol}
      data-price-state={state.status}
      title={title}
      aria-label={
        state.status === 'priced'
          ? `${symbol}, ${state.label} per token`
          : symbol
      }
      onMouseEnter={() => {
        void ask();
      }}
    >
      <span className="fiddy-cashtag__symbol">{symbol}</span>
      {state.status === 'priced' ? (
        <span className="fiddy-cashtag__price">{state.label}</span>
      ) : null}
      {state.status === 'asking' ? (
        <span className="fiddy-cashtag__price">…</span>
      ) : null}
    </span>
  );
};

export { CashtagChip };
