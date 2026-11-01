/**
 * Mounts the instance's own connect service on the server that serves this copy
 * of Fiddy.
 *
 * WHY HERE AND NOT IN A SEPARATE PROCESS
 *
 * `fiddy client up` serves the client with the app's own vite server, so that
 * server is the only thing at the instance's address. The browser's connect
 * calls are same-origin and cookie-bound (`~/snapchain/accounts/managedConnect`
 * sends them with `credentials: 'same-origin'`), which means the service that
 * answers them has to be the same origin — a second process on another port
 * would be a cross-origin service with no CORS grant, i.e. a dead end that
 * looks like a bug.
 *
 * It is mounted for BOTH ways a person runs the client: `dev` (the default) and
 * `preview` (`fiddy client up --build`). A client served as static files by
 * something else (nginx, a CDN) has no service at that address, and the screens
 * already handle that: they name what is missing and walk the reader to the key
 * path in Advanced (card t_b4f0752a).
 *
 * The service itself is inert without an app account configured, and says so
 * plainly — see `./connect.mjs` for the whole contract.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The one endpoint this plugin owns.
 *
 * There is no `/write` here on purpose: the key this service mints is handed to
 * the browser, which signs its own writes through the node it is already
 * pointed at (`~/snapchain/nodeApi/nodeWrites`), so a second copy of the
 * protocol would be a second thing to get wrong.
 */
const CONNECT_PATH = '/api/fiddy/connect';

/** A write body is a cast, a reaction or a follow. Anything bigger is not one. */
const MAX_BODY_BYTES = 128 * 1024;

/** The caller's handle lives in a cookie no script can read, as on fiddy.fun. */
const COOKIE_NAME = 'fiddy_instance_connect';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const readCookie = (headerValue, name) => {
  if (typeof headerValue !== 'string') {
    return undefined;
  }
  for (const part of headerValue.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
};

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    request.on('error', reject);
  });

const sendJson = (response, status, body, setCookie) => {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  if (setCookie) {
    response.setHeader('set-cookie', setCookie);
  }
  response.end(payload);
};

/**
 * Where the records live. Outside the repo on purpose: this is a secret this
 * machine holds, not a file a checkout should ever contain.
 */
const stateFilePath = (env) =>
  join(
    env.FIDDY_INSTANCE_STATE_DIR ?? join(homedir(), '.fiddy-instance'),
    'connect.json',
  );

export const createInstanceConnectMiddleware = async ({
  env = process.env,
  log = (message) => console.log(`[fiddy connect] ${message}`),
} = {}) => {
  const { createFileStore, createInstanceConnectService, readInstanceConfig } =
    await import('./connect.mjs');

  const service = createInstanceConnectService({
    config: readInstanceConfig(env),
    store: createFileStore(stateFilePath(env)),
    log,
  });

  return async (request, response, next) => {
    const url = request.url ?? '';
    const [pathname] = url.split('?');
    if (pathname !== CONNECT_PATH) {
      next();
      return;
    }

    const handle = readCookie(request.headers?.cookie, COOKIE_NAME);
    const remember = (answered) =>
      answered?.handle
        ? `${COOKIE_NAME}=${encodeURIComponent(answered.handle)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
        : undefined;

    try {
      if (request.method === 'GET') {
        const answered = await service.read({ handle });
        sendJson(response, answered.status, answered.body);
        return;
      }

      if (request.method === 'DELETE') {
        const answered = await service.remove({ handle });
        sendJson(response, answered.status, answered.body);
        return;
      }

      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        const answered = await service.begin({
          handle,
          attempt: body?.attempt,
          forFid: body?.forFid,
          proof: body?.proof,
          host: request.headers?.host,
        });
        sendJson(response, answered.status, answered.body, remember(answered));
        return;
      }

      sendJson(response, 405, {
        code: 'CONNECT_METHOD',
        message: `${request.method} is not a method here.`,
      });
    } catch (error) {
      log(`refused a request: ${error?.message ?? error}`);
      sendJson(response, 400, {
        code: 'CONNECT_BAD_REQUEST',
        message: 'That request could not be read.',
      });
    }
  };
};

/**
 * The vite plugin. `configureServer` is the dev server; `configurePreviewServer`
 * is `vite preview`, which is what `fiddy client up --build` runs.
 */
export const instanceConnectPlugin = ({ env = process.env } = {}) => ({
  name: 'fiddy-instance-connect',
  async configureServer(server) {
    server.middlewares.use(await createInstanceConnectMiddleware({ env }));
  },
  async configurePreviewServer(server) {
    server.middlewares.use(await createInstanceConnectMiddleware({ env }));
  },
});

export { CONNECT_PATH };