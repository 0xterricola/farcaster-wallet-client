import type { ApiEthFungibleTokenPosition } from 'farcaster-client-data';
import { formatUnits } from 'viem';

// Farcaster's native-asset marker for Base. Never identify native ETH by
// symbol: WETH and contracts that call themselves ETH remain separate tokens.
const BASE_NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const isBasePortfolioToken = (position: ApiEthFungibleTokenPosition) =>
  position.chain === 'base' &&
  position.address?.toLowerCase() !== BASE_NATIVE_ASSET_ADDRESS;

export const isPortfolioPositionHidden = (
  position: ApiEthFungibleTokenPosition,
) => Boolean(position.hidden || position.userHidden);

export function selectBasePortfolioPositions(
  positions: ApiEthFungibleTokenPosition[],
  showHidden: boolean,
) {
  return positions
    .filter(
      (position) =>
        isBasePortfolioToken(position) &&
        (showHidden || !isPortfolioPositionHidden(position)),
    )
    .sort(
      (a, b) =>
        (getPortfolioUsdValue(b.value) ?? -1) -
        (getPortfolioUsdValue(a.value) ?? -1),
    );
}

export function getPortfolioUsdValue(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function formatPortfolioUsd(value: number | undefined) {
  const validValue = getPortfolioUsdValue(value);
  if (validValue === undefined) {
    return '—';
  }
  if (validValue > 0 && validValue < 0.01) {
    return '<$0.01';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(validValue);
}

// Format integer token units without converting the balance to a JS number.
// API valuations are display estimates; sending will read live chain balances.
export function formatPortfolioBalance(position: ApiEthFungibleTokenPosition) {
  const units = position.quantity?.int;
  const decimals = position.decimals;
  if (
    typeof units !== 'string' ||
    !/^\d+$/.test(units) ||
    decimals === undefined ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return { display: '—', exact: 'Balance unavailable' };
  }

  const exact = formatUnits(BigInt(units), decimals);
  const [whole, fraction = ''] = exact.split('.');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole === '0' && fraction.length > 6 && /^0{6}/.test(fraction)) {
    return { display: '<0.000001', exact };
  }
  const visibleFraction = fraction.slice(0, 6).replace(/0+$/, '');
  return {
    display: `${groupedWhole}${visibleFraction ? `.${visibleFraction}` : ''}${fraction.length > 6 ? '…' : ''}`,
    exact,
  };
}
