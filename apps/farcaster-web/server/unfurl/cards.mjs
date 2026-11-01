/**
 * The 1200x630 picture a cast or profile page unfurls with.
 *
 * Drawn by `render-card.py` (Pillow), the same way the site card is drawn by
 * `scripts/render-share-card.mjs` (Playwright) — because that is what each
 * machine has. See that file's header for why the two are not the same tool.
 *
 * Two rules are enforced HERE rather than hoped for:
 *
 *   * the picture is a PNG of exactly 1200x630 (read out of its own IHDR, not
 *     off the end of a log line), because that is what the tags promise a
 *     platform and what a platform lays its preview out with;
 *   * a card that could not be drawn is a `throw`, never a blank image. The
 *     caller answers with the site card instead — a real picture, the same one
 *     the front door uses — rather than a broken one.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const MINI_APP_CARD_HEIGHT = 800;

/** PNG magic, IHDR width/height, and nothing else assumed about the bytes. */
export const pngSize = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return undefined;
  }
  const signature = buffer.subarray(0, 8).toString('hex');
  if (
    signature !== '89504e470d0a1a0a' ||
    buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return undefined;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

/**
 * One card, drawn on demand.
 *
 * `spawn` and the paths are injectable so a test can prove the contract without
 * Pillow, and `FIDDY_MASCOT_PATH` is passed rather than baked because the
 * mascot lives in the release's own web root — the same still the chrome paints
 * before the GLB arrives.
 */
export const createCardRenderer = ({
  pythonPath = 'python3',
  scriptPath,
  mascotPath,
  spawn = nodeSpawn,
  timeoutMs = 20_000,
}) => ({
  render: (payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(pythonPath, [scriptPath], {
        env: {
          ...process.env,
          FIDDY_MASCOT_PATH: mascotPath,
          PYTHONDONTWRITEBYTECODE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks = [];
      let stderr = '';
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        fail(
          new Error(`the card renderer did not finish within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(deadline);
        fail(error);
      });
      child.on('close', (code) => {
        clearTimeout(deadline);
        if (settled) {
          return;
        }
        if (code !== 0) {
          fail(
            new Error(
              `the card renderer exited ${code}: ${stderr.trim().slice(0, 400)}`,
            ),
          );
          return;
        }
        const png = Buffer.concat(chunks);
        const size = pngSize(png);
        const expectedHeight =
          payload?.aspect === '3x2' ? MINI_APP_CARD_HEIGHT : CARD_HEIGHT;
        if (
          !size ||
          size.width !== CARD_WIDTH ||
          size.height !== expectedHeight
        ) {
          fail(
            new Error(
              `the card renderer answered ${size ? `${size.width}x${size.height}` : 'not a PNG'}`,
            ),
          );
          return;
        }
        settled = true;
        resolve(png);
      });
      child.stdin.on('error', () => {
        // The child may exit before the payload is written; `close` reports it.
      });
      child.stdin.end(JSON.stringify(payload));
    }),
});
