import { Provider } from 'ox';
import { Address, toHex } from 'viem';
import { base } from 'viem/chains';

// Only dashboard sends use this guard. Miniapps keep their existing provider
// and may request other networks without the dashboard switching them back.
export async function sendBaseNativeToken({
  provider,
  address,
  recipient,
  value,
}: {
  provider: Pick<Provider.Provider, 'request'>;
  address: Address;
  recipient: Address;
  value: bigint;
}) {
  await ensureBaseWalletAccount(provider, address);
  return provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: address,
        to: recipient,
        value: toHex(value),
        chainId: toHex(base.id),
      },
    ],
  });
}

export async function ensureBaseWalletAccount(
  provider: Pick<Provider.Provider, 'request'>,
  address: Address,
  allowSwitch = true,
) {
  const chainId = toHex(base.id);
  const currentChainId = await provider.request({ method: 'eth_chainId' });
  if (Number(currentChainId) !== base.id && allowSwitch) {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId }],
    });
  }

  // A switch prompt can stay open while the user changes accounts. Require
  // the account that was used to prepare the send, rather than substituting it.
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (accounts[0]?.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Wallet account changed. Review the send again.');
  }
  const verifiedChainId = await provider.request({ method: 'eth_chainId' });
  if (Number(verifiedChainId) !== base.id) {
    throw new Error('Wallet is not on Base. No transaction was submitted.');
  }
}
