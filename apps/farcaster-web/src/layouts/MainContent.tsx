import cn from 'classnames';
import { FC, memo, Suspense } from 'react';
import { Outlet } from 'react-router-dom';

import { ShellSectionErrorBoundary } from '~/components/errors/ShellSectionErrorBoundary';
import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { usePageLayoutSize } from '~/hooks/layout/usePageLayout';
import { MobileHeader } from '~/layouts/MobileHeader';

const MainContent: FC = memo(() => {
  const size = usePageLayoutSize();

  return (
    <main
      className={cn(
        'h-full w-full shrink-0 justify-center',
        'sm:mr-4 sm:w-[540px] lg:w-[620px]',
        size === 'full' && 'lg:!w-[1013px]',
      )}
    >
      <MobileHeader />
      <Suspense fallback={<FullScreenLoadingIndicator />}>
        {/* A page that cannot load stays inside the shell: the chrome, the nav
            and the banner saying whose session this is all survive, and only
            this column says what it cannot reach. The fork's full-screen
            boundary here would take the whole client down and, with a
            device-only session, offer a retry that cannot succeed. */}
        <ShellSectionErrorBoundary label="This page">
          <Outlet />
        </ShellSectionErrorBoundary>
      </Suspense>
    </main>
  );
});

MainContent.displayName = 'MainContent';

export { MainContent };
