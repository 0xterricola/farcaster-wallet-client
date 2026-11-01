import React, { FC, memo } from 'react';

import { asSentence } from '~/snapchain/nodeApi/nodeCannotAnswer';

type NodeCannotAnswerPanelProps = {
  /** The surface's name in the user's words ("Direct casts", "This page"). */
  label: string;
  /** The adapter's own sentence for why the node cannot serve this. */
  reason: string;
  /** Offered only when a retry could actually change the outcome. */
  onRetry?: () => void;
};

/**
 * A surface your node cannot answer, said in the shell rather than faked.
 *
 * WHY THIS EXISTS
 * Reading from your own node means some surfaces have no data source at all:
 * search, ranking, the channel directory and direct messages are hosted
 * products, not protocol messages (`~/snapchain/nodeApi/hostedRoutes` says so
 * per endpoint). Those reads are refused with a sentence saying whose job they
 * are — and a surface has two dishonest ways to handle that refusal:
 *
 *   - a generic "error retrieving data, try again", which offers a retry for a
 *     read no retry can fix, and hides the reason the adapter wrote;
 *   - an empty list, which reads as "there is nothing here" when the truth is
 *     "this cannot be read here at all".
 *
 * So the sentence goes on screen, in the region that failed, with the shell
 * standing around it. The same panel is what the direct-cast route shows in
 * place of an inbox that would otherwise be empty (`data-fiddy` marker both
 * cases share: `node-cannot-answer`).
 *
 * TWO FAILURES, ONE PANEL, TWO TITLES. The adapter answers `501` when your node
 * cannot read something at all, and `502` when it was asked and did not answer.
 * Those are different facts and the heading says which one it is: nothing is
 * "on your node" for a refusal, and the retry it offers (the `onRetry` the
 * caller passes for a `502`) is the one that can change a timeout.
 */
const NodeCannotAnswerPanel: FC<NodeCannotAnswerPanelProps> = memo(
  ({ label, reason, onRetry }) => (
    <div className="fiddy-degrade" data-fiddy="node-cannot-answer">
      <p className="fiddy-degrade-title">
        {onRetry
          ? `${label} didn’t load from your node`
          : `${label} isn’t on your node`}
      </p>
      <p className="fiddy-degrade-body">{asSentence(reason)}</p>
      {onRetry ? (
        <div className="fiddy-degrade-actions">
          <button
            type="button"
            className="fiddy-quiet-btn fiddy-quiet-btn-outline fiddy-degrade-btn"
            onClick={onRetry}
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  ),
);

NodeCannotAnswerPanel.displayName = 'NodeCannotAnswerPanel';

export { NodeCannotAnswerPanel };
