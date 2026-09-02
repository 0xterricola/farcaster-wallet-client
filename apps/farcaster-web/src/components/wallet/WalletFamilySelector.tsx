import React from 'react';

import {
  WALLET_FAMILIES,
  WALLET_FAMILY_DETAILS,
  WalletFamily,
} from '~/utils/walletFamily';

export function WalletFamilySelector({
  value,
  onChange,
}: {
  value: WalletFamily;
  onChange: (family: WalletFamily) => void;
}) {
  return (
    <div
      aria-label="Wallet network family"
      className="grid grid-cols-2 gap-1 rounded-xl p-1 bg-surface-secondary"
      role="tablist"
    >
      {WALLET_FAMILIES.map((family) => {
        const details = WALLET_FAMILY_DETAILS[family];
        const selected = family === value;
        return (
          <button
            aria-selected={selected}
            className={
              selected
                ? 'rounded-lg px-3 py-2 text-sm font-semibold shadow-sm bg-app text-default'
                : 'rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-default'
            }
            key={family}
            onClick={() => onChange(family)}
            role="tab"
            type="button"
          >
            {details.label}
          </button>
        );
      })}
    </div>
  );
}
