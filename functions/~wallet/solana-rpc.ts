const fallbackRpcUrl = 'https://api.mainnet-beta.solana.com';
const tokenProgramIds = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

type PagesFunctionContext = {
  request: Request;
  env: { SOLANA_RPC_URL?: string };
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validRequest(body: unknown): body is Record<string, unknown> {
  const request = record(body);
  if (!request || request.jsonrpc !== '2.0' || !Array.isArray(request.params)) {
    return false;
  }
  const [address, filter, config] = request.params;
  if (
    typeof address !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  ) {
    return false;
  }
  if (request.method === 'getBalance') {
    const options = record(filter);
    return (
      request.params.length === 2 && options?.commitment === 'confirmed'
    );
  }
  if (request.method === 'getTokenAccountsByOwner') {
    const ownerFilter = record(filter);
    const options = record(config);
    return (
      request.params.length === 3 &&
      typeof ownerFilter?.programId === 'string' &&
      tokenProgramIds.has(ownerFilter.programId) &&
      options?.commitment === 'confirmed' &&
      options.encoding === 'jsonParsed'
    );
  }
  return false;
}

const onRequest = async ({
  request,
  env,
}: PagesFunctionContext): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > 32_768) {
    return json({ error: 'Request is too large.' }, 413);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON-RPC request.' }, 400);
  }
  if (!validRequest(body)) {
    return json({ error: 'Unsupported Solana RPC request.' }, 400);
  }

  const configured = env.SOLANA_RPC_URL?.trim() || fallbackRpcUrl;
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(configured);
    if (rpcUrl.protocol !== 'https:') {
      throw new Error('HTTPS required');
    }
  } catch {
    return json({ error: 'Solana RPC is not configured correctly.' }, 503);
  }

  try {
    const upstream = await fetch(rpcUrl, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    if (!upstream.ok) {
      return json({ error: 'Solana RPC is temporarily unavailable.' }, 502);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  } catch {
    return json({ error: 'Solana RPC is temporarily unavailable.' }, 502);
  }
};

export { onRequest };
