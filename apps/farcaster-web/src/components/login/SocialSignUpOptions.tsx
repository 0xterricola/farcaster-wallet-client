/**
 * The two social doors, as they are drawn.
 *
 * Presentational on purpose: this file knows the buttons and the words, and
 * nothing about Privy. That is what lets the sign-in modal offer the doors
 * whether or not Privy's SDK has finished loading, and it is why the button list
 * is drawn from `SOCIAL_PROVIDERS` rather than written out twice — a provider
 * added there appears here, and nowhere else has to change.
 */

import React, { FC, memo } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { SOCIAL_PROVIDERS, type SocialProviderId } from '~/lib/socialSignUp';

type SocialSignUpOptionsProps = {
  onPress: (provider: SocialProviderId) => void;
  /** The door that is currently being opened, if one is. */
  busy?: SocialProviderId;
  /** True while the SDK behind the doors is still loading, or when it is absent. */
  disabled?: boolean;
  /** Why the doors are not usable, in plain words, when they are not. */
  unavailableNote?: string;
  /** What went wrong last time, in plain words. */
  message?: string;
};

const SocialSignUpOptions: FC<SocialSignUpOptionsProps> = memo(
  ({ onPress, busy, disabled = false, unavailableNote, message }) => {
    return (
      <div
        className="flex w-full flex-col items-center"
        data-fiddy="social-sign-up"
      >
        <div className="w-full space-y-3 text-center">
          <div className="text-2xl font-semibold text-default">
            Start with Google or X
          </div>
          <div className="text-muted">
            One press and you are in. Nothing to write down, no wallet to set up
            — this makes an account for you here.
          </div>

          <div className="flex flex-col items-center gap-3">
            {SOCIAL_PROVIDERS.map((provider) => (
              <DefaultButton
                key={provider.id}
                variant="muted"
                className="w-full max-w-[280px]"
                disabled={disabled || busy !== undefined}
                isLoading={busy === provider.id}
                data-fiddy={`social-sign-up-${provider.id}`}
                onClick={() => {
                  onPress(provider.id);
                }}
              >
                {provider.label}
              </DefaultButton>
            ))}
          </div>

          {unavailableNote ? (
            <div className="text-sm text-muted" data-fiddy="social-unavailable">
              {unavailableNote}
            </div>
          ) : null}

          {message ? (
            <div
              className="text-sm text-danger"
              role="alert"
              data-fiddy="social-error"
            >
              {message}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
);

SocialSignUpOptions.displayName = 'SocialSignUpOptions';

export { SocialSignUpOptions };
export type { SocialSignUpOptionsProps };
