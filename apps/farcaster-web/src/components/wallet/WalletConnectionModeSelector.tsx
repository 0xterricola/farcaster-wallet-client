import React from 'react';

import {
  WalletConnectionMode,
  WalletConnectionModeAvailability,
} from '~/utils/metamaskConnection';

const CONNECTION_MODES: readonly WalletConnectionMode[] = [
  'unified',
  'evm',
  'solana',
];

const MODE_LABELS: Record<WalletConnectionMode, string> = {
  unified: 'Unified',
  evm: 'EVM',
  solana: 'Solana',
};

export function WalletConnectionModeSelector({
  availability,
  onChange,
  value,
}: {
  availability: WalletConnectionModeAvailability;
  onChange: (mode: WalletConnectionMode) => void;
  value: WalletConnectionMode;
}) {
  return (
    <div
      aria-label="Wallet connection mode"
      className="grid grid-cols-3 gap-1 rounded-xl p-1 bg-surface-secondary"
      role="tablist"
    >
      {CONNECTION_MODES.map((mode) => {
        const selected = mode === value;
        const state = availability[mode];
        return (
          <button
            aria-selected={selected}
            className={`rounded-lg px-3 py-2 text-sm transition-colors ${
              selected
                ? 'font-semibold shadow-sm bg-app text-default'
                : 'font-medium text-muted hover:text-default'
            } ${state.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
            disabled={state.disabled}
            key={mode}
            onClick={() => onChange(mode)}
            role="tab"
            title={state.reason}
            type="button"
          >
            {MODE_LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}
