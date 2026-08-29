const upstreamOrigin = 'https://farcaster.xyz';

const supportedMethods = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'PATCH',
  'POST',
  'PUT',
]);

const requestHeadersToRemove = [
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'connection',
  'cookie',
  'host',
  'origin',
  'referer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
];

const responseHeadersToRemove = [
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'set-cookie',
];

type PagesFunctionContext = {
  request: Request;
};

/**
 * Same-origin relay for Farcaster's fixed API host.
 *
 * Callers cannot choose the host or path prefix, so this is not a general
 * proxy. Authorization and Farcaster device headers pass through transiently;
 * cookies and forwarding metadata are removed and nothing is persisted.
 */
const onRequest = async ({
  request,
}: PagesFunctionContext): Promise<Response> => {
  if (!supportedMethods.has(request.method)) {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: [...supportedMethods].join(', ') },
    });
  }

  const incomingUrl = new URL(request.url);
  if (
    incomingUrl.pathname !== '/~api' &&
    !incomingUrl.pathname.startsWith('/~api/')
  ) {
    return new Response('Not found', { status: 404 });
  }

  const upstreamUrl = new URL(
    `${incomingUrl.pathname}${incomingUrl.search}`,
    upstreamOrigin,
  );
  const upstreamHeaders = new Headers(request.headers);
  for (const header of requestHeadersToRemove) {
    upstreamHeaders.delete(header);
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    body:
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : request.body,
    redirect: 'manual',
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const header of responseHeadersToRemove) {
    responseHeaders.delete(header);
  }
  responseHeaders.set('Cache-Control', 'no-store');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
};

export { onRequest };
