// @vitest-environment jsdom

import { Address, Hash } from 'viem';
import { base } from 'viem/chains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatWalletActivityAsset,
  mergeWalletActivity,
  parseWalletActivity,
  readLocalWalletActivity,
  recordPendingWalletActivity,
  settleLocalWalletActivity,
  WalletActivity,
} from '~/utils/walletActivity';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const other = '0x2222222222222222222222222222222222222222' as Address;
const token = '0x3333333333333333333333333333333333333333' as Address;
const sendHash = `0x${'a'.repeat(64)}` as Hash;
const receiveHash = `0x${'b'.repeat(64)}` as Hash;
const swapHash = `0x${'c'.repeat(64)}` as Hash;
const approvalHash = `0x${'d'.repeat(64)}` as Hash;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('wallet activity parsing', () => {
  it('groups Etherscan token legs into one swap and classifies native transfers', () => {
    const activity = parseWalletActivity(
      {
        source: 'etherscan',
        normalTransactions: [
          {
            hash: sendHash,
            timeStamp: '1700000000',
            from: wallet,
            to: other,
            value: '1000000000000000',
            isError: '0',
          },
          {
            hash: receiveHash,
            timeStamp: '1700000001',
            from: other,
            to: wallet,
            value: '2000000000000000',
            isError: '0',
          },
          {
            hash: swapHash,
            timeStamp: '1700000002',
            from: wallet,
            to: other,
            value: '0',
            isError: '0',
          },
        ],
        tokenTransfers: [
          {
            hash: swapHash,
            timeStamp: '1700000002',
            from: wallet,
            to: other,
            value: '1000000',
            tokenSymbol: 'USDC',
            tokenDecimal: '6',
            contractAddress: token,
          },
          {
            hash: swapHash,
            timeStamp: '1700000002',
            from: other,
            to: wallet,
            value: '500000000000000000',
            tokenSymbol: 'TOKEN',
            tokenDecimal: '18',
            contractAddress: token,
          },
        ],
      },
      wallet,
      base,
    );

    expect(activity.map((item) => item.type)).toEqual([
      'swap',
      'receive',
      'send',
    ]);
    expect(activity[0]).toMatchObject({
      hash: swapHash,
      fromAsset: { symbol: 'USDC', value: '1000000', decimals: 6 },
      toAsset: {
        symbol: 'TOKEN',
        value: '500000000000000000',
        decimals: 18,
      },
    });
  });

  it('classifies failed approvals and ignores malformed upstream rows', () => {
    const activity = parseWalletActivity(
      {
        source: 'etherscan',
        normalTransactions: [
          {
            hash: approvalHash,
            timeStamp: '1700000000',
            from: wallet,
            to: token,
            value: '0',
            functionName: 'approve(address spender, uint256 amount)',
            isError: '1',
          },
          { hash: 'bad', timeStamp: 'not-a-time' },
        ],
        tokenTransfers: [],
      },
      wallet,
      base,
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      type: 'approval',
      status: 'failed',
    });
  });

  it('recognizes a native-to-token swap as one activity', () => {
    const activity = parseWalletActivity(
      {
        source: 'etherscan',
        normalTransactions: [
          {
            hash: swapHash,
            timeStamp: '1700000002',
            from: wallet,
            to: other,
            value: '1000000000000000',
            isError: '0',
          },
        ],
        tokenTransfers: [
          {
            hash: swapHash,
            timeStamp: '1700000002',
            from: other,
            to: wallet,
            value: '2500000',
            tokenSymbol: 'USDC',
            tokenDecimal: '6',
            contractAddress: token,
          },
        ],
      },
      wallet,
      base,
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      type: 'swap',
      fromAsset: { symbol: 'ETH', value: '1000000000000000' },
      toAsset: { symbol: 'USDC', value: '2500000' },
    });
  });

  it('parses Blockscout token receipts', () => {
    const activity = parseWalletActivity(
      {
        source: 'blockscout',
        normalTransactions: [],
        tokenTransfers: [
          {
            transaction_hash: receiveHash,
            timestamp: '2026-09-01T12:00:00.000Z',
            from: { hash: other },
            to: { hash: wallet },
            total: { value: '2500000', decimals: '6' },
            token: { symbol: 'USDG', decimals: '6', address_hash: token },
          },
        ],
      },
      wallet,
      base,
    );
    expect(activity[0]).toMatchObject({
      type: 'receive',
      toAsset: { symbol: 'USDG', value: '2500000', decimals: 6 },
    });
  });
});

describe('local activity overlay', () => {
  it('records pending activity and settles it with a replacement hash', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    recordPendingWalletActivity({
      chainId: base.id,
      address: wallet,
      hash: sendHash,
      type: 'send',
      fromAsset: { symbol: 'ETH', value: '1', decimals: 18 },
    });
    expect(readLocalWalletActivity(wallet, base.id)[0]).toMatchObject({
      hash: sendHash,
      status: 'pending',
      local: true,
    });
    settleLocalWalletActivity(
      wallet,
      base.id,
      sendHash,
      'confirmed',
      receiveHash,
    );
    expect(readLocalWalletActivity(wallet, base.id)[0]).toMatchObject({
      hash: receiveHash,
      status: 'confirmed',
    });
  });

  it('keeps indexed truth when merging duplicate local records and limits rows', () => {
    const item = (
      hashCharacter: string,
      timestamp: number,
    ): WalletActivity => ({
      chainId: base.id,
      address: wallet,
      hash: `0x${hashCharacter.repeat(64)}` as Hash,
      type: 'send',
      status: 'pending',
      timestamp,
      local: true,
    });
    const local = item('a', 10);
    const indexed = { ...local, status: 'confirmed' as const, local: false };
    const merged = mergeWalletActivity(
      [indexed],
      [
        local,
        item('b', 9),
        item('c', 8),
        item('d', 7),
        item('e', 6),
        item('f', 5),
      ],
    );
    expect(merged).toHaveLength(5);
    expect(merged[0].status).toBe('confirmed');
  });

  it('formats exact integer asset quantities', () => {
    expect(
      formatWalletActivityAsset({
        symbol: 'USDC',
        value: '1250000',
        decimals: 6,
      }),
    ).toBe('1.25 USDC');
  });
});
