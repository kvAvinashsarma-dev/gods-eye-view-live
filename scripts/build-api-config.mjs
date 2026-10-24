/**
 * Generate the config module the serverless API function imports.
 *
 * vite.config.js holds every /api/* proxy handler, but it imports `vite` and
 * `vite-plugin-cesium` at the top. Importing it verbatim from a Vercel
 * function would pull Vite, Rollup and esbuild into the bundle for no benefit.
 * This rewrites exactly those two import lines to point at server/vite-shim.mjs
 * and writes the result next to the original, so every other relative import
 * ('./src/data/...') still resolves unchanged.
 *
 * Mechanical derivation is the point: the handlers are never copied by hand, so
 * an upstream edit to vite.config.js flows through on the next build. If either
 * import line stops matching, this fails the build loudly rather than shipping
 * a function that silently lost its proxies.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'vite.config.js');
const TARGET = path.join(root, 'gev-api-config.generated.mjs');

const REWRITES = [
  {
    find: "import { defineConfig, loadEnv } from 'vite';",
    replace: "import { defineConfig, loadEnv } from './server/vite-shim.mjs';",
  },
  {
    find: "import cesium from 'vite-plugin-cesium';",
    replace: "import { cesiumShim as cesium } from './server/vite-shim.mjs';",
  },
];

const banner = `// GENERATED FILE - DO NOT EDIT.
// Produced from vite.config.js by scripts/build-api-config.mjs.
// Edit vite.config.js instead; this is rebuilt on every deploy.

`;

let source = await readFile(SOURCE, 'utf8');

for (const { find, replace } of REWRITES) {
  if (!source.includes(find)) {
    console.error(
      `[build-api-config] vite.config.js no longer contains the expected import:\n  ${find}\n` +
      'The API function would lose its proxy handlers. Update REWRITES in this script to match.',
    );
    process.exit(1);
  }
  source = source.replace(find, replace);
}

await writeFile(TARGET, banner + source, 'utf8');
console.log(`[build-api-config] wrote ${path.relative(root, TARGET)}`);
