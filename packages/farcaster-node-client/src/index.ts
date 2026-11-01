/**
 * farcaster-node-client — read and write Farcaster through *your own* Snapchain
 * read node.
 *
 * No Neynar, no Warpcast API, no Alchemy, no API keys: reads are the node's
 * `/v1/*` HTTP API, and writes are protobuf `submitMessage` calls the node
 * gossips to validators. App keys are issued gaslessly (`KEY_ADD`, EIP-712 from
 * the custody address, no Optimism transaction); the custody key only ever signs
 * that one authorization, in the browser.
 *
 * ```ts
 * const node = new SnapchainNodeClient({ baseUrl: 'http://127.0.0.1:3381' });
 * const appKey = await generateAppKey();
 * await issueAppKey({ node, fid, appKey, custodyAccount });
 * const cast = await buildCastAddMessage({ fid, signerPrivateKey: appKey.privateKey, text: 'hello' });
 * const accepted = await node.submitMessage(cast.bytes);
 * const merged = await node.confirmMessage({ fid, hash: accepted.hash });
 * ```
 */

export * from './appKey';
export * from './clientAttribution';
export * from './clientFilter';
export * from './errors';
export * from './feed';
export * from './http';
export * from './messages';
export * from './types';
export * from './wire';
