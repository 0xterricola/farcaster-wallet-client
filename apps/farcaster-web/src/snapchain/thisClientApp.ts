/**
 * This client's own app FID — the app key Fiddy asks for, and why the app is
 * named rather than guessed.
 *
 * Every Farcaster key records the app FID that requested it (`SignedKeyRequest`
 * metadata, see `farcaster-node-client`'s `clientAttribution`). A cast signed
 * through fiddy.fun carries the FID below, so the honest label for it is the
 * name of the thing doing the asking: this client.
 *
 * The number is not invented here: it is `FIDDY_CONNECT_APP_FID` on the
 * fiddy-auth control plane (the app that mints the connection signer), and it is
 * the FID whose own protocol profile reads `@fiddy-one` / `fiddy one 🐣`
 * (verified against a live node, 2026-10-24). This client calls it "Fiddy"
 * because it is Fiddy; naming it from its own profile would render a cast made
 * here as "via fiddy one 🐣".
 *
 * The app's own key is checked before anything else, so a cast made through
 * fiddy.fun says "via Fiddy" and not "via app 3356372".
 */
export const THIS_CLIENT_APP_FID = 3356372;

/** What this client's own app key reads as, on a cast. */
export const THIS_CLIENT_APP_LABEL = 'Fiddy';
