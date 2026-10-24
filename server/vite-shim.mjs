/**
 * Stand-ins for the two `vite` imports that vite.config.js makes.
 *
 * The generated API config (scripts/build-api-config.mjs) imports these
 * instead of the real thing, so the serverless bundle carries the ~27 proxy
 * handlers without dragging Vite, Rollup and esbuild into a function whose
 * only job is answering /api/* requests. That keeps the function well under
 * Vercel's size ceiling and the cold start in the tens of milliseconds.
 *
 * Nothing here runs during a normal `npm run dev` — the real Vite config is
 * untouched and still the single source of truth for the handlers themselves.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Vite's defineConfig is identity at runtime; the types are the whole point. */
export const defineConfig = (config) => config;

/**
 * loadEnv merges .env files into the config factory's view of the environment.
 * On Vercel every configured value is already in process.env before the
 * function starts, so the only gap worth closing is a local .env during
 * `vercel dev`. Parsed deliberately simply: this reads the same KEY=value
 * shape the project's own .env.example documents, and nothing more exotic.
 */
export function loadEnv(_mode, envDir, _prefix = '') {
  const out = {};
  for (const name of ['.env', '.env.local']) {
    let text;
    try {
      text = fs.readFileSync(path.join(envDir, name), 'utf8');
    } catch {
      continue; // absent is the normal case on Vercel
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue; // comments and blanks
      out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return out;
}

/**
 * vite-plugin-cesium copies Cesium's static assets and rewrites the base URL at
 * build time, then serves them from /cesium/ in dev. The build half already ran
 * — those files sit in dist/ — and the serve half is the CDN's job here, so the
 * API function needs an inert placeholder rather than the real plugin.
 */
export function cesiumShim() {
  return { name: 'vite-plugin-cesium-shim' };
}
