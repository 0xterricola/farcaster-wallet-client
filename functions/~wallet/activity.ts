const etherscanChainIds = new Set([1, 56, 143, 8453, 999, 42161, 42220]);
const robinhoodChainId = 4663;
const robinhoodExplorerOrigin = 'https://robinhoodchain.blockscout.com';

type PagesFunctionContext = {
  request: Request;
  env: { ETHERSCAN_API_KEY?: string };
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

async function blockscoutActivity(address: string) {
  const endpoint = (path: string) =>
    new URL(`/api/v2/addresses/${address}/${path}`, robinhoodExplorerOrigin);
  const [normal, tokens] = await Promise.all([
    fetchJson(endpoint('transactions')),
    fetchJson(endpoint('token-transfers?type=ERC-20')),
  ]);
  const rows = (payload: unknown) => {
    const items =
      payload && typeof payload === 'object'
        ? (payload as { items?: unknown }).items
        : undefined;
    if (!Array.isArray(items)) {
      throw new Error('History provider returned invalid data.');
    }
    return items.slice(0, 20);
  };
  return {
    source: 'blockscout',
    normalTransactions: rows(normal),
    tokenTransfers: rows(tokens),
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
  if (!etherscanChainIds.has(chainId) && chainId !== robinhoodChainId) {
    return json({ error: 'Unsupported wallet network.' }, 400);
  }
  try {
    if (chainId === robinhoodChainId) {
      return json(await blockscoutActivity(address));
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
