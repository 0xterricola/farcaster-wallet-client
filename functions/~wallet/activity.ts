const etherscanChainIds = new Set([1, 143, 999, 42161]);
const alchemyOrigins = new Map([
  [56, 'https://bnb-mainnet.g.alchemy.com'],
  [4663, 'https://robinhood-mainnet.g.alchemy.com'],
  [8453, 'https://base-mainnet.g.alchemy.com'],
  [42220, 'https://celo-mainnet.g.alchemy.com'],
]);

type PagesFunctionContext = {
  request: Request;
  env: { ALCHEMY_API_KEY?: string; ETHERSCAN_API_KEY?: string };
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

async function fetchJson(url: URL) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`History provider returned ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
}

function etherscanRows(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('History provider returned invalid data.');
  }
  const result = (payload as { result?: unknown }).result;
  if (Array.isArray(result)) return result;
  const message = (payload as { message?: unknown }).message;
  if (
    typeof result === 'string' &&
    typeof message === 'string' &&
    /no transactions found/i.test(`${message} ${result}`)
  ) {
    return [];
  }
  throw new Error('History provider rejected the request.');
}

async function etherscanActivity(
  address: string,
  chainId: number,
  apiKey: string,
) {
  const request = (action: 'txlist' | 'tokentx') => {
    const url = new URL('https://api.etherscan.io/v2/api');
    url.search = new URLSearchParams({
      chainid: String(chainId),
      module: 'account',
      action,
      address,
      startblock: '0',
      endblock: '999999999',
      page: '1',
      offset: '20',
      sort: 'desc',
      apikey: apiKey,
    }).toString();
    return fetchJson(url);
  };
  const [normal, tokens] = await Promise.all([
    request('txlist'),
    request('tokentx'),
  ]);
  return {
    source: 'etherscan',
    normalTransactions: etherscanRows(normal),
    tokenTransfers: etherscanRows(tokens),
  };
}

function alchemyRows(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('History provider returned invalid data.');
  }
  const result = (payload as { result?: unknown }).result;
  const transfers =
    result && typeof result === 'object'
      ? (result as { transfers?: unknown }).transfers
      : undefined;
  if (!Array.isArray(transfers)) {
    throw new Error('History provider rejected the request.');
  }
  return transfers;
}

async function alchemyActivity(
  address: string,
  origin: string,
  apiKey: string,
) {
  const endpoint = new URL(`/v2/${encodeURIComponent(apiKey)}`, origin);
  const request = (direction: 'fromAddress' | 'toAddress') =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: direction,
        method: 'alchemy_getAssetTransfers',
        params: [
          {
            fromBlock: '0x0',
            toBlock: 'latest',
            [direction]: address,
            category: ['external', 'erc20'],
            withMetadata: true,
            excludeZeroValue: false,
            maxCount: '0x14',
            order: 'desc',
          },
        ],
      }),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`History provider returned ${response.status}.`);
      }
      return response.json() as Promise<unknown>;
    });
  const [outgoing, incoming] = await Promise.all([
    request('fromAddress'),
    request('toAddress'),
  ]);
  return {
    source: 'alchemy',
    outgoingTransfers: alchemyRows(outgoing),
    incomingTransfers: alchemyRows(incoming),
  };
}

const onRequest = async ({
  request,
  env,
}: PagesFunctionContext): Promise<Response> => {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET' },
    });
  }
  const url = new URL(request.url);
  const address = url.searchParams.get('address') ?? '';
  const chainId = Number(url.searchParams.get('chainId'));
  if (!/^0x[\da-f]{40}$/i.test(address)) {
    return json({ error: 'Invalid wallet address.' }, 400);
  }
  const alchemyOrigin = alchemyOrigins.get(chainId);
  if (!etherscanChainIds.has(chainId) && !alchemyOrigin) {
    return json({ error: 'Unsupported wallet network.' }, 400);
  }
  try {
    if (alchemyOrigin) {
      const apiKey = env.ALCHEMY_API_KEY?.trim();
      if (!apiKey) {
        return json({ error: 'Wallet history is not configured.' }, 503);
      }
      return json(await alchemyActivity(address, alchemyOrigin, apiKey));
    }
    const apiKey = env.ETHERSCAN_API_KEY?.trim();
    if (!apiKey) {
      return json({ error: 'Wallet history is not configured.' }, 503);
    }
    return json(await etherscanActivity(address, chainId, apiKey));
  } catch {
    return json({ error: 'Wallet history is temporarily unavailable.' }, 502);
  }
};

export { onRequest };
