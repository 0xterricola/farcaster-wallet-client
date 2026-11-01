/**
 * providers — where this client reads from, and what happens when that stops
 * working well.
 *
 * The reader may keep several servers on their list, in the order they want them
 * tried. This folder measures each one, decides which is live, and points the
 * client's single fetch seam at it:
 *
 *   catalog.ts        the known providers, and the order rules
 *   capabilities.ts   what each one can actually do — reads, writes, both
 *   preferences.ts    the reader's order, stored per FID
 *   health.ts         the measurements (speed + is it following the network)
 *   failover.ts       which one is live, and why — pure, so it is testable
 *   runtime.ts        the loop that watches, and the live snapshot everything reads
 *   providerFetch.ts  the fetch the client is handed, now provider-aware
 *   neynarMap.ts      Neynar's JSON → the hosted shapes the pages already read
 *
 * Writes go through here too, now. A write is signed on this device with the
 * account's own app key and handed to the preferred server (`nodeWrites`); the
 * capability matrix above decides whether that server can carry it at all, and a
 * write that cannot be carried is refused by name rather than moved to another
 * machine behind the reader's back.
 */

export * from './capabilities';
export * from './catalog';
export * from './failover';
export * from './health';
export * from './neynarMap';
export * from './pill';
export * from './preferences';
export * from './providerFetch';
export * from './providerTypes';
export * from './runtime';
export * from './useProviders';
