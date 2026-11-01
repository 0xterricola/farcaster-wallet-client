// @vitest-environment jsdom
/**
 * The node picker, as the reader meets it.
 *
 * What these tests hold: both ways are named in plain words, the public list is
 * a real list you can choose from, an address the browser would refuse is
 * refused before it is saved, a good address is saved and then actually asked
 * for its status, and a saved choice can be undone.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type NodeChoice, PUBLIC_READ_NODES } from '~/snapchain/nodeChoice';

// Tests render the component directly, so they import it as its own sibling —
// the same way SettingsNodePage reaches it.
import { NodeChoiceCard } from './NodeChoiceCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** No address answers in these tests unless the test says so. */
const offline = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );

describe('NodeChoiceCard', () => {
  it('names both ways in plain words, and says what running your own costs', () => {
    render(
      <NodeChoiceCard choice={null} onChoose={vi.fn()} onReset={vi.fn()} />,
    );

    expect(screen.getByText('Use a public node')).toBeTruthy();
    expect(screen.getByText('Run your own node')).toBeTruthy();
    expect(screen.getByText(/about 2 TB of free disk/)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /fiddy\.fun\/client/i })
        .getAttribute('href'),
    ).toBe('https://fiddy.fun/client');
  });

  it('offers the verified public nodes as a list, not a mystery box', () => {
    render(
      <NodeChoiceCard choice={null} onChoose={vi.fn()} onReset={vi.fn()} />,
    );

    const select = screen.getByLabelText('Public node') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      ...PUBLIC_READ_NODES.map((entry) => entry.url),
      '__another__',
    ]);
    expect(screen.getByText(PUBLIC_READ_NODES[0].note)).toBeTruthy();
  });

  it('refuses a plain-http address from this https page without saving it', async () => {
    const onChoose = vi.fn();
    render(
      <NodeChoiceCard
        choice={null}
        onChoose={onChoose}
        onReset={vi.fn()}
        pageProtocol="https:"
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Run your own node/ }));
    fireEvent.change(screen.getByLabelText('Your node address'), {
      target: { value: 'http://127.0.0.1:3381' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this one' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'browsers refuse',
      ),
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('saves a good address and then says what the address actually answered', async () => {
    offline();
    const onChoose = vi.fn(async (_choice: NodeChoice) => null);
    render(
      <NodeChoiceCard choice={null} onChoose={onChoose} onReset={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Run your own node/ }));
    fireEvent.change(screen.getByLabelText('Your node address'), {
      target: { value: 'https://mine.example:3381/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this one' }));

    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1));
    expect(onChoose.mock.calls[0][0]).toEqual({
      kind: 'own',
      url: 'https://mine.example:3381/',
    });

    // The saved address was asked, and it did not answer: the card says that
    // rather than implying a working setup.
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'did not answer just now',
      ),
    );
  });

  it('shows which server is in use and lets it be undone', async () => {
    const onReset = vi.fn();
    render(
      <NodeChoiceCard
        choice={{ kind: 'own', url: 'https://mine.example:3381' }}
        onChoose={vi.fn()}
        onReset={onReset}
      />,
    );

    expect(screen.getByText('in use: your own')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: /Go back to what this build came with/,
      }),
    );
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
  });

  it('treats a stored address that is not on the list as another address', () => {
    render(
      <NodeChoiceCard
        choice={{ kind: 'public', url: 'https://someone-elses.example' }}
        onChoose={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText('Public node') as HTMLSelectElement).value,
    ).toBe('__another__');
    expect(
      (screen.getByLabelText('Another public node address') as HTMLInputElement)
        .value,
    ).toBe('https://someone-elses.example');
  });
});
