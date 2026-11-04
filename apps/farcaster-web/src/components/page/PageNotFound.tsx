import { FileIcon, XIcon } from '@primer/octicons-react';
import React, { FC } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { BackButton } from '~/components/forms/buttons/BackButton';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';

interface PageNotFoundProps {
  title: string;
  /**
   * What this particular page says when it does not exist. A missing handle,
   * for instance, is "No one goes by that name." rather than the generic
   * sentence — the node answered, and it said nobody holds that name.
   */
  message?: string;
}

const PageNotFound: FC<PageNotFoundProps> = ({ title, message }) => {
  return (
    <Page meta={{ title }}>
      <BorderedMainContent>
        <PageHeader hideBorderBottom>
          <PageTitle>
            <BackButton />
          </PageTitle>
        </PageHeader>
        <div className="mt-4 flex items-center justify-center p-4 pt-6">
          <div className="flex flex-col items-center space-y-2">
            <div className="relative">
              <FileIcon size={40} className="text-muted" />
              <XIcon
                size={20}
                className="absolute inset-0 m-auto pt-[6px] text-muted"
              />
            </div>
            <span className="text-normal font-normal leading-5 text-muted">
              {message ?? 'This page does not exist.'}
            </span>
          </div>
        </div>
      </BorderedMainContent>
    </Page>
  );
};

export { PageNotFound };
