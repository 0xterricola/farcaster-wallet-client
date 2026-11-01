/**
 * Shared test fixtures.
 *
 * Custody accounts come from a known BIP-39 test mnemonic: a real seed phrase,
 * derived in-process, used only to sign the gasless KEY_ADD authorization — the
 * same thing the browser does, minus the browser.
 */

import { mnemonicToAccount } from 'viem/accounts';

import {
  type FakeNode,
  type FakeNodeOptions,
  startFakeNode,
} from '../../test/fakeSnapchainNode';

export const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';

/** A different, equally public test mnemonic — the "not your custody key" case. */
export const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export const TEST_FID = 1234;

export const custodyAccount = () => mnemonicToAccount(TEST_MNEMONIC);
export const otherCustodyAccount = () => mnemonicToAccount(OTHER_MNEMONIC);

export interface TestNode extends FakeNode {
  account: ReturnType<typeof custodyAccount>;
}

/** A fake node wired to the test FID's custody address. */
export const startTestNode = async (
  options: FakeNodeOptions = {},
): Promise<TestNode> => {
  const account = custodyAccount();
  const node = await startFakeNode({
    ...options,
    custodyAddresses: {
      [TEST_FID]: account.address,
      ...(options.custodyAddresses ?? {}),
    },
  });
  return Object.assign(node, { account });
};

/** Deterministic 32-byte key material, so fixtures are reproducible. */
export const fixedRandomBytes =
  (fill: number) =>
  (length: number): Uint8Array =>
    new Uint8Array(length).fill(fill);
