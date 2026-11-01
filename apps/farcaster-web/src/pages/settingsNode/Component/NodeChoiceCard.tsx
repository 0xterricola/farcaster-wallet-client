/**
 * Where Fiddy reads from — the two ways, in plain words.
 *
 * This is the surface the status pill opens, and the only place in the product
 * where the reader decides which server answers for them. Two options, because
 * there are two:
 *
 *   a public one — somebody else runs it, it is open to read from, nothing to
 *   install. The list is measured (see `~/snapchain/nodeChoice`), and an
 *   address that is not on it can still be pasted.
 *
 *   your own — a machine you run and keep on. It is not a small favour to
 *   yourself, so the card says what it costs before you start, and links the
 *   walkthrough instead of pretending it is a checkbox.
 *
 * Two things this card refuses to do: save an address the browser itself would
 * refuse (a plain-http address from an https page — it can never work, and
 * saving it would make the pill claim a server nothing can reach), and claim an
 * address works because it was typed. Saving asks the address for its own
 * status and reports what came back, including nothing.
 */

import { SnapchainNodeClient } from 'farcaster-node-client';
import React, { memo, useCallback, useState } from 'react';

import {
  nodeAddressProblem,
  type NodeChoice,
  PUBLIC_READ_NODES,
} from '~/snapchain/nodeChoice';

const OWN_NODE_TUTORIAL = 'https://fiddy.fun/client';

/** The guided page that creates the machine for you, cloud by cloud. */
const OWN_NODE_DEPLOY = 'https://fiddy.fun/client/deploy/';

/**
 * What launching a node actually costs, in the words the deploy page uses.
 *
 * Every figure here is the number in `cli/provision.sh`'s own output and in
 * `site/deploy/` — not an estimate made up for this card. The order is the
 * owner's ask (AWS first, because that is the path with official docs) with the
 * measured cheapest named as such.
 */
const NODE_PATHS: { name: string; price: string; note?: string }[] = [
  { name: 'AWS', price: '~$285/mo', note: 'official docs path' },
  { name: 'Google Cloud', price: '~$350/mo', note: 'the one we tested' },
  { name: 'OVHcloud', price: '~$190/mo' },
  { name: 'Hetzner', price: '~€120/mo', note: 'cheapest' },
];

const CUSTOM = '__another__';

type Outcome = { ok: boolean; text: string };

interface NodeChoiceCardProps {
  /** What is stored for this reader, or null when nothing is chosen yet. */
  choice: NodeChoice | null;
  onChoose: (choice: NodeChoice) => Promise<unknown> | unknown;
  onReset: () => Promise<unknown> | unknown;
  /**
   * Test seam: how this page itself is served, which decides whether a plain
   * http address can ever work. Defaults to the real page's protocol.
   */
  pageProtocol?: string;
}

/** Ask the address for its own status; report exactly what came back. */
const checkAddress = async (url: string): Promise<Outcome> => {
  const baseUrl = url.trim().replace(/\/+$/, '');
  try {
    const health = await new SnapchainNodeClient({ baseUrl }).health();
    if (health.ok) {
      const version = health.info?.version;
      return {
        ok: true,
        text: `It answered in ${health.latencyMs} ms${
          version ? ` · v${version}` : ''
        }. Fiddy reads and writes through it from now on.`,
      };
    }
    return {
      ok: false,
      text: 'Saved, but it did not answer just now. Fiddy will say it is offline, and keep using what it used before, until it does.',
    };
  } catch (error) {
    return {
      ok: false,
      text: `Saved, but it did not answer just now (${
        error instanceof Error ? error.message : String(error)
      }). Fiddy will say it is offline, and keep using what it used before, until it does.`,
    };
  }
};

const NodeChoiceCard = memo<NodeChoiceCardProps>(
  ({ choice, onChoose, onReset, pageProtocol }) => {
    const storedPublicUrl =
      choice?.kind === 'public' &&
      PUBLIC_READ_NODES.every((entry) => entry.url !== choice.url)
        ? CUSTOM
        : (choice?.url ?? PUBLIC_READ_NODES[0]?.url ?? '');

    const [mode, setMode] = useState<'public' | 'own'>(
      choice?.kind === 'own' ? 'own' : 'public',
    );
    const [publicUrl, setPublicUrl] = useState(storedPublicUrl);
    const [customPublicUrl, setCustomPublicUrl] = useState(
      storedPublicUrl === CUSTOM ? (choice?.url ?? '') : '',
    );
    const [ownUrl, setOwnUrl] = useState(
      choice?.kind === 'own' ? choice.url : '',
    );
    const [problem, setProblem] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [busy, setBusy] = useState(false);

    const save = useCallback(async () => {
      const raw =
        mode === 'public'
          ? publicUrl === CUSTOM
            ? customPublicUrl
            : publicUrl
          : ownUrl;

      const refusal = nodeAddressProblem(
        raw,
        pageProtocol ??
          (typeof window === 'undefined' ? 'https:' : window.location.protocol),
      );
      if (refusal) {
        setProblem(refusal);
        setOutcome(null);
        return;
      }

      setProblem(null);
      setOutcome(null);
      setBusy(true);
      try {
        await onChoose({ kind: mode, url: raw.trim() });
        setOutcome(await checkAddress(raw));
      } finally {
        setBusy(false);
      }
    }, [mode, publicUrl, customPublicUrl, ownUrl, onChoose, pageProtocol]);

    const reset = useCallback(async () => {
      setBusy(true);
      setProblem(null);
      setOutcome(null);
      try {
        await onReset();
      } finally {
        setBusy(false);
      }
    }, [onReset]);

    const optionShell = (selected: boolean) =>
      `rounded-lg border p-4 ${
        selected ? 'border-[#d4ff3f]/50 bg-tertiary' : 'border-default'
      }`;

    return (
      <div
        className="solid-glass-pane rounded-lg border p-4 border-default"
        data-fiddy="node-choice"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold text-primary">
            Where Fiddy reads from
          </span>
          {choice && (
            <span className="text-xs text-muted">
              in use:{' '}
              {choice.kind === 'public' ? 'a public server' : 'your own'}
            </span>
          )}
        </div>
        <p className="mb-4 text-sm text-muted">
          Fiddy reads and writes through one server. Pick one that is already
          open to everyone, or one you run yourself. Either way, the pill at the
          top of Fiddy says which one answered.
        </p>

        <div className="flex flex-col gap-3">
          {/* (a) a public one */}
          <div className={optionShell(mode === 'public')}>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="fiddy-node-choice"
                className="mt-1 accent-[#d4ff3f]"
                checked={mode === 'public'}
                onChange={() => setMode('public')}
              />
              <span className="flex-1">
                <span className="block font-medium text-primary">
                  Use a public node
                </span>
                <span className="block text-xs text-muted">
                  Nothing to install, nothing to pay, and it is somebody
                  else&rsquo;s job to keep it running. The one Fiddy lists is
                  the public Hypersnap node &mdash; an independent parallel
                  network, not the one Farcaster accounts live on. The network
                  picker above says which one you are reading.
                </span>
              </span>
            </label>

            {mode === 'public' && (
              <div className="mt-3 flex flex-col gap-2 pl-6">
                <select
                  aria-label="Public node"
                  value={publicUrl}
                  onChange={(event) => setPublicUrl(event.target.value)}
                  className="rounded border bg-transparent p-2 text-sm text-primary border-default"
                >
                  {PUBLIC_READ_NODES.map((entry) => (
                    <option key={entry.url} value={entry.url}>
                      {entry.name} — {entry.url}
                    </option>
                  ))}
                  <option value={CUSTOM}>Another address…</option>
                </select>

                {publicUrl === CUSTOM && (
                  <input
                    aria-label="Another public node address"
                    value={customPublicUrl}
                    onChange={(event) => setCustomPublicUrl(event.target.value)}
                    placeholder="https://…"
                    className="rounded border bg-transparent p-2 text-sm text-primary border-default"
                  />
                )}

                {PUBLIC_READ_NODES.some(
                  (entry) => entry.url === publicUrl && entry.note,
                ) && (
                  <span className="text-xs text-muted">
                    {
                      PUBLIC_READ_NODES.find((entry) => entry.url === publicUrl)
                        ?.note
                    }
                  </span>
                )}
              </div>
            )}
          </div>

          {/* (b) your own */}
          <div className={optionShell(mode === 'own')}>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="fiddy-node-choice"
                className="mt-1 accent-[#d4ff3f]"
                checked={mode === 'own'}
                onChange={() => setMode('own')}
              />
              <span className="flex-1">
                <span className="block font-medium text-primary">
                  Run your own node
                </span>
                <span className="block text-xs text-muted">
                  Yours alone: nobody else reads through it and nobody can turn
                  it off. It needs a computer that stays on with about 2 TB of
                  free disk, and an address Fiddy can reach.
                </span>
                <a
                  href={OWN_NODE_TUTORIAL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-action-primary mt-1 inline-block text-xs hover:underline"
                >
                  Read the walkthrough at fiddy.fun/client
                </a>
              </span>
            </label>

            {mode === 'own' && (
              <div className="mt-3 flex flex-col gap-2 pl-6">
                <input
                  aria-label="Your node address"
                  value={ownUrl}
                  onChange={(event) => setOwnUrl(event.target.value)}
                  placeholder="https://your-server.example:3381"
                  className="rounded border bg-transparent p-2 text-sm text-primary border-default"
                />
                <span className="text-xs text-muted">
                  The address your node answers on. This page is served over
                  https, so paste an https address — a plain http one will be
                  refused by the browser itself, not by Fiddy.
                </span>
              </div>
            )}
          </div>

          {/* (c) launch one, if you have none yet */}
          <div className={optionShell(false)} data-fiddy="launch-own-node">
            <div className="font-medium text-primary">Launch your own node</div>
            <div className="mt-1 text-xs text-muted">
              No node to point at yet? Fiddy does not rent machines, and it does
              not pretend to: the deploy page walks you through creating one in
              your own cloud account, then hands you the address to paste above.
              Any Ubuntu box with 4 vCPU, 16 GB of memory and a 2 TB disk will
              do — the node syncs the whole network on first start, which takes
              hours, not minutes.
            </div>

            <div className="mt-3 flex flex-col gap-1">
              {NODE_PATHS.map((path) => (
                <div
                  key={path.name}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="w-28 text-primary">{path.name}</span>
                  <span className="text-muted">{path.price}</span>
                  {path.note ? (
                    <span className="text-xs text-muted">· {path.note}</span>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-2 text-xs text-muted">
              Those are the numbers in the deploy page and in the CLI’s own
              output, not estimates. Hetzner is the cheapest measured; AWS is
              the path with official documentation. You pay your cloud, not us.
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <a
                href={OWN_NODE_DEPLOY}
                target="_blank"
                rel="noreferrer"
                className="rounded px-3 py-1 text-xs text-[#1a1c10] bg-action-primary hover:opacity-90"
              >
                Open the deploy page
              </a>
              <a
                href={OWN_NODE_TUTORIAL}
                target="_blank"
                rel="noreferrer"
                className="text-action-primary text-xs hover:underline"
              >
                Read the walkthrough
              </a>
            </div>

            <div className="mt-2 text-xs text-muted">
              Prefer the terminal? The same thing is one command:{' '}
              <code className="text-primary">fiddy provision --aws</code> (or{' '}
              <code className="text-primary">--gcp</code>,{' '}
              <code className="text-primary">--ovh</code>,{' '}
              <code className="text-primary">--hetzner</code>, or{' '}
              <code className="text-primary">--ssh you@host</code> for a server
              you already have).
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded px-3 py-1 text-sm text-[#1a1c10] bg-action-primary disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Use this one'}
          </button>
          {choice && (
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="rounded px-2 py-1 text-sm text-muted hover:text-primary disabled:opacity-50"
            >
              Go back to what this build came with
            </button>
          )}
        </div>

        {problem && (
          <div
            role="alert"
            className="mt-3 rounded border p-2 text-xs bg-tertiary border-default text-danger"
          >
            {problem}
          </div>
        )}

        {outcome && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 rounded border p-2 text-xs text-muted bg-tertiary border-default"
          >
            {outcome.text}
          </div>
        )}
      </div>
    );
  },
);

NodeChoiceCard.displayName = 'NodeChoiceCard';

export { NodeChoiceCard };
