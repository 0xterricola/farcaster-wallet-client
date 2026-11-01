// @vitest-environment jsdom

/**
 * The doors themselves: both of them, from one list, and nothing invented.
 *
 * This is the component the sign-in modal draws whether or not Privy's SDK has
 * arrived, so what it must get right is small and checkable: a button per
 * provider in `SOCIAL_PROVIDERS`, a press that says which door it was, and a
 * sentence in plain words when a door cannot be used.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SocialSignUpOptions } from '~/components/login/SocialSignUpOptions';

describe('the sign-up doors', () => {
  it('draws one button per provider, in the order the list gives', () => {
    render(<SocialSignUpOptions onPress={() => undefined} />);

    const doors = Array.from(
      document.querySelectorAll('[data-fiddy^="social-sign-up-"]'),
    ).map((element) => element.textContent);

    expect(doors).toEqual(['Continue with Google', 'Continue with X']);
  });

  it('says which door was pressed', () => {
    const onPress = vi.fn();

    render(<SocialSignUpOptions onPress={onPress} />);

    fireEvent.click(screen.getByText('Continue with X'));

    expect(onPress).toHaveBeenCalledWith('twitter');
  });

  it('is unusable, and says why, while the SDK behind it is still arriving', () => {
    render(
      <SocialSignUpOptions
        disabled
        onPress={() => undefined}
        unavailableNote="Getting Google and X ready — one moment."
      />,
    );

    expect(
      (screen.getByText('Continue with Google') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByText('Continue with X') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Getting Google and X ready/)).toBeTruthy();
  });

  it('shows a failure as an alert, in the caller’s own words', () => {
    render(
      <SocialSignUpOptions
        onPress={() => undefined}
        message="Google sign-up is switched off for this app right now."
      />,
    );

    const alert = screen.getByRole('alert');

    expect(alert.getAttribute('data-fiddy')).toBe('social-error');
    expect(alert.textContent).toContain('switched off');
  });

  it('does not name the third party behind the doors', () => {
    render(<SocialSignUpOptions onPress={() => undefined} />);

    expect(document.body.textContent).not.toContain('Privy');
  });
});
