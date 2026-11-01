/**
 * Node Composer - write a cast through your own node.
 *
 * Two states matter and are shown separately, because they are not the same
 * thing: "accepted for relay" is the node's 200 (it will gossip the message to
 * validators), and "stored" is the message being queryable back out of the node.
 * A read node has no mempool, so its ack is not an inclusion receipt.
 */

import React, { memo, useMemo, useState } from 'react';

interface NodeComposerProps {
  disabled: boolean;
  disabledMessage?: string;
  onPost: (text: string) => Promise<void>;
  success: string | null;
  error: string | null;
}

const CAST_LIMITS = [
  { bytes: 320, label: 'CAST' },
  { bytes: 1024, label: 'LONG_CAST' },
  { bytes: 10000, label: 'TEN_K_CAST' },
];

const castKindFor = (bytes: number): string => {
  const limit = CAST_LIMITS.find((entry) => bytes <= entry.bytes);
  return limit ? limit.label : 'too long for the protocol (10,000 bytes)';
};

const NodeComposer = memo<NodeComposerProps>(
  ({ disabled, disabledMessage, onPost, success, error }) => {
    const [text, setText] = useState('');
    const [posting, setPosting] = useState(false);

    const byteLength = useMemo(
      () => new TextEncoder().encode(text).length,
      [text],
    );
    const tooLong = byteLength > 10000;

    const handlePost = async () => {
      if (!text.trim() || disabled || tooLong) {
        return;
      }

      setPosting(true);
      try {
        await onPost(text.trim());
        setText('');
      } finally {
        setPosting(false);
      }
    };

    const canPost = text.trim().length > 0 && !disabled && !posting && !tooLong;

    return (
      <div className="solid-glass-pane rounded-lg border p-4 border-default">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-semibold text-primary">Composer</span>
          <span className="text-xs text-muted">
            signed with your app key → through your own setup → out
          </span>
        </div>

        {disabled && disabledMessage && (
          <div className="mb-3 rounded border p-2 text-sm text-muted bg-tertiary border-default">
            {disabledMessage}
          </div>
        )}

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled || posting}
          placeholder="Say something through your own setup…"
          className="w-full resize-none rounded border bg-transparent p-3 text-sm text-primary border-default focus:outline-none disabled:opacity-50"
          rows={3}
        />

        <div className="mt-3 flex items-center justify-between">
          <span className={`text-xs ${tooLong ? 'text-danger' : 'text-muted'}`}>
            {byteLength} / 10,000 bytes · {castKindFor(byteLength)}
          </span>
          <button
            type="button"
            onClick={handlePost}
            disabled={!canPost}
            className="rounded px-4 py-2 text-sm font-medium text-[#1a1c10] bg-action-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>

        {success && (
          <div className="text-action-primary mt-2 rounded border p-2 text-sm bg-tertiary border-default">
            {success}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded border p-2 text-sm bg-tertiary border-default text-danger">
            {error}
          </div>
        )}
      </div>
    );
  },
);

NodeComposer.displayName = 'NodeComposer';

export { NodeComposer };
