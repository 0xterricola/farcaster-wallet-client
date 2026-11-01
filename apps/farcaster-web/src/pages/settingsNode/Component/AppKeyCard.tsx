/**
 * App Key Card - the client's own key, and what it can and cannot do.
 *
 * What the key may do and how long it lasts are spelled out here *at the moment
 * the key is created*, because that is the only moment the reader can decide
 * whether they want it: it can cast, follow, react and edit profile on this
 * account, and it stops working 90 days after its last use unless it is used
 * again.
 *
 * Copy: this screen is Advanced, so it may name the things you configure
 * ("app key", "your setup") — but the words that only make sense to whoever
 * built the protocol (KEY_ADD, EIP-712, gasless, "scopes", "sliding TTL") are
 * not shown. They are translated, in the same words the onboarding uses:
 * "a signature, not a transaction", "can do", "asks again in 90 days".
 */

import { MAX_KEY_TTL_SECONDS, type NodeSigner } from 'farcaster-node-client';
import React, { memo } from 'react';

interface AppKeyCardProps {
  signer?: NodeSigner;
  publicKeyHex?: string;
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
  currentUserNonce: number;
  loading: boolean;
  issueStep: string | null;
  error?: string | null;
  onIssue: () => void;
  onRevoke: () => void;
}

const SCOPE_LABELS: Record<string, string> = {
  MESSAGE_TYPE_CAST_ADD: 'post casts',
  MESSAGE_TYPE_CAST_REMOVE: 'delete its own casts',
  MESSAGE_TYPE_REACTION_ADD: 'like and recast',
  MESSAGE_TYPE_REACTION_REMOVE: 'undo a reaction',
  MESSAGE_TYPE_LINK_ADD: 'follow',
  MESSAGE_TYPE_LINK_REMOVE: 'unfollow',
  MESSAGE_TYPE_USER_DATA_ADD: 'edit profile fields',
};

const describeScopes = (scopes: string[] | undefined): string =>
  scopes && scopes.length > 0
    ? scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(', ')
    : 'post casts, delete its own casts, like and recast, undo a reaction, follow, unfollow, edit profile fields';

const truncate = (value: string, size = 14): string =>
  value.length > size * 2
    ? `${value.slice(0, size)}…${value.slice(-6)}`
    : value;

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4">
    <span className="text-muted">{label}</span>
    <span className="max-w-[65%] text-right text-primary">{value}</span>
  </div>
);

const AppKeyCard = memo<AppKeyCardProps>(
  ({
    signer,
    publicKeyHex,
    gaslessSignerCount,
    gaslessSignerLimit,
    currentUserNonce,
    loading,
    issueStep,
    error,
    onIssue,
    onRevoke,
  }) => {
    const active = Boolean(signer) || Boolean(publicKeyHex);
    const keyHex = signer?.key ?? publicKeyHex ?? '';
    const ttlDays = signer?.ttl
      ? Math.round(signer.ttl / 86400)
      : MAX_KEY_TTL_SECONDS / 86400;

    return (
      <div className="solid-glass-pane rounded-lg border p-4 border-default">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-primary">App key</span>
          <span className="text-xs text-muted">
            a signature, not a transaction — no ETH
          </span>
        </div>

        <div className="flex flex-col gap-3 text-sm">
          {!active ? (
            <>
              <div className="rounded border p-3 text-xs bg-tertiary border-default">
                <div className="font-medium text-primary">
                  No app key on this device yet
                </div>
                <div className="mt-1 text-muted">
                  Your own key signs one approval and the app key does the rest.
                  Nothing is bought, nothing is written to a chain, and you can
                  revoke it from here.
                </div>
              </div>
              <div className="text-xs text-muted">
                What it can do: {describeScopes(undefined)}. It asks again in{' '}
                {ttlDays} days — and every time it signs, the countdown starts
                over, so regular use keeps it alive.
              </div>
              <button
                type="button"
                onClick={onIssue}
                disabled={loading}
                className="w-max rounded px-4 py-2 font-medium text-[#1a1c10] bg-action-primary hover:opacity-90 disabled:opacity-50"
              >
                {loading ? 'Working…' : 'Issue app key'}
              </button>
              {loading && issueStep && (
                <div className="text-xs text-muted">
                  {issueStep === 'reading-nonce' &&
                    'Checking your account with your setup…'}
                  {issueStep === 'building' &&
                    'Signing the approval with your own key…'}
                  {issueStep === 'submitting' &&
                    'Asking your setup to accept the key…'}
                  {issueStep === 'confirming' &&
                    'Waiting for your setup to keep the key…'}
                  {issueStep === 'done' && 'Key is live.'}
                </div>
              )}
            </>
          ) : (
            <>
              <Row
                label="Status"
                value={<span className="text-action-primary">Active</span>}
              />
              <Row
                label="Public key"
                value={
                  <span className="font-mono text-[11px]" title={keyHex}>
                    {truncate(keyHex)}
                  </span>
                }
              />
              <Row
                label="Can do"
                value={
                  <span className="text-xs">
                    {describeScopes(signer?.scopes)}
                  </span>
                }
              />
              <Row
                label="Asks again in"
                value={
                  <span className="text-xs">
                    {ttlDays} days — restarts each time it signs
                    {signer?.lastUsedAt ? (
                      <>
                        {' · last used '}
                        {new Date(
                          signer.lastUsedAt * 1000,
                        ).toLocaleDateString()}
                      </>
                    ) : null}
                  </span>
                }
              />
              <Row
                label="Keys on this account"
                value={
                  <span
                    className={
                      gaslessSignerCount >= gaslessSignerLimit
                        ? 'text-danger'
                        : ''
                    }
                  >
                    {gaslessSignerCount} / {gaslessSignerLimit}
                  </span>
                }
              />
              <Row label="Times signed" value={currentUserNonce} />
              <div className="text-xs text-muted">
                This key can only do the things listed above, only for account{' '}
                {signer?.fid ?? ''}, and only until the countdown runs out.
                Revoking removes it immediately — no transaction, and your own
                key is not needed.
              </div>
              <button
                type="button"
                onClick={onRevoke}
                disabled={loading}
                className="mt-1 w-max rounded border px-4 py-2 border-default text-danger hover:bg-tertiary disabled:opacity-50"
              >
                {loading ? 'Revoking…' : 'Revoke key'}
              </button>
            </>
          )}

          {error && (
            <div className="rounded border p-2 text-xs bg-tertiary border-default text-danger">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  },
);

AppKeyCard.displayName = 'AppKeyCard';

export { AppKeyCard };
