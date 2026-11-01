import * as SplashScreen from 'expo-splash-screen';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { NodeStatusPill } from '~/components/NodeStatusPill';
import { TabBar, type TabKey } from '~/components/TabBar';
import { runSelfTest } from '~/dev/selfTest';
import { NodeContext, useNodeSessionState } from '~/node/nodeSession';
import { AgentScreen } from '~/screens/AgentScreen';
import { FeedScreen } from '~/screens/FeedScreen';
import { colors, spacing } from '~/theme';

void SplashScreen.preventAutoHideAsync();

/** Fiddy: your node, your network, your agent. Two tabs, one node session. */
const Shell = () => {
  const session = useNodeSessionState();
  const [tab, setTab] = useState<TabKey>('feed');
  const [ready, setReady] = useState(false);

  const onLayout = useCallback(() => {
    if (!ready) {
      setReady(true);
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  useEffect(() => {
    // Never leave the splash up waiting for a layout that never comes.
    const timer = setTimeout(() => {
      setReady(true);
      void SplashScreen.hideAsync();
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!__DEV__) {
      return;
    }
    // Dev builds print the on-device checks to the Metro console on startup, so
    // "does this actually run on Hermes?" is answered in the log of every dev
    // launch instead of only when someone remembers to open the node sheet.
    void (async () => {
      const results = await runSelfTest(session.client, session.fid);
      for (const check of results) {
        // eslint-disable-next-line no-console
        console.log(
          `[fiddy self-test] ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`,
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.client, session.fid]);

  return (
    <NodeContext.Provider value={session}>
      <View style={styles.root} onLayout={onLayout}>
        <LinearGradient
          colors={[colors.bgLift, colors.bg, colors.bg]}
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <View style={styles.header}>
            <View style={styles.brand}>
              <View style={styles.brandDot} />
              <Text style={styles.brandText}>Fiddy</Text>
            </View>
            <NodeStatusPill />
          </View>
          <TabBar active={tab} onChange={setTab} />
          <View style={styles.body}>
            {tab === 'feed' ? <FeedScreen /> : <AgentScreen />}
          </View>
        </SafeAreaView>
      </View>
    </NodeContext.Provider>
  );
};

// eslint-disable-next-line import/no-default-export
export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  safe: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: Platform.OS === 'android' ? spacing.md : 4,
    paddingBottom: spacing.md,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  brandText: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  body: {
    flex: 1,
  },
});