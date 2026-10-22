import customConfig from 'eslint-config-custom/react';

const NOTION_RE = String.raw`/notion\.(?:so|site)/i`;

export default [
  ...customConfig,
  {
    files: ['**/*.config.js', '**/*.config.mjs', '**/.prettierrc.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // public/ is served as-is by the host: the shell bootstrap runs in the page
    // before the bundle does, so it has the page's globals and nothing else.
    // It is the one file under public/ that is code; the rest is assets.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        localStorage: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    // The probes in scripts/ are Node programs that also read the page they
    // drive, inside page.evaluate() callbacks, so they need both sides'
    // globals. validateSitemaps.mjs imports its Node globals from `node:`
    // instead; these are here so a probe that does not is still lintable.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        cancelAnimationFrame: 'readonly',
        console: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        getComputedStyle: 'readonly',
        Image: 'readonly',
        // A probe that drives the wallet flows reads the page's own IndexedDB
        // (the key store and the draft store live there); it is a page global,
        // like `localStorage` above, and no probe imports a module for it.
        indexedDB: 'readonly',
        localStorage: 'readonly',
        MutationObserver: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        requestAnimationFrame: 'readonly',
        URL: 'readonly',
        window: 'readonly',
        // Node's own, not the page's: a probe bounds its reads of release.json and
        // the served chunks with AbortSignal.timeout(ms). Node exports no module
        // for it, so it is declared here rather than imported.
        AbortSignal: 'readonly',
      },
    },
    rules: {
      // A failed localStorage write in an addInitScript is genuinely
      // ignorable, same as everywhere else in the repo.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      curly: 'error',
      'no-restricted-globals': ['error', 'reportError'],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name='window'][left.object.property.name='location'][left.property.name='href']",
          message:
            'Please use useExternalNavigate() instead to support proper navigation in the PWA mode.',
        },
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.name='location'][left.property.name='href']",
          message:
            'Please use useExternalNavigate() instead to support proper navigation in the PWA mode.',
        },
        {
          selector: `Literal[value=${NOTION_RE}]`,
          message:
            'Use getNotionLink() helper instead of hard-coding Notion URLs.',
        },
        {
          selector: `TemplateElement[value.raw=${NOTION_RE}]`,
          message:
            'Use getNotionLink() helper instead of hard-coding Notion URLs.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'farcaster-client-hooks/src',
                'farcaster-client-hooks/src/**',
                '../../farcaster-client-hooks/src/**',
                '**/farcaster-client-hooks/src/**',
              ],
              message: 'Always import from farcaster-client-hooks.',
            },
            {
              group: ['../*'],
              message: 'Prefer absolute imports using the `~` alias.',
            },
            {
              group: ['~/pages/*'],
              message: 'Always import from ~/lazy/pages.',
            },
            {
              group: [
                './LoginQRCode',
                '~/components/login/LoginQRCode',
                '~/components/composer/Composer',
                './Composer',
              ],
              message: 'Please import from ~/lazy/components',
            },
            {
              group: [
                '~/components/casts/UnfocusedCast',
                '~/components/casts/FocusedCast',
              ],
              message:
                'You probably want ~/components/casts/Cast so it uses the global cast cache',
            },
          ],
          paths: [
            {
              name: 'localforage',
              message: 'Prefer utils in ~/utils/StorageUitls instead',
            },
            {
              name: '@tanstack/react-query',
              importNames: ['useMutation'],
              message:
                'Please write a memoized async function that handles optimistic updates and invalidations.',
            },
            {
              name: 'react-router-dom',
              importNames: [
                'Link',
                'NavLink',
                'useNavigate',
                'useParams',
                'useSearchParams',
              ],
              message:
                'Prefer navigation components in ~/components and hooks in ~/hooks/navigation.',
            },
            {
              name: 'linkify-it',
              message:
                'Prefer useLinkifyText hook in ~/hooks or the singleton linkify instance in ~/utils.',
            },
            {
              name: 'farcaster-client-hooks',
              importNames: [
                'useOnboardingState',
                'useMarkWalletConversationRead',
                'useRefreshWalletConversationForParticipants',
                'useUserAppContext',
                'useFeatureGate',
              ],
              message: 'Please use the corresponding local hook instead.',
            },
            {
              name: 'react-toastify',
              importNames: ['toast'],
              message:
                'Do not use React Toastify directly. Use toast() in utils/toast.ts instead.',
            },
            {
              name: '@radix-ui/react-tooltip',
              message: 'Please use ~/components/Tooltip instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // The per-page unfurl service (server/unfurl/, shipped by the release and
    // run by fiddy-unfurl.service): Node's own globals, not the page's. It is
    // outside src because it is not part of the bundle — the host runs it — so
    // the `~` alias (which points at src) does not reach it and its tests
    // import it by relative path instead (see the block below).
    files: ['server/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The app's tests of that service import its modules by path on purpose:
    // they are not under `~/` (that alias is src, which the browser bundle
    // owns), and a test that drove a copy would prove nothing about the code
    // the host runs.
    files: ['src/__tests__/unfurlService.test.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
