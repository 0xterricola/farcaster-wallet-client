/**
 * nodeApi — the signed-in client's reads, served by your own Snapchain node.
 *
 * The fork's client reads and writes Farcaster's hosted API, which a
 * third-party client can never hold a session for. This folder replaces the
 * *reads* behind that API with node reads, without touching the pages, the
 * hooks or the return shapes they already depend on:
 *
 *   hostedRoutes.ts   which request goes where, and why
 *   reads.ts          the node-backed readers (feed, profile, thread, …)
 *   fromNode.ts       node messages → the shapes the fork's components read
 *   nodeBackedFetch.ts  the `fetch` that ties the three together
 *   nodeWrites.ts     the node-backed writers (like, recast, follow, Cast)
 *   mediaUpload.ts    the media pipeline (bytes → our own host, not Warpcast's CDN)
 *   localDrafts.ts    cast drafts, which are this device's own state
 *
 * Writes are node-backed here too, now: a like, a recast, a follow and the
 * composer's Cast are built by `nodeWrites.ts`, signed on this device with the
 * account's own app key, submitted to a node (`submitMessage`) and read back out
 * of that node's state before the client is told they landed. The draft write in
 * front of every submit is answered locally (`localDrafts.ts`), and the one-time
 * step that gives this device a key is the Advanced screen's app-key flow
 * (`~/pages/settingsNode`).
 */

export * from './embedCards';
export * from './embedKinds';
export * from './fromNode';
export * from './hostedRoutes';
export * from './localDrafts';
export * from './mediaUpload';
export * from './nodeBackedClientFlag';
export * from './nodeBackedFetch';
export * from './nodeCannotAnswer';
export * from './nodeWrites';
export * from './reads';
