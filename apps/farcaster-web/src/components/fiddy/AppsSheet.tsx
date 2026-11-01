/**
 * "Connect apps" — one row per channel, one big switch, one plain permission.
 *
 * The promise the whole product rests on is on every row: Fiddy asks you before
 * it posts or replies. So the permission line says what Fiddy may do, not what
 * it technically can.
 *
 * Channels Fiddy cannot reach yet are listed with an honest "soon" tag and a
 * switch that is visibly off and cannot be flipped. A dead switch that looks
 * alive is worse than no switch, and a channel silently left out of the list
 * looks like a bug.
 *
 * Farcaster is the one channel that works today: it is the app you are in. Its
 * switch is a real permission toggle, stored on this device.
 */

import React, { memo } from 'react';

import {
  type ChannelId,
  saveFiddySetup,
  useFiddySetup,
} from '~/lib/fiddySetup';

interface ChannelRow {
  id: ChannelId;
  name: string;
  /** Written as the promise, not the capability. */
  permission: string;
  wired: boolean;
}

export const CHANNEL_ROWS: ChannelRow[] = [
  {
    id: 'farcaster',
    name: 'Farcaster',
    permission: 'Can read your feed and post as you — always asks you first.',
    wired: true,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    permission: 'Can read and reply to your chats — always asks you first.',
    wired: false,
  },
  {
    id: 'discord',
    name: 'Discord',
    permission: 'Can read and answer your mentions — always asks you first.',
    wired: false,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    permission: 'Can read and reply to your chats — always asks you first.',
    wired: false,
  },
  {
    id: 'imessage',
    name: 'iMessage',
    permission: 'Can read and reply to your threads — always asks you first.',
    wired: false,
  },
  {
    id: 'email',
    name: 'Email',
    permission:
      'Can read your inbox and draft replies — never sends without you.',
    wired: false,
  },
];

export const AppsSheet = memo(() => {
  const setup = useFiddySetup();

  return (
    <div className="fiddy-apps" data-fiddy="apps">
      <ul className="fiddy-channel-list">
        {CHANNEL_ROWS.map((row) => {
          const on = setup.channels[row.id] === true;
          return (
            <li
              key={row.id}
              className="fiddy-channel-row"
              data-fiddy-row={row.id}
              data-on={on ? 'true' : 'false'}
            >
              <div className="fiddy-channel-copy">
                <p className="fiddy-channel-name">
                  {row.name}
                  {row.wired ? null : (
                    <span className="fiddy-soon" data-fiddy-tag="soon">
                      soon
                    </span>
                  )}
                </p>
                <p className="fiddy-channel-permission">{row.permission}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-disabled={row.wired ? undefined : 'true'}
                aria-label={`${row.name} — ${
                  row.wired ? 'let Fiddy use it' : 'not available yet'
                }`}
                className={`fiddy-switch${on ? ' fiddy-switch-on' : ''}`}
                disabled={!row.wired}
                onClick={() =>
                  saveFiddySetup({
                    channels: { ...setup.channels, [row.id]: !on },
                  })
                }
              >
                <span className="fiddy-switch-knob" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      <p className="fiddy-honest-note fiddy-apps-note">
        <span>
          What you turn on is saved on this device. A channel only starts
          working once your agent is running it, and Fiddy still asks you before
          anything goes out.
        </span>
      </p>
    </div>
  );
});

AppsSheet.displayName = 'AppsSheet';
