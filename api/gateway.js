/**
 * Every /api/* route, as one Vercel serverless function.
 *
 * God's Eye View keeps its ~27 upstream proxies inside vite.config.js as Vite
 * dev-server middleware. They exist because the browser cannot call OpenSky,
 * CelesTrak or adsb.lol directly (CORS), so a static build of this app has no
 * live data at all. Rather than hand-port thousands of lines of caching and
 * rate-limiting logic, this mounts the real handlers: Connect middleware and
 * Node serverless functions share the (req, res) signature, so the originals
 * run here unmodified.
 *
 * The plugins are collected once per cold start by handing the config factory
 * a stand-in `server` object that records what each plugin mounts.
 */

import { Readable } from 'node:stream';
import { keySetupStatus } from '../src/keySetupCore.mjs';

/**
 * Plugins whose dev-server behaviour must not be exposed on a public URL.
 *
 * gev-key-setup writes provider credentials to disk and restarts Vite. Behind
 * localhost that is a convenience panel; on a public deployment it is an
 * unauthenticated write endpoint, so it is replaced below by a read-only
 * status route and an explicit 403 on the write path.
 *
 * vite-plugin-cesium serves /cesium/ in dev. Those assets are in dist/ and
 * come off the CDN here, so its middleware would only shadow faster routes.
 */
const EXCLUDED_PLUGINS = new Set(['gev-key-setup', 'vite-plugin-cesium-shim', 'vite-plugin-cesium']);

let bootPromise = null;

async function collectRoutes() {
  // Several cache directories are built from process.cwd() when the module is
  // evaluated (OVERPASS_DISK_DIR and friends). On Vercel the bundle directory
  // is read-only and /tmp is the one writable path, so this has to happen
  // before the config module is imported - hence the dynamic import below.
  try {
    process.chdir('/tmp');
  } catch {
    // Local `vercel dev` already has a writable cwd; nothing to fix.
  }

  const { default: configFactory } = await import('../gev-api-config.generated.mjs');
  const config = await configFactory({ mode: 'production', command: 'serve', isPreview: false });

  const routes = [];
  const recorder = {
    // Only `middlewares` is ever touched by these plugins; `httpServer` is
    // reached for with optional chaining (AIS stream teardown) and correctly
    // finds nothing to clean up in a function that exits after each request.
    httpServer: undefined,
    middlewares: {
      use(mountOrHandler, maybeHandler) {
        if (typeof mountOrHandler === 'function') routes.push({ mount: '', handler: mountOrHandler });
        else routes.push({ mount: mountOrHandler.replace(/\/$/, ''), handler: maybeHandler });
      },
    },
  };

  for (const plugin of config.plugins.flat(Infinity)) {
    if (!plugin || typeof plugin.configureServer !== 'function') continue;
    if (EXCLUDED_PLUGINS.has(plugin.name)) continue;
    await plugin.configureServer(recorder);
  }

  return routes;
}

/**
 * Connect's own mount rule, reproduced exactly: compare against the pathname,
 * and require the character after the prefix to be a boundary. Without the
 * boundary check a mount on /api/opensky would swallow /api/opensky-track,
 * which is a different handler.
 */
function matches(pathname, mount) {
  if (mount === '') return true;
  if (pathname.toLowerCase().slice(0, mount.length) !== mount.toLowerCase()) return false;
  const border = pathname.charAt(mount.length);
  return border === '' || border === '/' || border === '.';
}

/**
 * Vercel's Node runtime reads the request body and exposes it as req.body,
 * leaving the stream drained. The proxy handlers predate that and still listen
 * for 'data', so POST routes (/api/overpass above all) need the bytes put back
 * on a readable stream carrying the same IncomingMessage surface.
 */
function withReplayableBody(req) {
  if (req.body === undefined || req.body === null) return req;

  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  const stream = Readable.from([raw], { objectMode: false });
  stream.method = req.method;
  stream.headers = req.headers;
  stream.url = req.url;
  stream.httpVersion = req.httpVersion;
  stream.socket = req.socket;
  stream.connection = req.socket;
  return stream;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/**
 * The deployed replacement for gev-key-setup's status route. The client reads
 * this to decide which capabilities to light up; it must answer, but it must
 * answer from the environment only and never offer a write path.
 */
function setupStatus(res) {
  const status = keySetupStatus(process.env);
  for (const key of status.keys) {
    key.managed = key.set ? 'external' : null;
  }
  sendJson(res, 200, { ...status, store: 'environment', readOnly: true });
}

/**
 * Recover the path the caller actually asked for.
 *
 * A catch-all filename (api/[...path].js) is the obvious way to take every
 * /api/* route, but the brackets are also glob syntax in vercel.json's
 * `functions` key, where [...path] reads as a one-character class. That
 * mismatch let single-segment paths through and 404'd everything deeper, so
 * routing is an explicit rewrite instead and the original path arrives as
 * __gevPath.
 *
 * The query string is split by hand rather than through URLSearchParams: a
 * round trip there re-encodes spaces as '+' and would corrupt the
 * semicolon-and-comma packed point lists that /api/terrain/heights relies on.
 */
function originalRequestUrl(req) {
  const raw = req.url || '/';
  const split = raw.indexOf('?');
  if (split === -1) return raw;

  const query = raw.slice(split + 1);
  let routed = null;
  const passthrough = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    if (pair.startsWith('__gevPath=')) routed = decodeURIComponent(pair.slice('__gevPath='.length));
    else passthrough.push(pair);
  }
  if (routed === null) return raw;
  return passthrough.length ? `${routed}?${passthrough.join('&')}` : routed;
}

export default async function handler(req, res) {
  let routes;
  try {
    routes = await (bootPromise ??= collectRoutes());
  } catch (error) {
    bootPromise = null; // let the next request retry a transient import failure
    console.error('[api] failed to mount proxy routes:', error);
    return sendJson(res, 500, { error: 'API routes unavailable' });
  }

  const originalUrl = originalRequestUrl(req);
  const pathname = originalUrl.split('?')[0];

  // Handled here rather than by the excluded key-setup plugin.
  if (pathname === '/api/setup/status') return setupStatus(res);
  if (pathname === '/api/setup/keys') {
    return sendJson(res, 403, {
      error: 'This deployment is read-only. Provider keys are set as environment '
        + 'variables on the host; run the project locally to use the POWER UP panel.',
    });
  }

  for (const { mount, handler: mounted } of routes) {
    if (!matches(pathname, mount)) continue;

    const request = withReplayableBody(req);
    // Connect strips the mount prefix before the handler sees the URL, and the
    // handlers parse what is left (a CelesTrak group, a CCTV id) out of it.
    request.url = mount ? originalUrl.slice(mount.length) : originalUrl;
    request.originalUrl = originalUrl;

    return new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      try {
        const result = mounted(request, res, (error) => {
          if (error) {
            console.error(`[api] ${mount} failed:`, error);
            if (!res.headersSent) sendJson(res, 500, { error: 'Upstream proxy error' });
          } else if (!res.headersSent) {
            sendJson(res, 404, { error: `No handler for ${pathname}` });
          }
          resolve();
        });
        if (result && typeof result.catch === 'function') {
          result.catch((error) => {
            console.error(`[api] ${mount} threw:`, error);
            if (!res.headersSent) sendJson(res, 500, { error: 'Upstream proxy error' });
            resolve();
          });
        }
      } catch (error) {
        console.error(`[api] ${mount} threw:`, error);
        if (!res.headersSent) sendJson(res, 500, { error: 'Upstream proxy error' });
        resolve();
      }
    });
  }

  return sendJson(res, 404, { error: `No handler for ${pathname}` });
}
