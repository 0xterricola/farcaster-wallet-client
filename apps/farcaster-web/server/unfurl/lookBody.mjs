/**
 * The one request body this service reads: a look, and only up to a cap.
 *
 * A look share is the only request that carries a body here (`POST /look`), and
 * the cap is the model's own (`LOOK_LIMITS.bytes` in `looks.mjs`). The rule this
 * file exists for is what happens when a body runs PAST the cap.
 *
 * IT IS READ AND DROPPED, NEVER DESTROYED. The first shape of this code rejected
 * the promise and called `request.destroy()` the moment the cap was crossed,
 * which closed the socket before any answer was written. nginx logged it as
 * "upstream prematurely closed connection while reading response header", took
 * the 502, and its `error_page 502 = @fiddy_shell` tried to answer a POST with
 * a static document — which nginx refuses with `405 Not Allowed` and an HTML
 * error page. MEASURED 2026-10-23 on fiddy.fun, card t_d85d8520: a 4 KB to 8 KB
 * share body answered `405` from nginx; the service's own log for the same
 * request said `400` because the whitespace placeholder it was handed then read
 * as an EMPTY body. A refusal has to reach the person, so:
 *
 *   * the socket stays open, and the rest of a too-large body is counted and
 *     dropped instead of kept (nginx caps a share body at 8 KB, so this is
 *     bounded work);
 *   * what the promise resolves with is the FIRST `limit + 1` bytes the request
 *     actually sent — one byte more than a look may be, which is exactly the
 *     input the model's own size check refuses. The sentence a person reads is
 *     the model's ("That look is too big to share."), not a second one invented
 *     at the socket.
 *
 * `readLookBody` is exported so the contract can be held without a real socket
 * (see `src/__tests__/lookService.test.ts`): the regression above was invisible
 * to every test that handed the handler a string, because nothing there ever
 * destroyed a request.
 */

/** The path whose POST carries a look. */
export const LOOK_SHARE_PATH = '/look';

/**
 * The paths whose POST carries a JSON body this service reads.
 *
 * A look share (`POST /look`), and the translation routes
 * (`server/translate/`): an ask names a cast and a language, a lookup names up
 * to fifty hashes. Each is read through the same capped reader below, with the
 * cap its own model sets — never an unbounded read of whatever a caller sent.
 */
export const JSON_BODY_PATHS = [LOOK_SHARE_PATH, '/api/translate', '/api/translations'];

/** Is this request one of the POSTs that carries a body worth reading? */
export const carriesApiBody = (method, path) =>
  method === 'POST' && JSON_BODY_PATHS.includes((path ?? '').split('?')[0]);

/** Is this request the one that carries a body worth reading? */
export const carriesLookBody = (method, path) =>
  method === 'POST' && (path ?? '').split('?')[0] === LOOK_SHARE_PATH;

/**
 * A request body, read up to `limit + 1` bytes and no further.
 *
 * Resolves — never rejects — with a string: a body inside the cap byte for byte,
 * and a body past it cut to the first byte over the cap. A request that errors
 * mid-body resolves with what was read, because the only thing that can be done
 * with a broken request is answer it (a rejected promise here would be an
 * unhandled refusal, which is the bug this file documents).
 */
export const readLookBody = (request, limit) =>
  new Promise((resolve) => {
    const keep = limit + 1;
    const chunks = [];
    let kept = 0;
    let failed = false;

    const settle = () =>
      resolve(kept ? Buffer.concat(chunks).toString('utf8') : '');

    request.on('data', (chunk) => {
      if (failed || kept >= keep) {
        // Past the cap: the bytes are no longer what decides the answer, and
        // the rest of the body is read only so the response has somewhere to go.
        return;
      }
      const room = keep - kept;
      chunks.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
      kept += Math.min(room, chunk.length);
    });
    // `end` and `error` both settle: a request this service cannot read to the
    // end is still a request the model can refuse in one sentence.
    request.on('end', settle);
    request.on('error', () => {
      failed = true;
      settle();
    });
  });