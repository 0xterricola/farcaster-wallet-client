import { AnalyticsEvent } from 'farcaster-analytics';
import * as React from 'react';

import { MiniAppParams, useLaunchMiniApp } from '~/contexts/MiniAppProvider';
import {
  WalletTradeIntent,
  WalletTradeIntentInput,
} from '~/utils/walletTradeIntent';

import { useAnalytics } from './AnalyticsProvider';
import { OpenableWarpcastWalletContext } from './OpenableWarpcastWalletContext';

type MinimizableWindowContextType = {
  setMiniAppLoadingMessage: (message: string | null) => void;
  miniAppLoadingMessage: string | null;
  miniAppMinimized: boolean;
  launchMiniApp: (params: MiniAppParams) => void;
  dismissMiniApp: () => void;
  minimizeMiniApp: () => void;
  maximizeMiniApp: () => void;
  walletTradeIntent: WalletTradeIntent | undefined;
  openWalletTradeIntent: (intent: WalletTradeIntentInput) => void;
  consumeWalletTradeIntent: (id: number) => void;
};

const MinimizableWindowContext = React.createContext<
  MinimizableWindowContextType | undefined
>(undefined);

type MinimizableWindowProviderProps = {
  children: React.ReactNode;
};

function MinimizableWindowProvider({
  children,
}: MinimizableWindowProviderProps) {
  const { trackEvent } = useAnalytics();
  const [isWarpcastWalletOpen, setIsWarpcastWalletOpen] = React.useState(false);
  const [walletTradeIntent, setWalletTradeIntent] = React.useState<
    WalletTradeIntent | undefined
  >();
  const walletTradeIntentId = React.useRef(0);

  const {
    launchMiniAppWithoutMinimizingWallet,
    dismiss: dismissMiniApp,
    minimize: minimizeMiniApp,
    maximizeMiniAppWithoutMinimizingWallet,
    minimized: miniAppMinimized,
  } = useLaunchMiniApp();

  const openWarpcastWallet = React.useCallback(() => {
    setIsWarpcastWalletOpen(true);
    minimizeMiniApp();
    trackEvent(AnalyticsEvent.ViewWallet, {});
  }, [minimizeMiniApp, trackEvent]);
  const closeWarpcastWallet = React.useCallback(() => {
    setIsWarpcastWalletOpen(false);
    trackEvent(AnalyticsEvent.CloseWallet, {});
  }, [trackEvent]);
  const openWalletTradeIntent = React.useCallback(
    (intent: WalletTradeIntentInput) => {
      walletTradeIntentId.current += 1;
      setWalletTradeIntent({ ...intent, id: walletTradeIntentId.current });
      openWarpcastWallet();
    },
    [openWarpcastWallet],
  );
  const consumeWalletTradeIntent = React.useCallback((id: number) => {
    setWalletTradeIntent((current) =>
      current?.id === id ? undefined : current,
    );
  }, []);

  const openMainWarpcastWallet = openWarpcastWallet;
  const [miniAppLoadingMessage, setMiniAppLoadingMessage] = React.useState<
    string | null
  >(null);
  const openableWarpcastWalletContext = React.useMemo(
    () => ({
      isWarpcastWalletOpen,
      openWarpcastWallet,
      closeWarpcastWallet,
      openMainWarpcastWallet,
    }),
    [
      isWarpcastWalletOpen,
      openWarpcastWallet,
      closeWarpcastWallet,
      openMainWarpcastWallet,
    ],
  );

  const launchMiniApp = React.useCallback(
    (params: MiniAppParams) => {
      launchMiniAppWithoutMinimizingWallet(params);
      setIsWarpcastWalletOpen(false);
    },
    [launchMiniAppWithoutMinimizingWallet],
  );

  const maximizeMiniApp = React.useCallback(() => {
    maximizeMiniAppWithoutMinimizingWallet();
    setIsWarpcastWalletOpen(false);
    setMiniAppLoadingMessage(null);
  }, [maximizeMiniAppWithoutMinimizingWallet]);

  const minimizableWindowContext = React.useMemo(
    () => ({
      miniAppMinimized,
      launchMiniApp,
      dismissMiniApp,
      minimizeMiniApp,
      maximizeMiniApp,
      miniAppLoadingMessage,
      setMiniAppLoadingMessage,
      walletTradeIntent,
      openWalletTradeIntent,
      consumeWalletTradeIntent,
    }),
    [
      miniAppMinimized,
      launchMiniApp,
      dismissMiniApp,
      minimizeMiniApp,
      maximizeMiniApp,
      miniAppLoadingMessage,
      walletTradeIntent,
      openWalletTradeIntent,
      consumeWalletTradeIntent,
      setMiniAppLoadingMessage,
    ],
  );

  return (
    <MinimizableWindowContext.Provider value={minimizableWindowContext}>
      <OpenableWarpcastWalletContext.Provider
        value={openableWarpcastWalletContext}
      >
        {children}
      </OpenableWarpcastWalletContext.Provider>
    </MinimizableWindowContext.Provider>
  );
}

function useMinimizableWindowContext() {
  const minimizableWindowContext = React.useContext(MinimizableWindowContext);
  if (!minimizableWindowContext) {
    throw new Error(
      'no MinimizableWindowContext in useMinimizableWindowContext',
    );
  }
  return minimizableWindowContext;
}

function useOptionalMinimizableWindowContext() {
  return React.useContext(MinimizableWindowContext);
}

export {
  MinimizableWindowProvider,
  useMinimizableWindowContext,
  useOptionalMinimizableWindowContext,
};
