// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, {
  type ButtonHTMLAttributes,
  type PropsWithChildren,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('farcaster-client-hooks', () => ({
  EventingProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));
vi.mock('~/components/BorderedMainContent', () => ({
  BorderedMainContent: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
}));
vi.mock('~/components/casts/Cast', () => ({ Cast: () => <div /> }));
vi.mock('~/components/forms/buttons/DefaultButton', () => ({
  DefaultButton: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock('~/components/lists/FlatList', () => ({ FlatList: () => <div /> }));
vi.mock('~/components/modals/LoginModal', () => ({
  LoginModal: () => <div>Sign-in choices</div>,
}));
vi.mock('~/components/page/Page', () => ({
  Page: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('~/components/page/PageHeader', () => ({
  PageHeader: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('~/components/page/PageTitle', () => ({
  PageTitle: ({ children }: PropsWithChildren) => <h1>{children}</h1>,
}));
vi.mock('~/hooks/data/useIsSignedIn', () => ({ useIsSignedIn: () => false }));
vi.mock('~/hooks/data/usePublicWindow', () => ({ usePublicWindow: vi.fn() }));

import {
  type PublicWindow,
  usePublicWindow,
} from '~/hooks/data/usePublicWindow';
// The unit test measures the surface itself, not the production lazy wrapper.
// eslint-disable-next-line no-restricted-imports
import { PublicFeedPage } from '~/pages/publicBrowse/PublicBrowsePage';

const windowState = (overrides: Partial<PublicWindow> = {}): PublicWindow => ({
  kind: 'recent',
  topic: null,
  selectKind: vi.fn(),
  selectTopic: vi.fn(),
  feedType: 'recent',
  topics: [],
  castsWithContext: [],
  isLoading: false,
  isError: false,
  errorMessage: null,
  isFetching: false,
  isEmpty: false,
  onEndReached: vi.fn(),
  isFetchingNextPage: false,
  hasNextPage: false,
  retry: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.mocked(usePublicWindow).mockReturnValue(windowState());
});

afterEach(cleanup);

describe('public browse voice', () => {
  it('says what Fiddy is doing while the first casts load', () => {
    vi.mocked(usePublicWindow).mockReturnValue(
      windowState({ isLoading: true }),
    );
    render(<PublicFeedPage />);

    expect(screen.getByRole('status').textContent).toContain(
      'Fiddy is looking for fresh casts…',
    );
  });

  it('gives a signed-out reader a friendly way into the conversation', () => {
    render(<PublicFeedPage />);

    expect(
      screen.getByText('Take a look around. No account needed.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to join in' }));
    expect(screen.getByText('Sign-in choices')).toBeTruthy();
  });

  it('makes an empty read warm, honest, and easy to retry', async () => {
    const retry = vi.fn();
    vi.mocked(usePublicWindow).mockReturnValue(
      windowState({ isEmpty: true, retry }),
    );
    render(<PublicFeedPage />);

    expect(
      screen.getByRole('heading', {
        name: 'No fresh casts in this corner yet.',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/the server had nothing to share this time/i),
    ).toBeTruthy();
    expect(screen.getByText(/the network is not empty/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
