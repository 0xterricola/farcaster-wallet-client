import '~/index.css';
// Initialize dayjs with plugins and custom locale (replaces moment)
import '~/utils/dayjs';

import { initDateFns } from 'farcaster-client-hooks';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from '~/components/App';
import { initAnalytics } from '~/init/initAnalytics';
import { initFarcasterApi } from '~/init/initFarcasterApi';
import { initPolyfills } from '~/init/initPolyfills';
import { initPreloadLazyComponents } from '~/init/initPreloadLazyComponents';
import { installStaleChunkReloadListener } from '~/init/initReloadOnStaleChunks';

const init = () => {
  initAnalytics();
  initDateFns();
  initFarcasterApi();
  initPolyfills();
  // Before the preloader below: this tab may already be a build behind, and the
  // preloader is the first thing in the app that fetches a chunk.
  installStaleChunkReloadListener();
  initPreloadLazyComponents();
};

init();

const $root = document.getElementById('root');

if ($root) {
  const root = ReactDOM.createRoot($root);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
