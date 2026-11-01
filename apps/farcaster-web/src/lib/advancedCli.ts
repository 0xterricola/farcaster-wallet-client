/**
 * The Fiddy command line — what it is, what it takes to run, and what is not
 * built yet.
 *
 * WHY THIS FILE EXISTS
 *
 * The agentic half of Fiddy has a keyboard-first door: the Fiddy command
 * (`bin/fiddy` in this repository) provisions a machine, installs a node on it
 * and opens this client against that node. Until now nothing in the product
 * said so — the CLI was reachable only by reading the repository. This module
 * is the copy that surface shows, kept out of the page component so the words
 * can be asserted on their own (see `__tests__/settingsAdvanced.test.tsx`) and
 * so the command list cannot drift between the page and its probe.
 *
 * THE ONE RULE FOR THIS COPY
 *
 * Plain words only. A reader who has never configured anything has to be able
 * to act on every line here, so the protocol's own vocabulary — the words for
 * the machinery behind the scenes — does not appear. The test asserts that.
 *
 * Every command string here is a real subcommand of `bin/fiddy` (see its own
 * usage block); none of them is aspirational. The entries in
 * `AGENT_CLI_COMING` are the opposite: they are named as not-here-yet, because
 * a command that does not answer is worse than no entry at all.
 */

/** Anchor id the surface hangs the CLI entry on, for probes and deep links. */
export const CLI_ANCHOR = 'fiddy-cli';

/** One command, and the plain-words reason to run it. */
export type CliCommand = {
  /** Exactly what the reader types, as `bin/fiddy` documents it. */
  command: string;
  /** What it does for them, in words a newcomer can act on. */
  what: string;
};

/**
 * The three lines, in order. Each one is a real subcommand: `fiddy provision`,
 * `fiddy node up`, `fiddy client up` (the same three the CLI's own usage block
 * lists as (0), (1) and (2)).
 */
export const CLI_COMMANDS: CliCommand[] = [
  {
    command: 'fiddy provision',
    what: 'Get a machine for your setup — a cloud one, or a server you already have.',
  },
  {
    command: 'fiddy node up',
    what: 'Install the node on it and let it catch up with the network.',
  },
  {
    command: 'fiddy client up',
    what: 'Open Fiddy on that machine, reading from your own setup.',
  },
];

/** One more line, for when something is not answering. */
export const CLI_CHECK_COMMAND: CliCommand = {
  command: 'fiddy doctor',
  what: 'Check the machine and say what is missing.',
};

/** Where the command lives, said the way a reader can act on it. */
export const CLI_HOME_COPY =
  'It comes with the project: if you have the Fiddy folder on that machine, it is bin/fiddy — run it from there.';

/** The guided walkthrough, cloud by cloud, with what each one costs. */
export const CLI_WALKTHROUGH_URL = 'https://fiddy.fun/client';

/** The same walkthrough, at the page that creates the machine for you. */
export const CLI_DEPLOY_URL = 'https://fiddy.fun/client/deploy/';

/** The heading and the lead of the CLI entry. */
export const CLI_ENTRY_TITLE = 'The Fiddy command';

export const CLI_ENTRY_LEAD =
  'Fiddy usually runs in your browser. The Fiddy command runs the same client on a computer you control, over a setup of your own. Nothing in the app needs it — skip it and everything here works the way it did.';

/** What the reader gets at the end of the three lines. */
export const CLI_ENTRY_OUTCOME =
  'When the third line has run, Fiddy is open on that machine and every cast you see came from your own setup.';

/** A named thing the command line will do, and that it does not do yet. */
export type ComingEntry = { label: string; note: string };

/**
 * Announced, not built. These are the agentic extras the command line is for;
 * each carries the word for "not here yet" next to it, and the page renders
 * them without any control that could be pressed.
 */
export const AGENT_CLI_COMING: ComingEntry[] = [
  {
    label: 'Chat with your agent from the terminal',
    note: 'soon',
  },
  {
    label: 'Let your agent post from a script',
    note: 'soon',
  },
];

export const AGENT_CLI_TITLE = 'Your agent, at the command line';

export const AGENT_CLI_LEAD =
  'The agent you hatch in Fiddy answers inside the app today. These are the parts of the command line we are still building — they are not here yet, and nothing on this page pretends otherwise.';
