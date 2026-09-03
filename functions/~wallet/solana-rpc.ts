const fallbackRpcUrl = 'https://api.mainnet-beta.solana.com';
const tokenProgramIds = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
// The client only ever needs a short, bounded recent-activity list (mirrors
// the EVM wallet's "five most recent transactions" behavior) — there is no
// pagination to support, so this stays small on purpose.
const MAX_SIGNATURES_LIMIT = 5;

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
  const confirmed = (value: unknown) =>
    record(value)?.commitment === 'confirmed';
  const base58 = (value: unknown) =>
    typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value);
  const base64 = (value: unknown, maximum = 4_000) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value);

  if (request.method === 'getLatestBlockhash') {
    return request.params.length === 1 && confirmed(address);
  }
  if (request.method === 'getFeeForMessage') {
    return request.params.length === 2 && base64(address) && confirmed(filter);
  }
  if (request.method === 'getAccountInfo') {
    const options = record(filter);
    return (
      request.params.length === 2 &&
      base58(address) &&
      options?.commitment === 'confirmed' &&
      options.encoding === 'base64'
    );
  }
  if (request.method === 'getMinimumBalanceForRentExemption') {
    return (
      request.params.length === 2 &&
      (address === 0 || address === 165) &&
      confirmed(filter)
    );
  }
  if (request.method === 'sendTransaction') {
    const options = record(filter);
    return (
      request.params.length === 2 &&
      base64(address, 3_000) &&
      options?.encoding === 'base64' &&
      options.maxRetries === 3 &&
      options.preflightCommitment === 'confirmed' &&
      options.skipPreflight === false
    );
  }
  if (request.method === 'simulateTransaction') {
    const options = record(filter);
    return (
      request.params.length === 2 &&
      base64(address, 3_000) &&
      options?.commitment === 'confirmed' &&
      options.encoding === 'base64' &&
      options.replaceRecentBlockhash === true &&
      options.sigVerify === false
    );
  }
  if (request.method === 'getSignatureStatuses') {
    const signatures = address;
    const options = record(filter);
    return (
      request.params.length === 2 &&
      Array.isArray(signatures) &&
      signatures.length === 1 &&
      base58(signatures[0]) &&
      options?.searchTransactionHistory === true
    );
  }
  if (request.method === 'getTransaction') {
    const options = record(filter);
    return (
      request.params.length === 2 &&
      base58(address) &&
      options?.commitment === 'confirmed' &&
      options.encoding === 'jsonParsed' &&
      options.maxSupportedTransactionVersion === 0
    );
  }
  if (
    typeof address !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  ) {
    return false;
  }
  if (request.method === 'getBalance') {
    const options = record(filter);
    return request.params.length === 2 && options?.commitment === 'confirmed';
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
  if (request.method === 'getSignaturesForAddress') {
    const options = record(filter);
    const limit = options?.limit;
    return (
      request.params.length === 2 &&
      typeof limit === 'number' &&
      Number.isInteger(limit) &&
      limit > 0 &&
      limit <= MAX_SIGNATURES_LIMIT &&
      options?.commitment === 'confirmed' &&
      // No pagination cursor is supported — reject it rather than silently
      // ignoring it.
      options?.before === undefined
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
