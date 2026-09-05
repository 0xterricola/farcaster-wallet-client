import {
  createSolanaWalletProvider,
  SolanaCombinedTransaction,
  SolanaConnectRequestArguments,
  SolanaRequestFn,
  SolanaSignAndSendTransactionRequestArguments,
  SolanaSignMessageRequestArguments,
  SolanaSignTransactionRequestArguments,
  SolanaWalletProvider,
} from '@farcaster/miniapp-core';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useSolanaWallet } from '~/contexts/SolanaWalletProvider';
import { useWallet } from '~/contexts/WalletProvider';
import { submitSignedSolanaTransaction } from '~/utils/solanaTransfer';

type PendingConnect = {
  reject: (error: Error) => void;
  resolve: (result: { publicKey: string }) => void;
};

type SolanaRequestArguments =
  | SolanaConnectRequestArguments
  | SolanaSignAndSendTransactionRequestArguments
  | SolanaSignMessageRequestArguments
  | SolanaSignTransactionRequestArguments<SolanaCombinedTransaction>;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function serializeUnsignedTransaction(
  transaction: SolanaCombinedTransaction,
): Uint8Array {
  if (transaction instanceof VersionedTransaction) {
    return transaction.serialize();
  }
  return new Uint8Array(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
}

function deserializeSignedTransaction<T extends SolanaCombinedTransaction>(
  signed: Uint8Array,
  original: T,
): T {
  return (
    original instanceof VersionedTransaction
      ? VersionedTransaction.deserialize(signed)
      : Transaction.from(signed)
  ) as T;
}

/**
 * Adapts the dashboard's external Solana connection to the Mini App provider
 * interface. The adapter never owns keys: every signature is still produced
 * by the selected Wallet Standard or WalletConnect wallet.
 */
export function useSolanaMiniAppProvider(): SolanaWalletProvider {
  const {
    address,
    signMessage: signExternalMessage,
    signTransaction: signExternalTransaction,
  } = useSolanaWallet();
  const { closeConnectModal, isConnectModalOpen, openConnectModal } =
    useWallet();
  const addressRef = useRef(address);
  const pendingConnectsRef = useRef<PendingConnect[]>([]);
  const openedForPendingConnectRef = useRef(false);
  addressRef.current = address;

  useEffect(() => {
    if (!address || pendingConnectsRef.current.length === 0) {
      return;
    }
    const pending = pendingConnectsRef.current.splice(0);
    for (const request of pending) {
      request.resolve({ publicKey: address });
    }
    openedForPendingConnectRef.current = false;
    closeConnectModal();
  }, [address, closeConnectModal]);

  useEffect(() => {
    if (pendingConnectsRef.current.length === 0) {
      return;
    }
    if (isConnectModalOpen) {
      openedForPendingConnectRef.current = true;
      return;
    }
    if (!openedForPendingConnectRef.current || addressRef.current) {
      return;
    }
    const pending = pendingConnectsRef.current.splice(0);
    for (const request of pending) {
      request.reject(new Error('Solana wallet connection cancelled.'));
    }
    openedForPendingConnectRef.current = false;
  }, [isConnectModalOpen]);

  useEffect(
    () => () => {
      const pending = pendingConnectsRef.current.splice(0);
      for (const request of pending) {
        request.reject(new Error('Mini App closed before wallet connection.'));
      }
    },
    [],
  );

  const connect = useCallback(async (): Promise<{ publicKey: string }> => {
    if (addressRef.current) {
      return { publicKey: addressRef.current };
    }
    return new Promise((resolve, reject) => {
      pendingConnectsRef.current.push({ reject, resolve });
      if (isConnectModalOpen) {
        openedForPendingConnectRef.current = true;
      }
      openConnectModal('solana');
    });
  }, [isConnectModalOpen, openConnectModal]);

  const signTransaction = useCallback(
    async <T extends SolanaCombinedTransaction>(transaction: T) => {
      const signed = await signExternalTransaction(
        serializeUnsignedTransaction(transaction),
      );
      return {
        signedTransaction: deserializeSignedTransaction(signed, transaction),
      };
    },
    [signExternalTransaction],
  );

  const request = useCallback(
    (async (requestArguments: SolanaRequestArguments) => {
      switch (requestArguments.method) {
        case 'connect':
          return connect();
        case 'signMessage': {
          const signature = await signExternalMessage(
            decodeBase64(requestArguments.params.message),
          );
          return { signature: encodeBase64(signature) };
        }
        case 'signTransaction':
          return signTransaction(requestArguments.params.transaction);
        case 'signAndSendTransaction': {
          const { signedTransaction } = await signTransaction(
            requestArguments.params.transaction,
          );
          const signature = await submitSignedSolanaTransaction(
            serializeUnsignedTransaction(signedTransaction),
          );
          return { signature };
        }
      }
    }) as SolanaRequestFn,
    [connect, signExternalMessage, signTransaction],
  );

  return useMemo(() => createSolanaWalletProvider(request), [request]);
}
