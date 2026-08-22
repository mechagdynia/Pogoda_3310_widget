import { defineConfig } from 'vite';

/**
 * Vite config for NOKIA 3310 WEATHER RETRO.
 * - `base: './'` so the built PWA works from any static path (incl. Capacitor file://).
 * - Single, inlineable bundle to keep startup instant and total size tiny (< 5 MB).
 * - esbuild minify + drop console for a lean production artifact.
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2017',
    minify: 'esbuild',
    reportCompressedSize: true,
    assetsInlineLimit: 100_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    },
    esbuild: {
      drop: ['console']
    }
  },
  server: {
    port: 5173,
    host: true
  },
  preview: {
    port: 4173,
    host: true
  }
});
