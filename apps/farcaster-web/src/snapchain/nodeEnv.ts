/**
 * Environment and configuration for connecting to a Snapchain node.
 *
 * The browser cannot call a plain HTTP node directly because:
 * 1. The dev server is HTTPS but the node sets Access-Control-Allow-Origin: *
 *    without answering CORS preflight
 * 2. POST /v1/submitMessage with application/octet-stream is blocked as a
 *    cross-origin request
 *
 * Therefore the app talks to the node through a same-origin relay path
 * `/snapchain-api`, which the Vite dev/preview server proxies to the node's
 * real URL.
 */

/** The relay path the browser uses — same-origin, so no CORS issues. */
export const NODE_PROXY_PATH = '/snapchain-api';

/** Default fallback when no environment is configured. */
export const DEFAULT_NODE_URL = 'http://127.0.0.1:3381';

/**
 * Resolve the base URL the browser client should use.
 *
 * When VITE_SNAPCHAIN_HTTP_URL is set and non-empty, use it directly — unless
 * that URL is a *different origin* than the page and the page is a browser.
 * A browser can only read a node it is allowed to reach: a cross-origin node
 * has to answer CORS, and a Snapchain node answers plain GETs (`*`) but not the
 * preflight a JSON POST needs — which is exactly why `/snapchain-api` exists.
 * This repo's dev and preview servers both proxy that path to the same node,
 * so in a browser the relay is the working route to the node the operator
 * configured. MEASURED: reading a node directly from a page on another origin
 * fails the write-shaped requests (`submitMessage`, the feed's POST) at the
 * preflight, while the same requests through the relay reach the node.
 *
 * Escape hatch: `VITE_SNAPCHAIN_DIRECT=true` forces the direct URL even when it
 * is cross-origin — for a deployment that serves the app and the node from one
 * host with correct CORS.
 *
 * @param env - The import.meta.env object (allows test injection)
 * @param pageOrigin - The page's origin; defaults to the browser's own
 */
export const resolveNodeBaseUrl = (
  env: Record<string, unknown> = import.meta.env,
  pageOrigin: string | undefined = typeof window === 'undefined'
    ? undefined
    : window.location.origin,
): string => {
  const directUrl = env.VITE_SNAPCHAIN_HTTP_URL as string | undefined;
  if (!directUrl || directUrl.trim().length === 0) {
    return NODE_PROXY_PATH;
  }

  const trimmed = directUrl.trim();

  const forceDirect = env.VITE_SNAPCHAIN_DIRECT as string | undefined;
  if (forceDirect === 'true') {
    return trimmed;
  }

  if (pageOrigin !== undefined) {
    try {
      if (new URL(trimmed).origin !== pageOrigin) {
        return NODE_PROXY_PATH;
      }
    } catch {
      // Not a URL at all: the relay is the safer answer than a broken one.
      return NODE_PROXY_PATH;
    }
  }

  return trimmed;
};

/**
 * The address this build was pointed at, before any relay resolution — the raw
 * `VITE_SNAPCHAIN_HTTP_URL`, or null when the build names no node at all.
 *
 * `resolveNodeBaseUrl` answers where the browser should SEND requests (a
 * cross-origin node becomes the same-origin relay path). This answers the other
 * question a surface sometimes has to ask out loud: which address was named?
 * The box above the reader's own node and the network picker both need it.
 */
export const configuredNodeUrl = (
  env: Record<string, unknown> = import.meta.env,
): string | null => {
  const directUrl = env.VITE_SNAPCHAIN_HTTP_URL as string | undefined;
  return directUrl && directUrl.trim().length > 0 ? directUrl.trim() : null;
};

/**
 * Did the user (or the deploy) name a node explicitly?
 *
 * This is what separates "you chose to read from your own node and it is not
 * answering" from "this build never had a node at all". The status pill must
 * say which one it is: a silent fall back to the public relay would be the
 * client lying about where its data came from.
 */
export const isNodeExplicitlyConfigured = (
  env: Record<string, unknown> = import.meta.env,
): boolean => configuredNodeUrl(env) !== null;

/**
 * Resolve the target URL for the Vite proxy configuration.
 *
 * This determines where `/snapchain-api` requests get forwarded to.
 * Priority: SNAPCHAIN_HTTP_URL (server-side) > VITE_SNAPCHAIN_HTTP_URL (client-side)
 * > default localhost.
 *
 * @param env - The loadEnv result object
 */
export const resolveNodeProxyTarget = (
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): string => {
  const serverUrl = env.SNAPCHAIN_HTTP_URL;
  const clientUrl = env.VITE_SNAPCHAIN_HTTP_URL;

  // Only use a value if it's set and non-empty after trimming
  if (serverUrl && serverUrl.trim().length > 0) {
    return serverUrl.trim();
  }
  if (clientUrl && clientUrl.trim().length > 0) {
    return clientUrl.trim();
  }
  return DEFAULT_NODE_URL;
};
