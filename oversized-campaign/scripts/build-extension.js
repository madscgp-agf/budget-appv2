// Builds the storefront assets into the theme app extension:
//   assets/oversized-loader.js  tiny classic script, loaded with the block
//   assets/oversized-game.js    the lazy 3D game (ES module, three.js inside)
// The standalone /play page serves the very same files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'extensions', 'oversized-game', 'assets');
const watch = process.argv.includes('--watch');

// Remove chunks from earlier builds so stale files are never deployed.
for (const f of fs.readdirSync(out)) if (/^oversized-chunk-.*\.js$/.test(f)) fs.rmSync(path.join(out, f));

const common = { bundle: true, minify: !watch, sourcemap: false, target: ['es2020', 'safari15'], legalComments: 'none', logLevel: 'info' };

await build({ ...common, entryPoints: [path.join(root, 'client', 'loader.js')], outfile: path.join(out, 'oversized-loader.js'), format: 'iife' });
await build({
  ...common,
  entryPoints: { 'oversized-game': path.join(root, 'client', 'game', 'main.js') },
  outdir: out,
  // Code only some visitors need (the GLB loader) goes into its own chunk.
  splitting: true,
  chunkNames: 'oversized-chunk-[hash]',
  format: 'esm',
  loader: { '.css': 'text' },
});
