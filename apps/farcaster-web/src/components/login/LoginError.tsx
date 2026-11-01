import { FC, memo } from 'react';

import { DefaultButton } from '~/components/forms/buttons/DefaultButton';

type LoginErrorProps = {
  message: string;
  /** What to try next. Defaults to the mobile-app hint this modal used to give. */
  hint?: string;
  restart: () => void;
};

const LoginError: FC<LoginErrorProps> = memo(
  ({
    hint = "Make sure you've updated your Farcaster mobile app.",
    message,
    restart,
  }) => {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="mb-2 text-center  text-base text-danger">{message}</div>
        <div className="mb-4 text-sm text-muted">{hint}</div>
        <DefaultButton className="min-w-[140px]" onClick={restart}>
          Try again
        </DefaultButton>
      </div>
    );
  },
);

LoginError.displayName = 'LoginError';

export { LoginError };
