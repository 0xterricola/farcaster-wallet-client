/**
 * The CLI entry: three lines, each copyable, and the plain-words reason for it.
 *
 * WHY A COPY BUTTON, AND WHY IT CAN FAIL OUT LOUD
 *
 * The reader is being asked to leave the app and type into a terminal; a line
 * they can copy is the difference between reading about the command and running
 * it. The clipboard is not always available (an http page, a browser that
 * refuses the call, a test environment), and a copy button that silently does
 * nothing is a small lie — so the button reports what happened: "Copied", or
 * "Select it and copy" when the browser would not hand the text over. The
 * commands stay on screen as selectable text either way.
 */

import React, { FC, memo, useState } from 'react';

import { ExternalLink } from '~/components/links/ExternalLink';
import {
  CLI_CHECK_COMMAND,
  CLI_COMMANDS,
  CLI_DEPLOY_URL,
  CLI_ENTRY_LEAD,
  CLI_ENTRY_OUTCOME,
  CLI_ENTRY_TITLE,
  CLI_HOME_COPY,
  CLI_WALKTHROUGH_URL,
  type CliCommand,
} from '~/lib/advancedCli';

type CopyState = 'idle' | 'copied' | 'failed';

const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Select it and copy',
};

const COMMAND_CLASS =
  'flex-1 select-all rounded border px-2 py-1 font-mono text-xs text-primary bg-secondary border-default';

/** One line of the sequence, with the copy control that makes it usable. */
const CliCommandRow: FC<{ entry: CliCommand; last?: boolean }> = memo(
  ({ entry, last = false }) => {
    const [state, setState] = useState<CopyState>('idle');

    const copy = () => {
      const clipboard =
        typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        setState('failed');
        return;
      }
      clipboard.writeText(entry.command).then(
        () => setState('copied'),
        () => setState('failed'),
      );
    };

    return (
      <li
        className={last ? 'flex flex-col gap-1' : 'mb-3 flex flex-col gap-1'}
        data-fiddy="cli-command"
        data-command={entry.command}
      >
        <div className="flex items-center gap-2">
          <code className={COMMAND_CLASS}>{entry.command}</code>
          <button
            type="button"
            onClick={copy}
            data-fiddy="cli-copy"
            aria-label={`Copy ${entry.command}`}
            className="shrink-0 rounded border px-2 py-1 text-xs text-primary bg-tertiary border-default"
          >
            {COPY_LABEL[state]}
          </button>
        </div>
        <span className="text-sm text-muted">{entry.what}</span>
      </li>
    );
  },
);

CliCommandRow.displayName = 'CliCommandRow';

const CliEntryCard: FC = memo(() => {
  return (
    <section
      id="fiddy-cli"
      data-fiddy="advanced-cli"
      aria-labelledby="fiddy-cli-heading"
      className="mb-6 rounded-lg border bg-secondary p-4 border-default"
    >
      <h3
        id="fiddy-cli-heading"
        className="mb-2 text-base font-bold text-primary"
      >
        {CLI_ENTRY_TITLE}
      </h3>
      <p className="mb-3 text-sm text-primary">{CLI_ENTRY_LEAD}</p>

      <p className="mb-2 text-sm font-semibold text-primary">
        Three lines, in order
      </p>
      <ul className="mb-3 list-none p-0">
        {CLI_COMMANDS.map((entry, index) => (
          <CliCommandRow
            key={entry.command}
            entry={entry}
            last={index === CLI_COMMANDS.length - 1}
          />
        ))}
      </ul>

      <div className="mb-3 flex flex-col gap-1">
        <p className="mb-2 text-sm font-semibold text-primary">
          If something is not answering
        </p>
        <ul className="list-none p-0">
          <CliCommandRow entry={CLI_CHECK_COMMAND} last />
        </ul>
      </div>

      <p className="mb-2 text-sm text-primary">{CLI_ENTRY_OUTCOME}</p>
      <p className="mb-3 text-sm text-muted">{CLI_HOME_COPY}</p>

      <div className="flex flex-col gap-1 text-sm">
        <ExternalLink
          href={CLI_WALKTHROUGH_URL}
          title="The Fiddy command, step by step"
          className="text-primary underline"
        >
          Walk me through it, one step at a time
        </ExternalLink>
        <ExternalLink
          href={CLI_DEPLOY_URL}
          title="Have the machine made for you"
          className="text-muted underline"
        >
          Or have the machine made for you
        </ExternalLink>
      </div>
    </section>
  );
});

CliEntryCard.displayName = 'CliEntryCard';

export { CliEntryCard };
