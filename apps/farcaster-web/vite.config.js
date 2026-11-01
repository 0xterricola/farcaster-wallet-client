import { defineConfig, loadEnv } from 'vite';
import { instanceConnectPlugin } from './server/instance/plugin.mjs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createRequire } from 'module';

const httpsEnabled = process.env.HTTPS !== 'false';
const require = createRequire(import.meta.url);
const metamaskMultichainDirectory = path.dirname(
  require.resolve('@metamask/connect-multichain/package.json'),
);
const metamaskMobileProtocolCore = path.resolve(
  metamaskMultichainDirectory,
  '../mobile-wallet-protocol-core/dist/index.mjs',
);
const metamaskEciesCommonJs = path.resolve(
  metamaskMultichainDirectory,
  '../../eciesjs/dist/index.js',
);

// How long the relay waits on the node before it answers the browser with a
// failure. MEASURED (2026-10-20): a healthy public read node answers the feed's
// per-author read in p50 258ms / p95 773ms / max 986ms (60 authors x pageSize=10
// at concurrency 12), so 8s is ~8x the worst healthy read. MEASURED with the
// node address black-holed (34.101.47.167:3381): without these the relay left
// the browser waiting **75.008s** and then answered `500` with an empty body
// (the TCP SYN timeout), which is what made the feed look blank for over a
// minute. With the timeout the browser gets a failure it can read and report.
const NODE_RELAY_TIMEOUT_MS = 8_000;

const nodeRelayProxy = (environment) => {
  const target =
    environment.SNAPCHAIN_HTTP_URL ||
    environment.VITE_SNAPCHAIN_HTTP_URL ||
    'http://127.0.0.1:3381';
  const message = (reason) =>
    `Your node did not answer this read: the relay waited up to ${
      NODE_RELAY_TIMEOUT_MS / 1000
    }s for ${target} and gave up (${reason}).`;
  return {
    target,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/snapchain-api/, ''),
    // MEASURED, in this order:
    //   - no timeout at all: the browser waits 75.008s for a black-holed node
    //     and then gets `500` with an empty body;
    //   - `proxyTimeout` + `timeout` (http-proxy's own pair): bounded at +8.4s,
    //     but the socket is destroyed with **no response at all** (`curl`
    //     status 000) and no event a config can hook — a client still cannot say
    //     what happened;
    //   - this: a per-upstream-request timeout that destroys with an Error, so
    //     the proxy's own error hook can answer the hosted API's error envelope.
    //     Bounded and readable.
    configure: (proxy) => {
      const answer = (reason) => {
        const body = JSON.stringify({ errors: [{ message: message(reason) }] });
        return { status: 504, contentType: 'application/json; charset=utf-8', body };
      };
      // MEASURED: `proxyReq.setTimeout(ms, …)` (and http-proxy's own
      // `proxyTimeout`, which is the same call) never fires while the TCP
      // connect to the node is still hanging — the socket's idle timer starts
      // only once a connection exists — so a black-holed node still hung for the
      // full 40s the probe was willing to wait. A plain timer around the
      // upstream request is what actually bounds the connect.
      proxy.on('proxyReq', (proxyReq) => {
        const deadline = setTimeout(() => {
          proxyReq.destroy(new Error(`no reply within ${NODE_RELAY_TIMEOUT_MS}ms`));
        }, NODE_RELAY_TIMEOUT_MS);
        for (const event of ['response', 'error', 'close']) {
          proxyReq.once(event, () => clearTimeout(deadline));
        }
      });
      proxy.on('error', (error, _request, response) => {
        if (!response || typeof response.writeHead !== 'function') {
          response?.destroy?.();
          return;
        }
        const { status, contentType, body } = answer(
          String(error?.message ?? error),
        );
        try {
          if (!response.headersSent) {
            response.writeHead(status, { 'content-type': contentType });
          }
          response.end(body);
        } catch {
          // The socket was already gone; nothing left to answer with.
        }
      });
    },
  };
};

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, __dirname, '');
  const solanaRpcUrl =
    environment.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

  return {
    plugins: [
      // The instance's own connect service — same origin, same wire shape as
      // fiddy.fun's, so the one-tap approval works on a copy of Fiddy a person
      // runs themselves. Inert without FIDDY_INSTANCE_APP_FID/KEY; see
      // server/instance/connect.mjs.
      instanceConnectPlugin({
        env: { ...process.env, ...environment },
      }),
      react(),
      tailwindcss(),
      nodePolyfills({
        globals: {
          Buffer: true,
          stream: true,
          process: true,
        },
      }),
      ...(httpsEnabled ? [basicSsl()] : []),
    ],
    resolve: {
      alias: [
        {
          find: '~',
          replacement: path.resolve(__dirname, './src'),
        },
        {
          find: /^eciesjs$/,
          replacement: path.resolve(
            __dirname,
            './config/metamaskEciesInterop.mjs',
          ),
        },
        {
          // `@farcaster/core`'s single-file ESM build imports faker at module
          // scope for its test-data factories, which this app never calls — and
          // faker's locale corpus alone is 3.6 MB of source, the largest single
          // contributor to the entry chunk. Answered with a stub that throws if
          // anything ever does call it: see `config/fakerInterop.mjs`.
          find: /^@faker-js\/faker$/,
          replacement: path.resolve(__dirname, './config/fakerInterop.mjs'),
        },
        {
          find: /^metamask-ecies-commonjs$/,
          replacement: metamaskEciesCommonJs,
        },
        {
          // The package publishes an ESM build but omits its module/exports
          // metadata. Without this alias Vite wraps the CommonJS entry as a
          // default-only module, while MetaMask Connect dynamically imports its
          // named SessionStore and WebSocketTransport exports.
          find: /^@metamask\/mobile-wallet-protocol-core$/,
          replacement: metamaskMobileProtocolCore,
        },
      ],
    },
    server: {
      https: httpsEnabled,
      proxy: {
        '/~wallet/solana-rpc': {
          target: solanaRpcUrl,
          changeOrigin: true,
          rewrite: () => '/',
        },
        '/snapchain-api': nodeRelayProxy(environment),
      },
    },
    preview: {
      proxy: {
        '/snapchain-api': nodeRelayProxy(environment),
      },
    },
    build: {
      sourcemap: 'hidden',
      // Match browserslist config: chrome >= 111, edge >= 111, firefox >= 128, safari >= 16.4
      // These browsers all support ES2020 features natively (classes, async/await, spread, etc.)
      target: ['chrome111', 'edge111', 'firefox128', 'safari16.4'],
      rollupOptions: {
        output: {
          manualChunks: {
            // Split heavy vendor libraries into separate chunks
            'vendor-viem': ['viem'],
            'vendor-wagmi': ['wagmi', '@wagmi/core', '@wagmi/connectors'],
            'vendor-solana': ['@solana/web3.js'],
            'vendor-privy': ['@privy-io/react-auth'],
            'vendor-draftjs': [
              'draft-js',
              '@draft-js-plugins/editor',
              '@draft-js-plugins/mention',
              '@draft-js-plugins/emoji',
              '@draft-js-plugins/linkify',
            ],
            'vendor-emoji': [
              'emoji-mart',
              '@emoji-mart/data',
              '@emoji-mart/react',
            ],
            'vendor-charts': ['recharts'],
          },
        },
        plugins: [],
      },
    },
  };
});
