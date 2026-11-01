/**
 * Is the signed-in client meant to read from your own node?
 *
 * YES by default, and that is the point of the whole folder: the hosted client
 * API needs a server session a third-party client cannot hold, so reading
 * `farcaster.xyz` is not an option that can be relied on. The node is the data
 * source; `VITE_SNAPCHAIN_BACKED_CLIENT=false` turns the adapter off (for
 * comparison runs and for the hosted-API probes), and the company it keeps is
 * the dev mock API, which wins over this flag anyway.
 */
export const isNodeBackedClientEnabled = (
  env: Record<string, unknown> = import.meta.env,
): boolean => {
  const flag = env.VITE_SNAPCHAIN_BACKED_CLIENT;
  if (typeof flag === 'string' && flag.trim().length > 0) {
    const normalized = flag.trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0' && normalized !== 'off';
  }
  return true;
};
