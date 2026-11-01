import cn from 'classnames';
import { FC, memo, ReactNode } from 'react';

type LeftSideBarProps = {
  children: ReactNode;
  className?: string;
  /** Classes for the <aside> itself — used by the Fiddy shell to give the
   *  column its own ground and edge instead of insetting them with the row. */
  asideClassName?: string;
};
const LeftSideBar: FC<LeftSideBarProps> = memo(
  ({ className, asideClassName, children }) => {
    return (
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 sm:block xl:w-[220px]',
          asideClassName,
        )}
      >
        <div
          className={cn(
            className,
            'mx-2 flex min-h-screen flex-col items-end xl:items-start',
          )}
        >
          {children}
        </div>
      </aside>
    );
  },
);

LeftSideBar.displayName = 'LeftSideBar';

export { LeftSideBar };
