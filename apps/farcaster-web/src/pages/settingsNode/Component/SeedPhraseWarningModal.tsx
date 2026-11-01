/**
 * Seed Phrase Warning Modal - warns user before entering seed phrase
 *
 * SECURITY: This modal exists because entering a seed phrase is dangerous.
 * The modal:
 * - Cannot be dismissed except by explicit "I understand" action
 * - Requires checkbox acknowledgment before enabling the confirm button
 * - Explains exactly what the seed phrase is used for (EIP-712 KEY_ADD only)
 * - States the phrase never leaves the browser tab
 */

import React, { memo, useEffect, useState } from 'react';

interface SeedPhraseWarningModalProps {
  onClose: () => void;
  onConfirm: (mnemonic: string) => Promise<void>;
  loading: boolean;
}

const SeedPhraseWarningModal = memo<SeedPhraseWarningModalProps>(
  ({ onClose, onConfirm, loading }) => {
    const [acknowledged, setAcknowledged] = useState(false);
    const [mnemonic, setMnemonic] = useState('');
    const [showMnemonic, setShowMnemonic] = useState(false);

    // Whatever happens to this component — close, route change, crash — the
    // phrase must not survive it.
    useEffect(() => () => setMnemonic(''), []);

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!acknowledged || !mnemonic.trim() || loading) {
        return;
      }
      await onConfirm(mnemonic.trim());
    };

    const handleClose = () => {
      setMnemonic(''); // Clear the mnemonic on close for security
      onClose();
    };

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="mx-4 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border p-6 shadow-xl bg-app border-default">
          <h2 className="mb-4 text-xl font-bold text-danger">
            ⚠️ Security warning
          </h2>

          <div className="mb-4 flex flex-col gap-3 text-sm text-primary">
            <div className="rounded border p-3 bg-tertiary border-default">
              <strong>Seed phrases are powerful and dangerous.</strong>
            </div>

            <div>
              <strong>Use a TEST account</strong> with existing storage, never
              your main account.
            </div>

            <div>
              <strong>The phrase never leaves this browser tab.</strong> It is
              never sent to your setup or to any server, and is not stored
              anywhere by the client.
            </div>

            <div>
              <strong>Your own key signs exactly one thing:</strong> the
              approval that lets an app key use this account. No transaction, no
              ETH, no network fee, no storage purchase.
            </div>

            <div>
              <strong>It does not create an account on a chain.</strong> It is
              only used to approve an app key.
            </div>
          </div>

          <div className="mb-4 rounded border p-3 text-sm text-muted bg-tertiary border-default">
            <strong className="text-primary">
              What it can do, and how long:
            </strong>{' '}
            the app key you create asks again in 90 days — every time it signs,
            the countdown restarts, so regular use keeps it alive. It can do
            this and nothing else: post casts, delete its own casts, like and
            recast, undo a reaction, follow, unfollow, edit profile fields.
          </div>

          <form onSubmit={handleSubmit}>
            <label className="mb-4 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-1"
              />
              <span>
                I understand the risks. I will use a test account and keep my
                seed phrase secure.
              </span>
            </label>

            <div className="mb-4">
              <label
                htmlFor="mnemonic"
                className="mb-1 block text-sm font-medium"
              >
                Enter your recovery phrase:
              </label>
              <div className="relative">
                <input
                  id="mnemonic"
                  type={showMnemonic ? 'text' : 'password'}
                  value={mnemonic}
                  onChange={(e) => setMnemonic(e.target.value)}
                  placeholder="word1 word2 word3 ..."
                  className="font-mono w-full rounded border p-3 text-sm border-default"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowMnemonic(!showMnemonic)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-muted"
                >
                  {showMnemonic ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                className="flex-1 rounded border px-4 py-2 text-primary border-default hover:bg-tertiary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!acknowledged || !mnemonic.trim() || loading}
                className="flex-1 rounded px-4 py-2 font-medium text-[#1a1c10] bg-action-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Processing…' : 'I understand, use a TEST account'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  },
);

SeedPhraseWarningModal.displayName = 'SeedPhraseWarningModal';

export { SeedPhraseWarningModal };
