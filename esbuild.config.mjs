import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle:      true,
  minify:      true,
  format:      'iife',
  globalName:  '_SpacetimeRetool',   // unused — the module self-assigns window.SpacetimeDB
  platform:    'browser',
  target:      ['es2020'],
  outfile:     'dist/spacetimedb-retool.js',
  sourcemap:   true,
})

console.log('✓ dist/spacetimedb-retool.js')
