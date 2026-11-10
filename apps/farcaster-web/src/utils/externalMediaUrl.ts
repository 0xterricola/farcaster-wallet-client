export type MediaPageLocation = Pick<Location, 'hostname' | 'protocol'>;

const isLocalMediaHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\./);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host.startsWith('[fc') ||
    host.startsWith('[fd') ||
    host.startsWith('[fe80:') ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    (ipv4?.[1] === '172' && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
  );
};

/**
 * External HTTP media on an HTTPS page is requested over HTTPS explicitly.
 * The original host, path, query, and fragment stay untouched; local and
 * self-hosted development URLs keep working as they did before.
 */
export const secureExternalMediaUrl = (
  url: string,
  page: MediaPageLocation | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
): string => {
  if (page?.protocol !== 'https:' || !/^http:\/\//i.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.toLowerCase() === page.hostname.toLowerCase() ||
      isLocalMediaHost(parsed.hostname)
    ) {
      return url;
    }
    return `https://${url.slice(url.indexOf('://') + 3)}`;
  } catch {
    return url;
  }
};

/**
 * Whether THIS build asks its own host for other sites' pictures.
 *
 * A build-time switch, not a per-render question: `VITE_IMAGE_PROXY=on` is set
 * by a release that also runs the server half (`FIDDY_IMG_PROXY=on`, see
 * `server/img/`). A self-hosted build without it keeps today's behaviour, which
 * is the honest one: fetching a picture from where it lives is better than
 * asking a host that has no route and watching every avatar 404.
 */
export const imageProxyEnabled = (): boolean =>
  import.meta.env?.VITE_IMAGE_PROXY === 'on';

/** The one route that answers a picture for this host (`server/img/proxy.mjs`). */
export const IMAGE_PROXY_PATH = '/api/img';

/** A picture URL as this host's own address, or the URL itself when it is not a candidate. */
export const proxiedExternalMediaUrl = (
  url: string,
  page: MediaPageLocation | undefined = typeof window === 'undefined'
    ? undefined
    : window.location,
  enabled: boolean = imageProxyEnabled(),
): string => {
  if (
    !enabled ||
    page?.protocol !== 'https:' ||
    typeof url !== 'string' ||
    url === ''
  ) {
    return secureExternalMediaUrl(url, page);
  }
  const secure = secureExternalMediaUrl(url, page);
  if (!/^https:\/\//i.test(secure) || secure.length > 1900) {
    // data:, blob:, relative paths and our own uploads stay exactly as they are.
    return secure;
  }
  try {
    const parsed = new URL(secure);
    if (
      parsed.hostname.toLowerCase() === page.hostname.toLowerCase() ||
      isLocalMediaHost(parsed.hostname) ||
      parsed.pathname === IMAGE_PROXY_PATH
    ) {
      return secure;
    }
  } catch {
    return secure;
  }
  return `${IMAGE_PROXY_PATH}?u=${encodeURIComponent(secure)}`;
};
